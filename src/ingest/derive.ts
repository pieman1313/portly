/**
 * RawRow[] → typed domain entities.
 *
 * Everything here is a pure function of one file's rows: derive the same file
 * twice and you get byte-identical ids, which is what makes re-importing an
 * overlapping statement a no-op. Nothing in this module touches the database.
 *
 * The two rules that shape the whole file:
 *   - a Header row rebinds the column map for its section, so columns are
 *     resolved by name against `row.header` (snapshotted per row), never by
 *     position and never by "the first header I saw for this section";
 *   - IBKR mixes aggregates into the data. Both the rowType channel and the
 *     first-column-label channel have to be filtered, and neither may be
 *     filtered in the four sections where those labels ARE the payload.
 */

import type {
  Accrual,
  CashEvent,
  CashKind,
  Currency,
  Distribution,
  FxRate,
  IdentitySource,
  Instrument,
  ISODate,
  ISODateTime,
  PositionSnapshot,
  RawFile,
  RawRow,
  ReconciliationCheck,
  TradeKind,
  Transaction,
} from '../domain/types'
import {
  COL,
  assetBucket,
  assignOrdinals,
  canon,
  col,
  keyString,
  makeId,
  naturalKey,
  sectionClass,
} from './dedupe'
import { bindRow } from './statement'

export interface DerivedBundle {
  instruments: Instrument[]
  /**
   * Exchange rates recovered from the statement itself, dated at the period end.
   * These are what make the app genuinely usable offline: without them a
   * multi-currency portfolio silently drops every non-base holding from its own
   * total. See `translationRate` below.
   */
  fxRates: FxRate[]
  transactions: Transaction[]
  distributions: Distribution[]
  accruals: Accrual[]
  cashEvents: CashEvent[]
  positions: PositionSnapshot[]
  reconciliation: ReconciliationCheck[]
  warnings: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Scalars
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The only numeric parser in this module. Handles the thousands separators
 * IBKR emits inside quoted cells (`"3,334.3400"`), and maps every flavour of
 * blank — `''`, `'--'`, `'-'`, `' '` — to null. `0` is never blank.
 */
export function num(v: string | null | undefined): number | null {
  if (v == null) return null
  const t = v.trim()
  if (t === '' || t === '--' || t === '-') return null
  const n = Number(t.replace(/,/g, '').replace(/%$/, ''))
  return Number.isFinite(n) ? n : null
}

const num0 = (v: string | null | undefined): number => num(v) ?? 0

const ISO_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:,?\s+(\d{2}:\d{2}:\d{2}))?/

/** `2025-07-14` and `"2025-07-14, 07:37:45"` both yield `2025-07-14`. */
export function toDate(v: string | null | undefined): ISODate | null {
  const m = ISO_PREFIX.exec((v ?? '').trim())
  return m ? (m[1] ?? null) : null
}

/**
 * ClosedLot rows carry a bare date where their siblings carry a datetime, so a
 * missing time is normal and becomes midnight rather than a parse failure.
 */
export function toDateTime(v: string | null | undefined): ISODateTime | null {
  const m = ISO_PREFIX.exec((v ?? '').trim())
  return m ? `${m[1]}T${m[2] ?? '00:00:00'}` : null
}

/**
 * Float noise control for money. Also collapses -0, which is what netting a
 * Po against its Re produces and what would otherwise render as "-0.00".
 */
function round6(n: number): number {
  const r = Math.round(n * 1e6) / 1e6
  return r === 0 ? 0 : r
}

/**
 * Given a currency block's totals and the row that follows it, decide whether
 * that row is the same block restated in base currency, and if so return the
 * rate (base units per unit of the block's currency).
 *
 * Both columns must scale by the same factor. That is what separates a genuine
 * translation from the unrelated subtotal that often sits next to it: in a real
 * statement the translation pair agrees to six decimals (1.173800 / 1.173800)
 * while its neighbours disagree in the second (1.0627 / 1.1103).
 */
function translationRate(
  block: { cost: number | null; value: number | null },
  restated: { cost: number | null; value: number | null },
): number | null {
  const ratios: number[] = []
  for (const [a, b] of [
    [block.cost, restated.cost],
    [block.value, restated.value],
  ] as const) {
    if (a === null || b === null) continue
    if (Math.abs(a) < 1e-6) continue
    ratios.push(b / a)
  }
  // One agreeing column is not evidence; a single subtotal ratio is meaningless.
  if (ratios.length < 2) return null
  const [x, y] = ratios as [number, number]
  if (!(x > 0) || !(y > 0)) return null
  if (Math.abs(x - y) / x > 0.005) return null
  const rate = (x + y) / 2
  // Sanity band. A real FX rate against any tradeable currency lives well
  // inside this; anything outside is a coincidence we should not trust.
  if (rate < 1e-4 || rate > 1e4) return null
  return rate
}

// ─────────────────────────────────────────────────────────────────────────────
// Row binding and pseudo-row detection
// ─────────────────────────────────────────────────────────────────────────────

interface BoundRow {
  row: RawRow
  section: string
  b: Map<string, string>
  /** First data column, trimmed — the label channel for aggregate rows. */
  first: string
}

const TOTAL_LABEL = /^(Total|Sub ?Total)\b/i
const BALANCE_LABEL = /(Starting|Ending) .* in [A-Z]{3}$/

/**
 * In these sections the first column is a field NAME, not a symbol or a
 * currency — `Starting Cash`, `Ending Value`, `Total` are the payload, and
 * filtering them out empties the section.
 */
const LABELS_ARE_DATA = new Set([
  'Cash Report',
  'Change in NAV',
  'Change in Combined NAV',
  'Interest Accruals',
  'Net Asset Value',
  'Statement of Funds',
])

function isAggregateLabel(section: string, first: string): boolean {
  if (LABELS_ARE_DATA.has(section)) return false
  return TOTAL_LABEL.test(first) || BALANCE_LABEL.test(first)
}

/** A real fact row: IBKR's own rowType says Data, and it is not a total in disguise. */
function isDataRow(br: BoundRow): boolean {
  return br.row.rowType === 'Data' && !isAggregateLabel(br.section, br.first)
}

/**
 * EVENT sections this module actually turns into entities. An EVENT section
 * that is present but absent from here is real activity we are dropping, so it
 * earns a warning. `Statement of Funds` is excluded deliberately: it restates
 * rows we already read from their own sections, and deriving it would
 * double-count every cash line in the file.
 */
const DERIVED_EVENT_SECTIONS = new Set([
  'Trades',
  'Dividends',
  'Payment In Lieu Of Dividends',
  'Withholding Tax',
  'Change in Dividend Accruals',
  'Statement of Funds',
  'Deposits & Withdrawals',
  'Deposits/Withdrawals',
  'Deposits',
  'Interest',
  'Broker Interest Paid',
  'Broker Interest Received',
  'Bond Interest Paid',
  'Bond Interest Received',
  'Fees',
  'Other Fees',
  'Advisor Fees',
  'Transaction Fees',
  'Commission Adjustments',
  'Price Adjustments',
  'Option Cash Settlements',
])

/** Sections we knowingly do not derive from. Anything else unknown gets a warning. */
const KNOWN_IGNORED = new Set([
  'Statement',
  'Account Information',
  'Notes/Legal Notes',
  'Notes',
  'Legal Notes',
  'Disclaimer',
  'Codes',
])

// ─────────────────────────────────────────────────────────────────────────────
// Instrument identity
// ─────────────────────────────────────────────────────────────────────────────

interface Draft {
  key: string
  identitySource: IdentitySource
  conid: string | null
  isin: string | null
  symbol: string
  aliases: Set<string>
  name: string
  assetCategory: string
  type: string | null
  listingExchange: string | null
  multiplier: number
  tradeCurrency: Currency | null
  divCurrency: Currency | null
  firstSeen: ISODate | null
  lastSeen: ISODate | null
}

const DERIVATIVE = /option|future|warrant|cfd/i

/** `VDIVd` → `VDIV`: IBKR appends a lowercase venue letter on non-US listings. */
function symbolVariants(symbol: string): string[] {
  const out = [symbol, symbol.toUpperCase()]
  const stripped = symbol.replace(/[a-z]+$/, '')
  if (stripped.length >= 2 && stripped !== symbol) out.push(stripped)
  return out
}

/**
 * The alias index is why `TDIV` and `VDIVd` are one instrument. Financial
 * Instrument Information reports the Symbol cell as a comma-separated alias
 * list against a single conid, and every other section picks whichever alias it
 * feels like — sometimes both, in the same section, in the same file.
 */
function createRegistry() {
  const drafts: Draft[] = []
  const byKey = new Map<string, Draft>()
  const byAlias = new Map<string, Draft>()
  const byIsin = new Map<string, Draft>()

  const index = (d: Draft): void => {
    byKey.set(d.key, d)
    for (const a of d.aliases) {
      if (!byAlias.has(a)) byAlias.set(a, d)
      const up = a.toUpperCase()
      if (!byAlias.has(up)) byAlias.set(up, d)
    }
    if (d.isin && !byIsin.has(d.isin)) byIsin.set(d.isin, d)
  }

  const lookup = (symbol: string, isin: string | null): Draft | null => {
    // ISIN beats ticker: a ticker can be reused across venues, an ISIN cannot.
    if (isin) {
      const hit = byIsin.get(isin)
      if (hit) return hit
    }
    for (const v of symbolVariants(symbol)) {
      const hit = byAlias.get(v)
      // A ticker match is only good enough while it does not CONTRADICT a known
      // ISIN. `ACME` on NASDAQ and `ACME` in London are two securities, and
      // merging them would pool two portfolios' worth of shares under one key.
      if (hit && isin && hit.isin && hit.isin !== isin) continue
      if (hit) return hit
    }
    return null
  }

  const touch = (
    d: Draft,
    o: { date?: string | null; alias?: string; tradeCurrency?: string; divCurrency?: string },
  ): void => {
    if (o.date) {
      if (!d.firstSeen || o.date < d.firstSeen) d.firstSeen = o.date
      if (!d.lastSeen || o.date > d.lastSeen) d.lastSeen = o.date
    }
    if (o.alias && !d.aliases.has(o.alias)) {
      d.aliases.add(o.alias)
      if (!byAlias.has(o.alias)) byAlias.set(o.alias, d)
    }
    // First writer wins for both: Open Positions is walked before Trades, and
    // the Dividends section before Change in Dividend Accruals.
    if (o.tradeCurrency && !d.tradeCurrency) d.tradeCurrency = o.tradeCurrency
    if (o.divCurrency && !d.divCurrency) d.divCurrency = o.divCurrency
  }

  const create = (o: {
    aliases: string[]
    conid: string | null
    isin: string | null
    name: string
    assetCategory: string
    type: string | null
    exchange: string | null
    multiplier: number
  }): Draft => {
    const symbol = o.aliases[0] ?? ''
    // Strict preference order. The bare ticker is the last resort because
    // tickers get renamed and collide across venues.
    const [key, identitySource]: [string, IdentitySource] = o.conid
      ? [o.conid, 'conid']
      : o.isin
        ? [o.isin, 'isin']
        : o.exchange
          ? [`${symbol}|${o.exchange}`, 'symbol+exchange']
          : [symbol, 'symbol']
    const existing = byKey.get(key)
    if (existing) {
      for (const a of o.aliases) touch(existing, { alias: a })
      return existing
    }
    const d: Draft = {
      key,
      identitySource,
      conid: o.conid,
      isin: o.isin,
      symbol,
      aliases: new Set(o.aliases),
      name: o.name,
      assetCategory: o.assetCategory,
      type: o.type,
      listingExchange: o.exchange,
      multiplier: o.multiplier,
      tradeCurrency: null,
      divCurrency: null,
      firstSeen: null,
      lastSeen: null,
    }
    drafts.push(d)
    index(d)
    return d
  }

  /** Resolve, or mint a symbol-only stub for an instrument with no FII row. */
  const ensure = (o: { symbol: string; isin?: string | null; assetCategory?: string }): Draft => {
    const hit = lookup(o.symbol, o.isin ?? null)
    if (hit) {
      touch(hit, { alias: o.symbol })
      if (o.isin && !hit.isin) {
        hit.isin = o.isin
        if (!byIsin.has(o.isin)) byIsin.set(o.isin, hit)
      }
      return hit
    }
    return create({
      aliases: [o.symbol],
      conid: null,
      isin: o.isin ?? null,
      name: '',
      assetCategory: o.assetCategory ?? '',
      type: null,
      exchange: null,
      multiplier: 1,
    })
  }

  return { drafts, lookup, ensure, create, touch }
}

// ─────────────────────────────────────────────────────────────────────────────
// Descriptions
// ─────────────────────────────────────────────────────────────────────────────

/** `TDIV(NL0011683594) Cash Dividend EUR 0.36 per Share (Ordinary Dividend)` */
const DESC_ID = /^([^(]+)\(([A-Z0-9]{9,12})\)\s*(.*)$/
const PER_SHARE = /\b[A-Z]{3}\s+([\d,]+(?:\.\d+)?)\s+per\s+share\b/i
const TRAILING_PAREN = /\(([^()]*)\)\s*$/

interface ParsedDescription {
  symbol: string | null
  isin: string | null
  perShare: number | null
  divType: string | null
}

/**
 * The description is a second identity channel — Dividends and Withholding Tax
 * carry no Symbol column at all, only `SYM(ISIN) …`. Take the symbol as
 * everything before the first `(` so dotted and suffixed tickers survive.
 * Everything here is best-effort: plenty of descriptions do not match.
 */
export function parseDescription(desc: string): ParsedDescription {
  const m = DESC_ID.exec(desc.trim())
  const symbol = m ? (m[1] ?? '').trim() || null : null
  const isin = m ? (m[2] ?? null) : null
  const rest = m ? (m[3] ?? '') : desc
  const ps = PER_SHARE.exec(rest)
  const type = TRAILING_PAREN.exec(rest)
  return {
    symbol,
    isin,
    perShare: ps ? num(ps[1]) : null,
    divType: type ? ((type[1] ?? '').trim() || null) : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending entities (id assignment is deferred until ordinals are known)
// ─────────────────────────────────────────────────────────────────────────────

interface Pending<T> {
  parts: string[]
  make: (id: string) => T
}

function finalize<T>(pending: Pending<T>[]): T[] {
  const ords = assignOrdinals(pending, (p) => keyString(p.parts))
  return pending.map((p, i) => p.make(makeId(p.parts, ords[i] ?? 0)))
}

const pushTo = <K, V>(m: Map<K, V[]>, k: K, v: V): void => {
  const a = m.get(k)
  if (a) a.push(v)
  else m.set(k, [v])
}

const addTo = (m: Map<string, number>, k: string, v: number): void => {
  m.set(k, (m.get(k) ?? 0) + v)
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation plumbing
// ─────────────────────────────────────────────────────────────────────────────

/** 2 cents absolute, or 0.1% relative — whichever is kinder to rounding. */
function checkOf(label: string, ours: number, theirs: number, currency: Currency): ReconciliationCheck {
  const diff = Math.abs(ours - theirs)
  const ok = diff <= 0.02 || (theirs !== 0 && diff / Math.abs(theirs) <= 0.001)
  return { label, ours: round6(ours), theirs: round6(theirs), currency, ok }
}

interface SectionTotals {
  /** Bare `Total` rows, attributed to the currency of the block they close. */
  byCcy: Map<string, number>
  /** Last `Total … in <BASE>` row — the section's grand total, already translated. */
  baseGrand: number | null
  /** `Starting/Ending … in <CCY>` rows, by their full label. */
  labelled: Map<string, number>
  /** True when every data row in the section is already in the base currency. */
  allBase: boolean
}

/**
 * IBKR stacks several kinds of total in one section with nothing in the row to
 * tell them apart: a per-currency subtotal, that same subtotal translated to
 * base, then the grand total. Position matters — a bare `Total` closes the
 * block of data rows immediately above it; anything ending in `in <CCY>` is a
 * translation and is only trustworthy as the section grand total.
 */
function sectionTotals(
  secRows: readonly BoundRow[],
  amountCols: readonly (string | RegExp)[],
  base: Currency | null,
): SectionTotals {
  const byCcy = new Map<string, number>()
  const labelled = new Map<string, number>()
  let baseGrand: number | null = null
  let blockCcy = ''
  let blockRows = 0
  let allBase = true

  for (const br of secRows) {
    if (br.row.rowType === 'Header') continue
    const amount = num(col(br.b, amountCols))
    const isTotal = br.row.rowType === 'Total' || br.row.rowType === 'SubTotal' || TOTAL_LABEL.test(br.first)

    if (isTotal) {
      const translated = /\bin ([A-Z]{3})$/.exec(br.first)
      if (translated) {
        if (translated[1] === base && amount !== null) baseGrand = amount
      } else if (blockRows > 0 && amount !== null) {
        addTo(byCcy, blockCcy, amount)
        blockRows = 0
      }
      continue
    }
    if (BALANCE_LABEL.test(br.first)) {
      if (amount !== null) labelled.set(br.first, amount)
      continue
    }
    if (br.row.rowType !== 'Data') continue

    blockCcy = col(br.b, COL.currency).trim()
    blockRows++
    if (base && blockCcy && blockCcy !== base) allBase = false
  }
  return { byCcy, baseGrand, labelled, allBase }
}

// ─────────────────────────────────────────────────────────────────────────────
// derive
// ─────────────────────────────────────────────────────────────────────────────

/** Sections that are nothing but signed cash lines. */
const CASH_SECTIONS: ReadonlyArray<readonly [string, (amount: number) => CashKind]> = [
  ['Deposits & Withdrawals', (a) => (a >= 0 ? 'DEPOSIT' : 'WITHDRAWAL')],
  ['Deposits/Withdrawals', (a) => (a >= 0 ? 'DEPOSIT' : 'WITHDRAWAL')],
  ['Deposits', (a) => (a >= 0 ? 'DEPOSIT' : 'WITHDRAWAL')],
  ['Interest', () => 'INTEREST'],
  ['Broker Interest Paid', () => 'INTEREST'],
  ['Broker Interest Received', () => 'INTEREST'],
  ['Bond Interest Paid', () => 'INTEREST'],
  ['Bond Interest Received', () => 'INTEREST'],
  ['Fees', () => 'FEE'],
  ['Other Fees', () => 'FEE'],
  ['Advisor Fees', () => 'FEE'],
  ['Transaction Fees', () => 'FEE'],
  ['Commission Adjustments', () => 'FEE'],
  ['Price Adjustments', () => 'OTHER'],
  ['Option Cash Settlements', () => 'OTHER'],
]

export function derive(file: RawFile, rows: readonly RawRow[]): DerivedBundle {
  const warnings: string[] = []
  const base = file.baseCurrency ?? null
  const account = file.account ?? ''
  const asOf = file.periodEnd ?? ''

  // `fields` still carries the section and row-type columns, so the first data
  // column — the one that carries the aggregate labels — is index 2.
  const bound: BoundRow[] = rows.map((row) => ({
    row,
    section: row.section,
    b: bindRow(row),
    first: (row.fields[2] ?? '').trim(),
  }))

  const bySection = new Map<string, BoundRow[]>()
  for (const br of bound) pushTo(bySection, br.section, br)

  for (const section of bySection.keys()) {
    if (section === '') continue
    if (sectionClass(section) === 'IGNORE' && !KNOWN_IGNORED.has(section)) {
      warnings.push(`Unrecognised section "${section}" — kept raw, not derived`)
    } else if (sectionClass(section) === 'EVENT' && !DERIVED_EVENT_SECTIONS.has(section)) {
      // Silently dropping a share transfer or a corporate action leaves a
      // position in the snapshot with no acquisition behind it, which reads as
      // a cost-basis bug rather than as missing coverage. Say so.
      warnings.push(`Section "${section}" is not derived yet — its rows are kept raw but not in the ledger`)
    }
  }

  const reg = createRegistry()

  // ── Pass 0: symbol → ISIN, harvested from descriptions ─────────────────────
  // Dividends and Withholding Tax have no Symbol column; they carry `SYM(ISIN)`
  // in the description. Collecting that BEFORE any instrument is minted is what
  // makes identity independent of which section mentions a security first: a
  // file with no Financial Instrument Information section would otherwise key
  // the same security on its bare ticker (trade seen first) or on its ISIN
  // (dividend seen first), and the two would never merge across imports.
  const isinBySymbol = new Map<string, string>()
  for (const section of ['Dividends', 'Payment In Lieu Of Dividends', 'Withholding Tax']) {
    for (const br of bySection.get(section) ?? []) {
      if (!isDataRow(br)) continue
      const p = parseDescription(col(br.b, COL.description))
      if (p.symbol && p.isin && !isinBySymbol.has(p.symbol)) isinBySymbol.set(p.symbol, p.isin)
    }
  }
  const isinFor = (symbol: string): string | null => isinBySymbol.get(symbol) ?? null

  // ── Pass 1: instrument reference data ──────────────────────────────────────
  // Must run before anything else even though the section sits at the END of
  // the file: resolving a trade before the alias list is known would mint a
  // symbol-keyed stub and then a second, conid-keyed instrument for the same
  // security.
  for (const br of bySection.get('Financial Instrument Information') ?? []) {
    if (!isDataRow(br)) continue
    const aliases = col(br.b, COL.symbol)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (aliases.length === 0) continue
    const assetCategory = col(br.b, COL.assetCategory).trim()
    const underlying = col(br.b, COL.underlying).trim()
    // For a derivative this column is the actual underlying instrument, which is
    // a different security — never fold that in. For a cash equity it is the
    // instrument's own root ticker, and it goes FIRST, because aliases[0]
    // becomes the displayed symbol.
    //
    // Two reasons to prefer it over the Symbol cell's own ordering. It is
    // deterministic: the Symbol cell is a comma-separated alias list whose order
    // is IBKR's business and can differ between exports, so keying display off
    // it makes a holding rename itself for no reason. And it is the broker's own
    // canonical pointer — for the renamed fund in a real statement the Symbol
    // cell reads "VDIVd, TDIV" while Underlying says TDIV, which is also what
    // the market, the price feed and the account holder call it.
    //
    // Either way the user can pick a different alias on the Holdings tab; this
    // only decides the default.
    if (underlying && !DERIVATIVE.test(assetCategory)) {
      const rest = aliases.filter((a) => a !== underlying)
      aliases.length = 0
      aliases.push(underlying, ...rest)
    }
    // No touch() here: firstSeen/lastSeen mean "seen in an event or a position",
    // and every instrument appears in this section whether it traded or not.
    reg.create({
      aliases,
      conid: col(br.b, COL.conid).trim() || null,
      isin: col(br.b, COL.securityId).trim() || null,
      name: col(br.b, COL.description).trim(),
      assetCategory,
      type: col(br.b, COL.type).trim() || null,
      exchange: col(br.b, COL.listingExch).trim() || null,
      multiplier: num(col(br.b, COL.multiplier)) ?? 1,
    })
  }

  const positions: PositionSnapshot[] = []
  const reconciliation: ReconciliationCheck[] = []
  const fxRates: FxRate[] = []

  // ── Open Positions ─────────────────────────────────────────────────────────
  // Walked in file order so the block totals can be reconciled inline: a bare
  // Total closes the block above it, and the extra Totals that follow (the same
  // block translated to base, then the grand total) must not be summed.
  {
    let blockCcy = ''
    let blockRows = 0
    let blockValue = 0
    let blockCost = 0
    let stockValue = 0
    let stockRows = 0
    let allBase = true
    // The Total row most recently closed, kept so the row after it can be
    // tested for being that same block restated in base currency.
    let lastBlock: { ccy: string; cost: number | null; value: number | null } | null = null

    for (const br of bySection.get('Open Positions') ?? []) {
      if (br.row.rowType === 'Header') continue

      if (br.row.rowType === 'Total' || br.row.rowType === 'SubTotal' || isAggregateLabel(br.section, br.first)) {
        // A Total row states the currency of the block it closes. The extra
        // Totals around it restate that block — and then the whole section — in
        // base currency, and comparing one of those against a block it does not
        // describe reports a bug we do not have. Order is not reliable; the
        // Currency column is.
        const totalCcy = col(br.b, COL.currency).trim()
        const totValue = num(col(br.b, COL.value))
        const totCost = num(col(br.b, COL.costBasis))

        // IBKR follows a non-base currency block's Total with the SAME figures
        // restated in base currency. Nothing in the row says so — the research
        // notes flag this as a triple-counting trap — but it is also the only
        // place the statement states its own exchange rate, so it is worth
        // recovering rather than merely skipping.
        //
        // The tell is that BOTH columns scale by the same factor. An unrelated
        // subtotal that happens to sit next in the file does not: in a real
        // statement the genuine pair agrees to six decimal places (1.173800)
        // while the neighbouring pairs disagree in the second (1.0627 vs 1.1103).
        if (lastBlock && totalCcy === base && lastBlock.ccy !== base) {
          const r = translationRate(lastBlock, { cost: totCost, value: totValue })
          if (r !== null && asOf !== '') {
            fxRates.push({
              id: `${base}|${lastBlock.ccy}|${asOf}`,
              base,
              quote: lastBlock.ccy,
              date: asOf,
              // Stored base->quote to match the provider convention: how many
              // units of `quote` one unit of `base` buys.
              rate: 1 / r,
            })
          }
        }
        lastBlock = blockRows > 0 ? { ccy: blockCcy, cost: totCost, value: totValue } : null

        if (blockRows > 0 && (totalCcy === '' || totalCcy === blockCcy)) {
          const theirValue = totValue
          const theirCost = totCost
          if (theirValue !== null) {
            reconciliation.push(checkOf(`Open Positions value (${blockCcy})`, blockValue, theirValue, blockCcy))
          }
          if (theirCost !== null) {
            reconciliation.push(checkOf(`Open Positions cost basis (${blockCcy})`, blockCost, theirCost, blockCcy))
          }
          blockRows = 0
          blockValue = 0
          blockCost = 0
        }
        continue
      }
      if (!isDataRow(br)) continue

      const disc = col(br.b, COL.discriminator).trim()
      if (disc === 'Lot') continue // tax-lot detail; the Summary row is the position
      const symbol = col(br.b, COL.symbol).trim()
      if (symbol === '') continue

      const currency = col(br.b, COL.currency).trim()
      const assetCategory = col(br.b, COL.assetCategory).trim()
      const d = reg.ensure({ symbol, isin: isinFor(symbol), assetCategory })
      if (d.conid === null && d.isin === null) {
        warnings.push(`No instrument reference for "${symbol}" — identity is symbol-only`)
      }
      reg.touch(d, { date: asOf, alias: symbol, tradeCurrency: currency })
      if (d.assetCategory === '') d.assetCategory = assetCategory

      const value = num0(col(br.b, COL.value))
      const costBasis = num0(col(br.b, COL.costBasis))
      positions.push({
        id: `${account}|${asOf}|${d.key}`,
        fileId: file.id,
        account,
        asOf,
        instrumentKey: d.key,
        currency,
        quantity: num0(col(br.b, COL.quantity)),
        costPrice: num0(col(br.b, COL.costPrice)),
        costBasis,
        closePrice: num0(col(br.b, COL.closePrice)),
        value,
        unrealizedPnl: num0(col(br.b, COL.unrealized)),
      })
      blockCcy = currency
      blockRows++
      blockValue += value
      blockCost += costBasis
      // The NAV `Stock` line covers stocks and ETFs only; bonds, options and
      // funds each get their own NAV line. Summing the whole book against it
      // reports a mismatch for every account that holds anything else.
      if (/^stocks?$/i.test(assetBucket(assetCategory))) {
        stockValue += value
        stockRows++
      }
      if (base && currency && currency !== base) allBase = false
    }

    // Net Asset Value states the whole stock book in base currency. Only
    // comparable when nothing needs an FX rate we do not have offline.
    const navStock = (bySection.get('Net Asset Value') ?? []).find(
      (br) => br.row.rowType === 'Data' && /^stocks?$/i.test(br.first),
    )
    const theirNav = navStock ? num(col(navStock.b, ['Current Total', 'Current Long'])) : null
    if (theirNav !== null && allBase && base && stockRows > 0) {
      reconciliation.push(checkOf('Net Asset Value — Stock', stockValue, theirNav, base))
    }

    // Position snapshots are replaced by (account, asOf); without both, two
    // imports would overwrite each other's holdings.
    if (positions.length > 0 && (account === '' || asOf === '')) {
      warnings.push('Statement has no account id or no period end — position snapshots cannot be keyed safely')
    }
  }

  // ── Trades ─────────────────────────────────────────────────────────────────
  const tradeRows = bySection.get('Trades') ?? []
  // Resolving through the harvested ISIN as well as the alias index keeps the
  // key a trade is hashed under identical to the key its instrument ends up
  // with, including for the very first row of a security we have not minted yet.
  const resolveKey = (symbol: string): string =>
    reg.lookup(symbol, isinFor(symbol))?.key ?? isinFor(symbol) ?? symbol

  // Order rows aggregate the Trade rows beneath them. Ingesting both books the
  // same fill twice; the default statement always emits Order. The flag is per
  // instrument BLOCK, not per section: the Trades section rebinds its header
  // mid-file and a block reported at Trade grain (Forex, typically) sitting
  // next to one reported at Order grain must not lose every one of its rows.
  const grainKey = (br: BoundRow): string =>
    [
      assetBucket(col(br.b, COL.assetCategory)),
      col(br.b, COL.currency).trim(),
      col(br.b, COL.symbol).trim(),
    ].join('')
  const orderGrain = new Set<string>()
  for (const br of tradeRows) {
    if (isDataRow(br) && col(br.b, COL.discriminator).trim() === 'Order') orderGrain.add(grainKey(br))
  }

  const pendingTx: Pending<Transaction>[] = []
  const pendingCash: Pending<CashEvent>[] = []
  const cashSection: string[] = [] // parallel to pendingCash, for reconciliation
  let closedLots = 0
  const oursTradeGroup = new Map<string, { qty: number; proceeds: number; comm: number; realized: number }>()
  const theirsTradeGroup = new Map<string, { qty: number; proceeds: number; comm: number; realized: number }>()
  const tradeGroupLabel = new Map<string, string>()

  const bumpTrade = (
    m: Map<string, { qty: number; proceeds: number; comm: number; realized: number }>,
    k: string,
    v: { qty: number; proceeds: number; comm: number; realized: number },
  ): void => {
    const cur = m.get(k) ?? { qty: 0, proceeds: 0, comm: 0, realized: 0 }
    m.set(k, {
      qty: cur.qty + v.qty,
      proceeds: cur.proceeds + v.proceeds,
      comm: cur.comm + v.comm,
      realized: cur.realized + v.realized,
    })
  }

  for (const br of tradeRows) {
    const assetCategory = col(br.b, COL.assetCategory).trim()
    const bucket = assetCategory.split(' - Held with')[0]?.trim() ?? ''
    const currency = col(br.b, COL.currency).trim()
    const symbol = col(br.b, COL.symbol).trim()
    const isForex = /^forex$/i.test(bucket)

    // SubTotal rows are IBKR's own per-(currency, symbol) arithmetic — the
    // cleanest thing in the file to reconcile against, and unlike the Total
    // rows they are never restated into base currency.
    if (br.row.rowType === 'SubTotal' && !isForex && symbol !== '') {
      const d = reg.lookup(symbol, null)
      const k = `${bucket}|${currency}|${d?.key ?? symbol}`
      tradeGroupLabel.set(k, `${d?.symbol ?? symbol} (${bucket}/${currency})`)
      bumpTrade(theirsTradeGroup, k, {
        qty: num0(col(br.b, COL.quantity)),
        proceeds: num0(col(br.b, COL.proceeds)),
        comm: Math.abs(num0(col(br.b, COL.commission))),
        realized: num0(col(br.b, COL.realized)),
      })
      continue
    }
    if (!isDataRow(br)) continue

    const disc = col(br.b, COL.discriminator).trim()
    if (disc === 'ClosedLot') {
      // Positive quantity against the negative sale it closes. Booking it would
      // net the ledger to zero shares; it belongs in a tax-lot table.
      closedLots++
      continue
    }
    if (disc !== 'Order' && orderGrain.has(grainKey(br))) continue

    const dateTime = toDateTime(col(br.b, COL.dateTime))
    if (dateTime === null) {
      warnings.push(`Trades row ${br.row.lineNo}: unparseable Date/Time "${col(br.b, COL.dateTime)}"`)
      continue
    }
    const date = dateTime.slice(0, 10)
    const parts = naturalKey('Trades', br.b, resolveKey) ?? []
    const quantity = num0(col(br.b, COL.quantity))
    const price = num0(col(br.b, COL.price))
    const proceeds = num0(col(br.b, COL.proceeds))
    const fees = Math.abs(num0(col(br.b, COL.commission)))

    if (isForex) {
      // A currency conversion is not a holding. Book the cash legs and move on.
      const desc = `${symbol} ${quantity} @ ${price}`
      pendingCash.push({
        parts: [...parts, 'fx'],
        make: (id) => ({
          id,
          fileIds: [file.id],
          sourceRowIds: [br.row.id],
          kind: 'FX',
          date,
          amount: proceeds,
          currency,
          description: desc,
          supersededAt: null,
        }),
      })
      cashSection.push('Trades')
      if (fees !== 0) {
        pendingCash.push({
          parts: [...parts, 'fxfee'],
          make: (id) => ({
            id,
            fileIds: [file.id],
            sourceRowIds: [br.row.id],
            kind: 'FEE',
            date,
            amount: -fees,
            currency,
            description: `Commission on ${desc}`,
            supersededAt: null,
          }),
        })
        cashSection.push('Trades')
      }
      continue
    }

    if (symbol === '') {
      warnings.push(`Trades row ${br.row.lineNo}: no symbol, skipped`)
      continue
    }
    const d = reg.ensure({ symbol, isin: isinFor(symbol), assetCategory })
    reg.touch(d, { date, alias: symbol, tradeCurrency: currency })
    if (d.assetCategory === '') d.assetCategory = assetCategory

    const kind: TradeKind = quantity >= 0 ? 'BUY' : 'SELL'
    const realizedPnl = num0(col(br.b, COL.realized))
    pendingTx.push({
      parts,
      make: (id) => ({
        id,
        fileIds: [file.id],
        sourceRowIds: [br.row.id],
        instrumentKey: d.key,
        kind,
        dateTime,
        date,
        quantity,
        price,
        currency,
        proceeds,
        fees, // IBKR signs commissions negative; we store a positive cost
        basis: num0(col(br.b, COL.basis)),
        realizedPnl,
        codes: col(br.b, COL.code)
          .split(';')
          .map((c) => c.trim())
          .filter(Boolean),
        supersededAt: null,
      }),
    })
    const gk = `${bucket}|${currency}|${d.key}`
    tradeGroupLabel.set(gk, `${d.symbol} (${bucket}/${currency})`)
    bumpTrade(oursTradeGroup, gk, { qty: quantity, proceeds, comm: fees, realized: realizedPnl })
  }

  if (closedLots > 0) {
    warnings.push(`${closedLots} ClosedLot row(s) excluded from the ledger (tax-lot detail)`)
  }

  // ── Dividends and their withholding ────────────────────────────────────────
  interface CashLike {
    br: BoundRow
    currency: string
    date: ISODate
    description: string
    amount: number
    parsed: ParsedDescription
    instrument: Draft | null
    matchKey: string
  }

  const readCashLike = (br: BoundRow, section: string): CashLike | null => {
    const date = toDate(col(br.b, COL.date))
    if (date === null) {
      warnings.push(`${section} row ${br.row.lineNo}: unparseable date`)
      return null
    }
    const currency = col(br.b, COL.currency).trim()
    const description = col(br.b, COL.description)
    // Dividends and Withholding Tax have no Symbol column at all — the ticker
    // and the ISIN live in the description.
    const parsed = parseDescription(description)
    const symbol = col(br.b, COL.symbol).trim() || parsed.symbol
    let instrument: Draft | null = null
    if (symbol) {
      instrument = reg.ensure({
        symbol,
        isin: parsed.isin ?? isinFor(symbol),
        assetCategory: col(br.b, COL.assetCategory).trim(),
      })
      reg.touch(instrument, { date, alias: symbol })
    } else if (parsed.isin) {
      instrument = reg.lookup('', parsed.isin)
    }
    return {
      br,
      currency,
      date,
      description,
      amount: num0(col(br.b, COL.amount)),
      parsed,
      instrument,
      // Withholding is matched to its dividend on instrument + pay date +
      // currency; the per-share rate breaks ties when both carry one.
      matchKey: `${instrument?.key ?? symbol ?? ''}|${date}|${currency}`,
    }
  }

  const divRows: CashLike[] = []
  for (const section of ['Dividends', 'Payment In Lieu Of Dividends']) {
    for (const br of bySection.get(section) ?? []) {
      if (!isDataRow(br)) continue
      const c = readCashLike(br, section)
      if (!c) continue
      divRows.push(c)
      // Dividends are not always paid in the currency the instrument trades in
      // — IUKD trades EUR on Borsa Italiana and pays GBP.
      if (c.instrument) reg.touch(c.instrument, { divCurrency: c.currency })
    }
  }

  const whtRows: CashLike[] = []
  for (const br of bySection.get('Withholding Tax') ?? []) {
    if (!isDataRow(br)) continue
    const c = readCashLike(br, 'Withholding Tax')
    if (c) whtRows.push(c)
  }

  const whtByKey = new Map<string, CashLike[]>()
  for (const w of whtRows) pushTo(whtByKey, w.matchKey, w)
  const divByKey = new Map<string, CashLike[]>()
  for (const d of divRows) pushTo(divByKey, d.matchKey, d)

  const taxFor = new Map<CashLike, { amount: number; rows: CashLike[] }>()
  const matchedWht = new Set<CashLike>()
  for (const [key, divs] of divByKey) {
    const whts = whtByKey.get(key) ?? []
    if (whts.length === 0) continue
    if (divs.length === 1) {
      // One payment, any number of withholding lines (tax plus a later
      // correction) — they all belong to it.
      const only = divs[0] as CashLike
      taxFor.set(only, { amount: whts.reduce((s, w) => s + w.amount, 0), rows: whts })
      for (const w of whts) matchedWht.add(w)
      continue
    }
    // Several payments on one instrument on one day: pair by per-share rate
    // FIRST, across all of them, and only then hand out what is left
    // positionally. Interleaving the two passes lets the earlier payment take a
    // withholding line that names the later payment's rate, which silently
    // moves tax from one distribution to another.
    const pool = [...whts]
    const unpaired: CashLike[] = []
    for (const dv of divs) {
      const idx =
        dv.parsed.perShare !== null
          ? pool.findIndex((w) => w.parsed.perShare === dv.parsed.perShare)
          : -1
      if (idx < 0) {
        unpaired.push(dv)
        continue
      }
      const w = pool.splice(idx, 1)[0] as CashLike
      taxFor.set(dv, { amount: w.amount, rows: [w] })
      matchedWht.add(w)
    }
    for (const dv of unpaired) {
      const w = pool.shift()
      if (!w) break
      taxFor.set(dv, { amount: w.amount, rows: [w] })
      matchedWht.add(w)
    }
  }

  // ── Accruals ───────────────────────────────────────────────────────────────
  interface AccrRow {
    br: BoundRow
    instrumentKey: string
    currency: string
    exDate: ISODate
    payDate: ISODate
    grossRate: string
    quantity: number
    tax: number
    gross: number
    net: number
    codes: string
  }
  const accrGroups = new Map<string, AccrRow[]>()

  for (const br of bySection.get('Change in Dividend Accruals') ?? []) {
    if (!isDataRow(br)) continue
    const symbol = col(br.b, COL.symbol).trim()
    if (symbol === '') continue
    const exDate = toDate(col(br.b, COL.exDate)) ?? ''
    const payDate = toDate(col(br.b, COL.payDate)) ?? ''
    const currency = col(br.b, COL.currency).trim()
    const d = reg.ensure({ symbol, isin: isinFor(symbol), assetCategory: col(br.b, COL.assetCategory).trim() })
    reg.touch(d, { date: toDate(col(br.b, COL.date)), alias: symbol, divCurrency: currency })
    const grossRate = canon(col(br.b, COL.grossRate))
    const row: AccrRow = {
      br,
      instrumentKey: d.key,
      currency,
      exDate,
      payDate,
      grossRate,
      quantity: num0(col(br.b, COL.quantity)),
      tax: num0(col(br.b, COL.tax)),
      gross: num0(col(br.b, COL.grossAmount)),
      net: num0(col(br.b, COL.netAmount)),
      codes: col(br.b, COL.code).trim(),
    }
    // Po and Re net out; the group key deliberately excludes Date, tax and
    // gross amount so a restated pair still cancels.
    pushTo(accrGroups, [d.key, exDate, payDate, grossRate, currency].join('|'), row)
  }

  const accruals: Accrual[] = []
  for (const group of accrGroups.values()) {
    const first = group[0] as AccrRow
    const posted = group.find((r) => /\bPo\b/.test(r.codes)) ?? first
    const gross = group.reduce((s, r) => s + r.gross, 0)
    const tax = group.reduce((s, r) => s + r.tax, 0)
    const net = group.reduce((s, r) => s + r.net, 0)
    // `open` is an ACCOUNTING fact: does this group still carry a balance?
    // Nothing more. The threshold only discards float noise.
    //
    // Two things it deliberately does NOT do:
    //
    // 1. It does not require payDate >= period end. A dividend whose pay date
    //    has just passed but that had not settled by the statement date is
    //    still accrued, and IBKR counts it in Ending Dividend Accruals.
    //
    // 2. It does not discard small residuals left by restated Po/Re pairs.
    //    Tempting, but wrong: in a real statement the USD accrual total is
    //    275.96 while the two genuine accruals sum to 275.95 — the missing
    //    0.01 is exactly such a residual, so IBKR counts those too. Dropping
    //    them would put us a cent away from the broker on every statement and
    //    make the reconciliation check meaningless.
    //
    // Whether an open accrual is "in transit", "upcoming" or stale noise is a
    // presentation question, answered against today's date. forecast.ts already
    // excludes anything paying before the current month.
    const open = Math.abs(net) > 0.005
    accruals.push({
      // One row per group, so there is nothing to ordinal — the group key is
      // already unique within the file and identical across imports.
      id: makeId(
        ['accrual', first.instrumentKey, first.exDate, first.payDate, first.grossRate, first.currency],
        0,
      ),
      fileIds: [file.id],
      sourceRowIds: group.map((r) => r.br.row.id),
      instrumentKey: first.instrumentKey,
      exDate: first.exDate,
      payDate: first.payDate,
      quantity: posted.quantity,
      grossRate: num0(first.grossRate),
      currency: first.currency,
      gross: round6(gross),
      tax: round6(tax),
      net: round6(net),
      open,
      supersededAt: null,
    })
  }

  // Accruals carry the ex-date the Dividends section omits. One instrument can
  // have two accruals sharing a pay date (a special alongside the ordinary), so
  // the gross rate breaks the tie against the dividend's per-share rate. When it
  // cannot, report no ex-date rather than an arbitrary one — a wrong ex-date is
  // worse than a missing one.
  const accrualsByPay = new Map<string, Accrual[]>()
  for (const a of accruals) pushTo(accrualsByPay, `${a.instrumentKey}|${a.payDate}`, a)

  const exDateFor = (instrumentKey: string, payDate: ISODate, perShare: number | null): ISODate | null => {
    const all = accrualsByPay.get(`${instrumentKey}|${payDate}`) ?? []
    const pick = (cands: readonly Accrual[]): ISODate | null => {
      const dates = new Set(cands.map((a) => a.exDate).filter(Boolean))
      return dates.size === 1 ? ([...dates][0] ?? null) : null
    }
    if (all.length <= 1) return pick(all)
    if (perShare !== null) {
      const rated = all.filter((a) => Math.abs(a.grossRate - perShare) < 1e-9)
      if (rated.length > 0) return pick(rated)
    }
    return pick(all)
  }

  const pendingDist: Pending<Distribution>[] = divRows.map((dv) => {
    const matched = taxFor.get(dv)
    // IBKR signs withholding negative; Distribution.tax is a positive cost, so
    // a tax refund correctly lands as a negative tax.
    const tax = matched ? -matched.amount : 0
    const parts = naturalKey(dv.br.section, dv.br.b) ?? []
    return {
      parts,
      make: (id): Distribution => ({
        id,
        fileIds: [file.id],
        sourceRowIds: [dv.br.row.id, ...(matched?.rows.map((w) => w.br.row.id) ?? [])],
        instrumentKey: dv.instrument?.key ?? null,
        isin: dv.parsed.isin ?? dv.instrument?.isin ?? null,
        payDate: dv.date,
        exDate: dv.instrument ? exDateFor(dv.instrument.key, dv.date, dv.parsed.perShare) : null,
        currency: dv.currency,
        gross: dv.amount,
        tax: round6(tax),
        net: round6(dv.amount - tax),
        perShare: dv.parsed.perShare,
        description: dv.description,
        divType: dv.parsed.divType,
        supersededAt: null,
      }),
    }
  })

  // Withholding with no dividend to attach to — "Withholding @ 20% on Credit
  // Interest" is a real row and real money.
  for (const w of whtRows) {
    if (matchedWht.has(w)) continue
    const parts = naturalKey('Withholding Tax', w.br.b) ?? []
    pendingCash.push({
      parts,
      make: (id) => ({
        id,
        fileIds: [file.id],
        sourceRowIds: [w.br.row.id],
        kind: 'TAX',
        date: w.date,
        amount: w.amount,
        currency: w.currency,
        description: w.description,
        supersededAt: null,
      }),
    })
    cashSection.push('Withholding Tax')
  }

  // ── Plain cash sections ────────────────────────────────────────────────────
  for (const [section, kindOf] of CASH_SECTIONS) {
    for (const br of bySection.get(section) ?? []) {
      if (!isDataRow(br)) continue
      const date = toDate(col(br.b, COL.date))
      if (date === null) {
        warnings.push(`${section} row ${br.row.lineNo}: unparseable date`)
        continue
      }
      const amount = num0(col(br.b, COL.amount))
      const currency = col(br.b, COL.currency).trim()
      const description = col(br.b, COL.description)
      const parts = naturalKey(section, br.b, resolveKey) ?? []
      pendingCash.push({
        parts,
        make: (id) => ({
          id,
          fileIds: [file.id],
          sourceRowIds: [br.row.id],
          kind: kindOf(amount),
          date,
          amount,
          currency,
          description,
          supersededAt: null,
        }),
      })
      cashSection.push(section)
    }
  }

  const transactions = finalize(pendingTx)
  const distributions = finalize(pendingDist)
  const cashEvents = finalize(pendingCash)

  // ── Reconciliation ─────────────────────────────────────────────────────────
  // Compare what we derived against IBKR's own arithmetic. Anything that fails
  // here is our bug, not theirs.

  const reconcileSection = (
    section: string,
    label: string,
    amountCols: readonly (string | RegExp)[],
    ours: Map<string, number>,
  ): void => {
    const secRows = bySection.get(section)
    if (!secRows) return
    const totals = sectionTotals(secRows, amountCols, base)
    for (const [ccy, theirs] of totals.byCcy) {
      reconciliation.push(checkOf(`${label} (${ccy})`, ours.get(ccy) ?? 0, theirs, ccy))
    }
    // The grand total is already translated to base; only comparable when
    // nothing in the section needed translating.
    if (totals.baseGrand !== null && totals.allBase && base) {
      const sum = [...ours.values()].reduce((s, v) => s + v, 0)
      reconciliation.push(checkOf(`${label} — statement total`, sum, totals.baseGrand, base))
    }
  }

  /** Derived cash events that came out of one section, summed per currency. */
  const cashByCcy = (section: string): Map<string, number> => {
    const m = new Map<string, number>()
    cashEvents.forEach((e, i) => {
      if (cashSection[i] === section) addTo(m, e.currency, e.amount)
    })
    return m
  }

  {
    // `distributions` is finalize()d from `divRows` in order, so the two arrays
    // line up index for index.
    const m = new Map<string, number>()
    distributions.forEach((d, i) => {
      if (divRows[i]?.br.section === 'Dividends') addTo(m, d.currency, d.gross)
    })
    reconcileSection('Dividends', 'Dividends', COL.amount, m)
  }

  {
    // Every withholding row, whether it landed on a dividend or became a
    // standalone TAX event. Signed the way IBKR signs it: negative is money out.
    const m = cashByCcy('Withholding Tax')
    for (const d of distributions) addTo(m, d.currency, -d.tax)
    reconcileSection('Withholding Tax', 'Withholding tax', COL.amount, m)
  }

  for (const [section] of CASH_SECTIONS) {
    if (!bySection.has(section)) continue
    reconcileSection(section, section, COL.amount, cashByCcy(section))
  }

  {
    const secRows = bySection.get('Change in Dividend Accruals')
    if (secRows) {
      const totals = sectionTotals(secRows, COL.netAmount, base)
      const oursNet = new Map<string, number>()
      for (const a of accruals) addTo(oursNet, a.currency, a.net)
      for (const [ccy, theirs] of totals.byCcy) {
        reconciliation.push(checkOf(`Dividend accrual change (${ccy})`, oursNet.get(ccy) ?? 0, theirs, ccy))
      }
      // Ending balance = starting + change. We only model accruals we have seen
      // change rows for, so the comparison is honest only when the period opened
      // with a clean slate and nothing needs FX.
      const startingLabel = [...totals.labelled.keys()].find((k) => k.startsWith('Starting Dividend Accruals'))
      const endingLabel = [...totals.labelled.keys()].find((k) => k.startsWith('Ending Dividend Accruals'))
      const starting = startingLabel ? (totals.labelled.get(startingLabel) ?? 0) : 0
      const ending = endingLabel ? totals.labelled.get(endingLabel) : undefined
      const openAccruals = accruals.filter((a) => a.open)

      // Check the OPEN FLAG itself, per currency, against IBKR's per-currency
      // change totals. Done this way it needs no FX, so unlike the base-currency
      // check below it actually runs on a multi-currency statement — which is
      // the only kind this app sees. Computing it from `accruals` rather than
      // from the raw rows is the point: it is the flag we are validating.
      if (Math.abs(starting) <= 0.02) {
        const openByCcy = new Map<string, number>()
        for (const a of openAccruals) {
          openByCcy.set(a.currency, (openByCcy.get(a.currency) ?? 0) + a.net)
        }
        for (const [ccy, theirs] of totals.byCcy) {
          reconciliation.push(
            checkOf(`Open dividend accruals (${ccy})`, openByCcy.get(ccy) ?? 0, theirs, ccy),
          )
        }
      }

      const openAllBase = openAccruals.every((a) => a.currency === base)
      if (ending !== undefined && base && Math.abs(starting) <= 0.02 && openAllBase) {
        reconciliation.push(
          checkOf(
            'Open dividend accruals',
            openAccruals.reduce((s, a) => s + a.net, 0),
            ending,
            base,
          ),
        )
      }
    }
  }

  for (const [k, theirs] of theirsTradeGroup) {
    const ours = oursTradeGroup.get(k) ?? { qty: 0, proceeds: 0, comm: 0, realized: 0 }
    const label = tradeGroupLabel.get(k) ?? k
    const ccy = k.split('|')[1] ?? ''
    reconciliation.push(checkOf(`Trades quantity ${label}`, ours.qty, theirs.qty, ccy))
    reconciliation.push(checkOf(`Trades proceeds ${label}`, ours.proceeds, theirs.proceeds, ccy))
    reconciliation.push(checkOf(`Trades commission ${label}`, ours.comm, theirs.comm, ccy))
    reconciliation.push(checkOf(`Trades realized P/L ${label}`, ours.realized, theirs.realized, ccy))
  }

  // ── Instruments ────────────────────────────────────────────────────────────
  const instruments: Instrument[] = reg.drafts.map((d) => ({
    key: d.key,
    identitySource: d.identitySource,
    conid: d.conid,
    isin: d.isin,
    symbol: d.symbol,
    aliases: [...d.aliases],
    name: d.name,
    assetCategory: d.assetCategory,
    type: d.type,
    listingExchange: d.listingExchange,
    multiplier: d.multiplier,
    tradeCurrency: d.tradeCurrency,
    divCurrency: d.divCurrency,
    firstSeen: d.firstSeen ?? file.periodStart ?? '',
    lastSeen: d.lastSeen ?? file.periodEnd ?? '',
  }))

  return {
    instruments,
    fxRates,
    transactions,
    distributions,
    accruals,
    cashEvents,
    positions,
    reconciliation,
    warnings,
  }
}
