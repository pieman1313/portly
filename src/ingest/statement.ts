/**
 * IBKR Activity Statement → RawFile + RawRow[].
 *
 * This is the whole RAW layer. It is deliberately dumb: it does not know what a
 * trade is, it does not coerce numbers, it does not skip pseudo-rows. It only
 * has to get three structural things right, because everything downstream
 * depends on them and none of them can be reconstructed later:
 *
 *   1. Line numbers, for the audit trail and for RawRow.id.
 *   2. Header BINDING. A section can rebind its column map mid-file (Trades
 *      does: Stocks, then Forex, with different names at the same positions),
 *      so the header is snapshotted per row, not looked up per section.
 *   3. Both hashes, so re-import can tell "byte-identical" from "same period,
 *      regenerated later" from "genuinely new".
 *
 * It never throws on a bad row. One mangled line must not cost the user a whole
 * statement; it costs them a warning.
 */

import { PARSER_VERSION } from '../domain/types'
import type { ISODate, RawFile, RawRow, RowType } from '../domain/types'
import { parseCsv } from './csv'

export interface ParsedStatement {
  file: Omit<RawFile, 'id' | 'importedAt'> & { id: string }
  rows: RawRow[]
  warnings: string[]
}

/** The line whose presence alone must not make a regenerated statement look new. */
const WHEN_GENERATED_PREFIX = 'Statement,Data,WhenGenerated'

const ROW_TYPES: readonly RowType[] = ['Header', 'Data', 'SubTotal', 'Total', 'Notes', '']

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  let out = ''
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0')
  return out
}

export async function parseStatement(text: string, fileName: string): Promise<ParsedStatement> {
  const warnings: string[] = []
  const warnedKeys = new Set<string>()
  // Structural complaints repeat once per bad line; warn per CLASS so a
  // systematically odd section produces one line, not four hundred.
  const warn = (key: string, message: string): void => {
    if (warnedKeys.has(key)) return
    warnedKeys.add(key)
    warnings.push(message)
  }

  const sha256Raw = await sha256Hex(text)
  const sha256Canonical = await sha256Hex(canonicalise(text))
  const fileId = sha256Raw

  const parsed = parseCsv(text)
  const headers = new Map<string, string[]>()
  const sections: string[] = []
  const seenSections = new Set<string>()
  const rows: RawRow[] = []

  let broker: string | null = null
  let title: string | null = null
  let account: string | null = null
  let baseCurrency: string | null = null
  let whenGenerated: string | null = null
  let periodStart: ISODate | null = null
  let periodEnd: ISODate | null = null

  for (const { lineNo, fields } of parsed) {
    const section = fields[0] ?? ''
    const rawType = fields[1]

    if (rawType === undefined) {
      warn(
        `short|${section}`,
        `line ${lineNo}: section "${section}" row has no row-type column; kept with rowType ''`,
      )
    }

    let rowType: RowType = ''
    if (rawType !== undefined) {
      if (isRowType(rawType)) {
        rowType = rawType
      } else {
        warn(
          `rowtype|${section}|${rawType}`,
          `line ${lineNo}: unrecognised row type "${rawType}" in section "${section}"; treated as ''`,
        )
      }
    }

    let header: string[]
    if (rowType === 'Header') {
      // REBIND, never merge. The Forex Trades header reuses the Stocks column
      // positions under different names and leaves three of them empty.
      header = fields.slice(2)
      headers.set(section, header)
    } else {
      header = headers.get(section) ?? []
      // `Total P/L for Statement Period` legitimately has no header and rowType
      // '', so only payload rows are worth complaining about.
      if (header.length === 0 && (rowType === 'Data' || rowType === 'SubTotal' || rowType === 'Total')) {
        warn(
          `orphan|${section}`,
          `line ${lineNo}: section "${section}" has ${rowType} rows before any Header row; columns unbound`,
        )
      }
    }

    const row: RawRow = { id: `${fileId}:${lineNo}`, fileId, lineNo, section, rowType, fields, header }
    rows.push(row)

    if (section !== '' && !seenSections.has(section)) {
      seenSections.add(section)
      sections.push(section)
    }

    if (rowType !== 'Data') continue

    if (section === 'Statement') {
      const [key, value] = keyValue(row)
      if (key === 'BrokerName') broker = blankToNull(value)
      else if (key === 'Title') title = blankToNull(value)
      else if (key === 'WhenGenerated') whenGenerated = blankToNull(value)
      else if (key === 'Period') {
        const period = parsePeriod(value)
        if (period) {
          periodStart = period.start
          periodEnd = period.end
        } else if (value !== '') {
          warn(`period|${value}`, `line ${lineNo}: unrecognised Period "${value}"; period left unknown`)
        }
      }
    } else if (section === 'Account Information') {
      const [key, value] = keyValue(row)
      if (key === 'Account') account = blankToNull(value)
      else if (key === 'Base Currency') baseCurrency = blankToNull(value)
    }
  }

  return {
    file: {
      id: fileId,
      name: fileName,
      sha256Raw,
      sha256Canonical,
      bytes: new TextEncoder().encode(text).length,
      parserVersion: PARSER_VERSION,
      account,
      broker,
      title,
      periodStart,
      periodEnd,
      whenGenerated,
      baseCurrency,
      rowCount: rows.length,
      sections,
    },
    rows,
    warnings,
  }
}

/**
 * Zip a row's bound header against its fields, offset by 2 — the section and
 * row-type columns are not part of the header.
 *
 * Two IBKR facts drive the odd bits:
 *   - Header cells can be EMPTY (Forex Trades: full-row columns 9, 12 and 13),
 *     so they are keyed `__col{n}` by full-row index rather than dropped.
 *   - Header names can REPEAT (Trade Summary by Symbol lists Quantity /
 *     Avg. Price / Proceeds once for Buys and again for Sells), so later
 *     duplicates are suffixed instead of clobbering the first.
 * Fields past the end of the header (ragged Total rows carry one extra) are
 * kept under `__col{n}` too, so a bind is always lossless.
 */
export function bindRow(row: RawRow): Map<string, string> {
  const out = new Map<string, string>()
  const put = (name: string, value: string): void => {
    let key = name
    if (out.has(key)) {
      let n = 2
      while (out.has(`${name} (${n})`)) n++
      key = `${name} (${n})`
    }
    out.set(key, value)
  }

  for (let i = 0; i < row.header.length; i++) {
    const name = row.header[i] ?? ''
    put(name === '' ? `__col${i + 2}` : name, row.fields[i + 2] ?? '')
  }
  for (let f = row.header.length + 2; f < row.fields.length; f++) {
    put(`__col${f}`, row.fields[f] ?? '')
  }
  return out
}

/**
 * Parse the `Statement,Data,Period` value into an ISO range.
 *
 * Month names are matched explicitly. `new Date("December 11, 2024")` is
 * locale- and timezone-dependent and will silently hand back the 10th for
 * anyone west of UTC.
 */
export function parsePeriod(value: string): { start: ISODate; end: ISODate } | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  // Hyphen, en dash or em dash with spaces around it. Inner hyphens (2025-01-01,
  // 11-Dec-24) have none, so they survive the split.
  const parts = trimmed.split(/\s+[-–—]\s+/)
  const first = parseDateToken(parts[0] ?? '')
  const last = parseDateToken(parts[parts.length - 1] ?? '')
  if (!first || !last) return null
  return { start: first.start, end: last.end }
}

// ─────────────────────────────────────────────────────────────────────────────

// A Map, not an object literal: `MONTHS['constructor']` on a literal resolves up
// the prototype chain to a function, which is `!== undefined`, sails through the
// range checks in day() (every comparison against a non-number is false) and
// lands in iso() as `2024-function Object() { [native code] }-05`. A garbage
// periodStart is worse than no period at all — it is never warned about and it
// breaks every lexical ISODate comparison downstream.
const MONTHS: ReadonlyMap<string, number> = new Map<string, number>([
  ['january', 1], ['february', 2], ['march', 3], ['april', 4], ['may', 5], ['june', 6],
  ['july', 7], ['august', 8], ['september', 9], ['october', 10], ['november', 11], ['december', 12],
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['jun', 6], ['jul', 7],
  ['aug', 8], ['sep', 9], ['sept', 9], ['oct', 10], ['nov', 11], ['dec', 12],
])

/** One period endpoint, widened to the span it denotes: a year covers Jan 1..Dec 31. */
function parseDateToken(token: string): { start: ISODate; end: ISODate } | null {
  const t = token.trim()

  const year = /^(\d{4})$/.exec(t)
  if (year) {
    const y = Number(year[1])
    return { start: iso(y, 1, 1), end: iso(y, 12, 31) }
  }

  const isoDay = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  if (isoDay) return day(Number(isoDay[1]), Number(isoDay[2]), Number(isoDay[3]))

  // "December 11, 2024" — also tolerates a missing comma and an abbreviation.
  const named = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(t)
  if (named) {
    const m = MONTHS.get(named[1]!.toLowerCase())
    if (m !== undefined) return day(Number(named[3]), m, Number(named[2]))
    return null
  }

  // "December 2024" — a monthly statement configured without day granularity.
  const monthYear = /^([A-Za-z]+)\.?\s+(\d{4})$/.exec(t)
  if (monthYear) {
    const m = MONTHS.get(monthYear[1]!.toLowerCase())
    if (m === undefined) return null
    const y = Number(monthYear[2])
    return { start: iso(y, m, 1), end: iso(y, m, daysInMonth(y, m)) }
  }

  // "11-Dec-24" / "11-Dec-2024" — one of IBKR's configurable date formats.
  const dmy = /^(\d{1,2})-([A-Za-z]{3,})-(\d{2}|\d{4})$/.exec(t)
  if (dmy) {
    const m = MONTHS.get(dmy[2]!.toLowerCase())
    if (m === undefined) return null
    const raw = Number(dmy[3])
    return day(raw < 100 ? 2000 + raw : raw, m, Number(dmy[1]))
  }

  // Anything else (notably ambiguous 01/02/2025) is refused rather than guessed.
  return null
}

function day(y: number, m: number, d: number): { start: ISODate; end: ISODate } | null {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null
  const s = iso(y, m, d)
  return { start: s, end: s }
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28
  return MONTH_LENGTHS[m - 1] ?? 31
}

function iso(y: number, m: number, d: number): ISODate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Everything except the WhenGenerated line, normalised to LF. Two exports of the
 * same period an hour apart differ only there (and possibly in line endings),
 * which sha256Raw cannot see past.
 */
function canonicalise(text: string): string {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return body
    .split(/\r\n|\r|\n/)
    .filter((line) => !line.startsWith(WHEN_GENERATED_PREFIX))
    .join('\n')
}

/** `Field Name` / `Field Value` rows, by name where bound and by position where not. */
function keyValue(row: RawRow): [string, string] {
  const bound = bindRow(row)
  const key = bound.get('Field Name') ?? row.fields[2] ?? ''
  const value = bound.get('Field Value') ?? row.fields[3] ?? ''
  return [key.trim(), value.trim()]
}

function blankToNull(s: string): string | null {
  return s === '' ? null : s
}

function isRowType(s: string): s is RowType {
  return (ROW_TYPES as readonly string[]).includes(s)
}
