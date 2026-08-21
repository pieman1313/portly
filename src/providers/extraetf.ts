/**
 * extraETF — the deep dividend source. ETFs only, addressed by ISIN.
 *
 * `GET https://extraetf.com/api-v2/detail/?isin={ISIN}` returns ~173 KB per ISIN
 * with no field trimming (`&fields=` / `&only=` are ignored), so responses are
 * cached hard for the session. It reaches back to 2005 with ex AND pay dates, and
 * carries every payment in its trading currency alongside EUR/GBP/USD — which is
 * what finally answers "IUKD trades EUR and pays GBP".
 *
 * Three traps, all handled below:
 *   - Accumulating funds still return distribution rows. Gate on `is_distributing`.
 *   - `sum_distribution` / `yield_distribution` are CALENDAR-YEAR, not TTM.
 *   - The enums are German (`Ausschüttend`, `Vierteljährlich`).
 */

import type {
  Currency,
  DividendProfile,
  ISODate,
  Instrument,
  ProviderDistribution,
} from '../domain/types'
import {
  asBoolean,
  asCurrency,
  asIsoDate,
  asNumber,
  asString,
  dominantCurrency,
  fail,
  fetchJson,
  frequencyFromExDates,
  isRecord,
  isSafeKey,
  ok,
  recordFailure,
  recordSuccess,
  toIsoDate,
  toIsoDateTime,
  ttmPerShare,
} from './types'
import type {
  DividendProvider,
  FetchOptions,
  ProviderOverride,
  Result,
} from './types'

const ID = 'extraetf' as const

/** ISO 6166. Validated before it reaches a URL — this string comes from a CSV. */
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/

export function detailUrl(isin: string): string {
  return `https://extraetf.com/api-v2/detail/?isin=${encodeURIComponent(isin)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// GERMAN ENUMS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold umlauts and the ASCII transliterations of them onto one key, so
 * `Vierteljährlich`, `Vierteljaehrlich` and `VIERTELJÄHRLICH` all match.
 */
function foldGerman(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ae/g, 'a')
    .replace(/oe/g, 'o')
    .replace(/ue/g, 'u')
    .replace(/[^a-z]/g, '')
}

export type DistributionPolicy = 'distributing' | 'accumulating'

const POLICIES = new Map<string, DistributionPolicy>([
  ['ausschuttend', 'distributing'],
  ['ausschuttungen', 'distributing'],
  ['thesaurierend', 'accumulating'],
  ['thesaurierung', 'accumulating'],
])

export function mapDistributionPolicy(v: unknown): DistributionPolicy | null {
  const s = asString(v)
  return s ? (POLICIES.get(foldGerman(s)) ?? null) : null
}

/** German interval name → payments per year. */
const FREQUENCIES = new Map<string, number>([
  ['monatlich', 12],
  ['zweimonatlich', 6],
  ['vierteljahrlich', 4],
  ['quartalsweise', 4],
  ['halbjahrlich', 2],
  ['jahrlich', 1],
  ['keineausschuttung', 0],
  ['keine', 0],
])

export function mapDistributionFrequency(v: unknown): number | null {
  const s = asString(v)
  if (!s) return null
  const mapped = FREQUENCIES.get(foldGerman(s))
  if (mapped !== undefined) return mapped
  // Unrecognised label (`Unregelmäßig`, or a rename): fall through to the caller's
  // ex-date inference rather than pretend to a number.
  return null
}

const GERMAN_MONTHS = [
  'januar',
  'februar',
  'marz',
  'april',
  'mai',
  'juni',
  'juli',
  'august',
  'september',
  'oktober',
  'november',
  'dezember',
]

/** 1-based month, or null. */
export function germanMonthIndex(v: unknown): number | null {
  const s = asString(v)
  if (!s) return null
  const i = GERMAN_MONTHS.indexOf(foldGerman(s))
  return i === -1 ? null : i + 1
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSING
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtraEtfProfile {
  isin: string
  isDistributing: boolean
  distributions: ProviderDistribution[]
  currency: Currency | null
  /** From `distribution_frequency`, which records when the schedule CHANGED. */
  declaredFrequency: number | null
  cagr: Record<string, number> | null
}

/** The endpoint has been seen bare and wrapped; accept both, reject anything else. */
function unwrap(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null
  const results = body['results']
  if (Array.isArray(results)) {
    const first = results[0]
    return isRecord(first) ? first : null
  }
  const data = body['data']
  if (isRecord(data)) return data
  return body
}

/**
 * The row carries the payment in its trading currency (`total_in_tc`) plus fixed
 * EUR/GBP/USD conversions, but no currency CODE. Whichever converted column equals
 * `total_in_tc` identifies it — a self-describing trick that survives the field
 * being renamed, which an explicit currency key would not.
 */
function currencyOfRow(row: Record<string, unknown>): Currency | null {
  const explicit =
    asCurrency(row['currency']) ??
    asCurrency(row['trading_currency']) ??
    asCurrency(row['distribution_currency'])
  if (explicit) return explicit

  const tc = asNumber(row['total_in_tc'])
  if (tc === null || tc === 0) return null
  const matches: Currency[] = []
  for (const [key, code] of [
    ['total_in_eur', 'EUR'],
    ['total_in_gbp', 'GBP'],
    ['total_in_usd', 'USD'],
  ] as const) {
    const v = asNumber(row[key])
    if (v !== null && Math.abs(v - tc) <= Math.abs(tc) * 1e-9) matches.push(code)
  }
  return matches.length === 1 ? matches[0]! : null
}

const CONVERTED_COLUMNS = [
  ['total_in_eur', 'EUR'],
  ['total_in_gbp', 'GBP'],
  ['total_in_usd', 'USD'],
] as const

interface StagedRow {
  exDate: ISODate
  payDate: ISODate | null
  /** Null when `currencyOfRow` could not name the trading currency. */
  currency: Currency | null
  /** `total_in_tc`, i.e. the amount in `currency`. */
  amount: number | null
  /** The fixed conversions the same row carries, by code. */
  converted: Map<Currency, number>
}

function stageRows(raw: unknown): StagedRow[] {
  if (!isRecord(raw)) return []
  const out: StagedRow[] = []
  for (const [year, rows] of Object.entries(raw)) {
    if (!isSafeKey(year) || !Array.isArray(rows)) continue
    for (const row of rows) {
      if (!isRecord(row)) continue
      const exDate = asIsoDate(row['ex_date'])
      if (!exDate) continue
      const converted = new Map<Currency, number>()
      for (const [key, code] of CONVERTED_COLUMNS) {
        const v = asNumber(row[key])
        if (v !== null && v > 0) converted.set(code, v)
      }
      out.push({
        exDate,
        payDate: asIsoDate(row['pay_date']),
        currency: currencyOfRow(row),
        amount: asNumber(row['total_in_tc']),
        converted,
      })
    }
  }
  return out
}

/**
 * Two passes, because a row that fails to name its own currency must not be
 * allowed to change the currency of the whole history.
 *
 * Pass 1 names every row it can. Pass 2 re-expresses the rest in the currency the
 * named rows agree on, using the fixed conversion the SAME row already carries —
 * so one row with a missing `total_in_tc` costs nothing instead of being tagged
 * EUR, filtered out by the caller and quietly removed from the TTM.
 */
function parseDistributions(raw: unknown): ProviderDistribution[] {
  const staged = stageRows(raw)
  const named: ProviderDistribution[] = []
  for (const r of staged) {
    if (!r.currency || r.amount === null || r.amount <= 0) continue
    named.push({
      exDate: r.exDate,
      payDate: r.payDate,
      amount: r.amount,
      currency: r.currency,
      declared: true,
    })
  }

  // Whatever the named rows mostly say; EUR only when nothing named itself, which
  // is the documented last resort.
  const house = dominantCurrency(named) ?? 'EUR'

  const out: ProviderDistribution[] = []
  for (const r of staged) {
    let currency = r.currency
    let amount = r.currency ? r.amount : null
    if (amount === null || amount <= 0) {
      const fallback = r.converted.get(house)
      if (fallback === undefined) continue
      currency = house
      amount = fallback
    }
    out.push({
      exDate: r.exDate,
      payDate: r.payDate,
      amount,
      currency: currency ?? house,
      declared: true,
    })
  }
  out.sort((a, b) => (a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : 0))
  return out
}

/** The entry in force today; entries are keyed by the date the schedule changed. */
function parseDeclaredFrequency(raw: unknown, today: ISODate): number | null {
  if (!Array.isArray(raw)) return null
  let best: { start: ISODate; value: number } | null = null
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const start = asIsoDate(entry['start_date']) ?? '0000-01-01'
    if (start > today) continue
    // The named interval is the declaration; the month list is corroboration and
    // only gets used when the label is one we do not know (`Unregelmäßig`, or a
    // future rename).
    const months = entry['months']
    const byCount =
      Array.isArray(months) && months.length >= 1 && months.length <= 12 ? months.length : null
    const value = mapDistributionFrequency(entry['name']) ?? byCount
    if (value === null) continue
    if (!best || start >= best.start) best = { start, value }
  }
  return best?.value ?? null
}

function parseCagr(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null
  const out: Record<string, number> = {}
  let any = false
  for (const [key, value] of Object.entries(raw)) {
    if (!isSafeKey(key)) continue
    const n = asNumber(value)
    if (n === null) continue
    const year = /^year_(\d{1,2})$/.exec(key)
    const outKey = year ? year[1]! : key
    if (!isSafeKey(outKey)) continue
    out[outKey] = n
    any = true
  }
  return any ? out : null
}

export function parseDetail(body: unknown, isin: string, today: ISODate): Result<ExtraEtfProfile> {
  const detail = unwrap(body)
  if (!detail) return fail('detail: body is not an object')

  const flag = asBoolean(detail['is_distributing'])
  const policy = mapDistributionPolicy(detail['distribution_policy'] ?? detail['distribution_type'])
  if (flag === null && policy === null) {
    // No gate means no way to tell a real payment from a phantom row. Refuse.
    return fail('detail: no is_distributing flag and no distribution policy')
  }
  const isDistributing = flag ?? policy === 'distributing'

  if (!isDistributing) {
    // Accumulating funds still ship rows here (VUAA returns two). Drop them.
    return ok({ isin, isDistributing: false, distributions: [], currency: null, declaredFrequency: 0, cagr: null })
  }

  const distributions = parseDistributions(detail['distribution_frequency_months'])
  // Not the last row: a single trailing payment whose currency we failed to name
  // would otherwise redenominate the whole profile and drop every other payment
  // out of the caller's currency filter.
  const currency = dominantCurrency(distributions)
  return ok({
    isin,
    isDistributing: true,
    distributions,
    currency,
    declaredFrequency: parseDeclaredFrequency(detail['distribution_frequency'], today),
    cagr: parseCagr(detail['distribution_cagr']),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH + SESSION CACHE
// ─────────────────────────────────────────────────────────────────────────────

/** Promises, not values: two holdings resolving the same ISIN concurrently must
 *  not both pull 173 KB. */
const CACHE = new Map<string, Promise<Result<ExtraEtfProfile>>>()

export function clearExtraEtfCache(): void {
  CACHE.clear()
}

export async function fetchDetail(
  isin: string,
  opts: FetchOptions = {},
  today: ISODate = toIsoDate(new Date()),
): Promise<Result<ExtraEtfProfile>> {
  const key = isin.trim().toUpperCase()
  if (!ISIN.test(key)) return fail(`"${isin}" is not a valid ISIN`)

  const cached = CACHE.get(key)
  if (cached) return cached

  const pending = (async (): Promise<Result<ExtraEtfProfile>> => {
    const res = await fetchJson(detailUrl(key), opts)
    if (!res.ok) {
      recordFailure(ID, res.reason)
      return fail(`${key}: ${res.reason}`)
    }
    recordSuccess(ID)
    const parsed = parseDetail(res.value, key, today)
    return parsed.ok ? parsed : fail(`${key}: ${parsed.reason}`)
  })()

  CACHE.set(key, pending)
  const result = await pending
  // Keep successes for the session; let failures be retried.
  if (!result.ok) CACHE.delete(key)
  return result
}

export function createExtraEtfProvider(opts: FetchOptions = {}): DividendProvider {
  return {
    id: ID,
    async profile(
      inst: Instrument,
      override?: ProviderOverride | null,
    ): Promise<Result<DividendProfile>> {
      if (override?.excluded === true) return fail('excluded by user')
      if (!inst.isin) return fail(`${inst.symbol} has no ISIN — extraETF is ISIN-addressed`)

      const now = new Date()
      const today = toIsoDate(now)
      const res = await fetchDetail(inst.isin, opts, today)
      if (!res.ok) return fail(res.reason)

      const detail = res.value
      const currency = override?.divCurrency ?? detail.currency ?? inst.divCurrency ?? null
      const distributions = currency
        ? detail.distributions.filter((d) => d.currency === currency)
        : detail.distributions

      return ok({
        instrumentKey: inst.key,
        distributions,
        // The declared schedule beats inference: it is stated, and it is correct
        // for a fund that has only ever paid once.
        frequency:
          detail.declaredFrequency ?? frequencyFromExDates(distributions.map((d) => d.exDate)),
        // Computed here, never read from `sum_distribution` — that field is a
        // calendar-year total and would understate every January refresh.
        ttmPerShare: detail.isDistributing ? (ttmPerShare(distributions, today, currency) ?? 0) : 0,
        currency,
        isDistributing: detail.isDistributing,
        cagr: detail.cagr,
        provenance: { source: ID, asOf: toIsoDateTime(now) },
      })
    },
  }
}

export const extraEtfDividends: DividendProvider = createExtraEtfProvider()
