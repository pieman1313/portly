import type { Currency, FxRate, ISODate } from '../domain/types'

/**
 * Currency conversion, and the calendar arithmetic the rest of the metrics
 * engine needs.
 *
 * Calendar helpers live here rather than in a util module because FX is the
 * one place that genuinely has to reason about *which day a number is for*:
 * Frankfurter (ECB) publishes on TARGET business days only, snaps a weekend or
 * holiday request backwards, and echoes the date it actually served. So a rate
 * lookup is always "the last published rate on or before this date", never
 * "the rate on this date".
 *
 * Rate orientation: an `FxRate` means `1 base = rate quote`, i.e.
 * `amountInQuote = amountInBase * rate`. This matches Frankfurter's
 * `?from=EUR&to=USD -> {"rates":{"USD":1.09}}`.
 *
 * Everything returns null rather than guessing. A wrong number in a portfolio
 * app is worse than a missing one, because the user cannot tell it is wrong.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/

/**
 * The one gate every calendar helper goes through.
 *
 * `Number('')` is 0, so a blank date used to silently become 1899-11-30 and
 * then sort, bucket and compare like a real day. Anything that is not a
 * literal 'YYYY-MM-DD' prefix is not a date, and the rest of the module has to
 * be told so rather than handed a plausible number.
 */
export function isValidISODate(date: unknown): date is ISODate {
  return typeof date === 'string' && ISO_DATE.test(date)
}

/** Accepts 'YYYY-MM-DD' or a full ISO datetime; only the date part is used. */
export function toEpochDay(date: string): number {
  if (!isValidISODate(date)) return NaN
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const d = Number(date.slice(8, 10))
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN
  return Date.UTC(y, m - 1, d) / MS_PER_DAY
}

/**
 * Returns '' for a non-finite day rather than throwing. `new Date(NaN)
 * .toISOString()` raises RangeError, and one unparseable date in one imported
 * row must not take the whole income view down with it.
 */
export function fromEpochDay(day: number): ISODate {
  if (!Number.isFinite(day)) return ''
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

/** Calendar days from `a` to `b`. Negative when `b` precedes `a`. */
export function daysBetween(a: string, b: string): number {
  return toEpochDay(b) - toEpochDay(a)
}

export function addDays(date: string, days: number): ISODate {
  return fromEpochDay(toEpochDay(date) + days)
}

/** 'YYYY-MM'. The bucket key for every monthly view in the app. */
export function monthKey(date: string): string {
  return date.slice(0, 7)
}

export function firstOfMonth(date: string): ISODate {
  return `${date.slice(0, 7)}-01`
}

/** Month arithmetic that never overflows into the next month (31 Jan + 1m = 28 Feb). */
export function addMonths(date: string, months: number): ISODate {
  if (!isValidISODate(date) || !Number.isFinite(months)) return ''
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const d = Number(date.slice(8, 10))
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = total - ny * 12
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate()
  const nd = Math.min(d, lastDay)
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`
}

/** Whole months between two dates, by month key. */
export function monthsBetween(a: string, b: string): number {
  const ay = Number(a.slice(0, 4))
  const am = Number(a.slice(5, 7))
  const by = Number(b.slice(0, 4))
  const bm = Number(b.slice(5, 7))
  return (by - ay) * 12 + (bm - am)
}

/** 1..12 */
export function monthOfYear(date: string): number {
  return Number(date.slice(5, 7))
}

export function quarterKey(date: string): string {
  const q = Math.floor((monthOfYear(date) - 1) / 3) + 1
  return `${date.slice(0, 4)}-Q${q}`
}

export function yearKey(date: string): string {
  return date.slice(0, 4)
}

// ─────────────────────────────────────────────────────────────────────────────
// RATE INDEX
// ─────────────────────────────────────────────────────────────────────────────

interface RatePoint {
  date: ISODate
  rate: number
}

export interface FxIndex {
  /** `${base}|${quote}` -> points sorted ascending by date. */
  readonly pairs: ReadonlyMap<string, readonly RatePoint[]>
  readonly currencies: readonly Currency[]
}

export type FxSource = FxIndex | readonly FxRate[]

export interface ConvertOptions {
  /**
   * How far back a lookup may reach for a missing day. Frankfurter gaps are a
   * weekend plus a holiday at worst; anything beyond that means we simply do
   * not have the data and must say so.
   */
  maxStaleDays?: number
  /** Pivot to try first for cross rates — normally the portfolio base currency. */
  via?: Currency
}

const DEFAULT_MAX_STALE_DAYS = 10

function pairKey(base: Currency, quote: Currency): string {
  return `${base}|${quote}`
}

export function indexRates(rates: readonly FxRate[]): FxIndex {
  const pairs = new Map<string, RatePoint[]>()
  const currencies = new Set<Currency>()
  for (const r of rates) {
    if (!Number.isFinite(r.rate) || r.rate <= 0) continue
    currencies.add(r.base)
    currencies.add(r.quote)
    const key = pairKey(r.base, r.quote)
    const list = pairs.get(key)
    if (list) list.push({ date: r.date, rate: r.rate })
    else pairs.set(key, [{ date: r.date, rate: r.rate }])
  }
  for (const list of pairs.values()) {
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  }
  return { pairs, currencies: [...currencies].sort() }
}

function isIndex(source: FxSource): source is FxIndex {
  return 'pairs' in (source as FxIndex)
}

export function asIndex(source: FxSource): FxIndex {
  return isIndex(source) ? source : indexRates(source)
}

/** Last point on or before `date`. Binary search — this runs per dividend row. */
function priorPoint(points: readonly RatePoint[], date: ISODate): RatePoint | null {
  let lo = 0
  let hi = points.length - 1
  let found: RatePoint | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const p = points[mid]
    if (p === undefined) break
    if (p.date <= date) {
      found = p
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

function directRate(
  index: FxIndex,
  from: Currency,
  to: Currency,
  date: ISODate,
  maxStale: number,
): { rate: number; date: ISODate } | null {
  const fwd = index.pairs.get(pairKey(from, to))
  if (fwd) {
    const p = priorPoint(fwd, date)
    if (p && daysBetween(p.date, date) <= maxStale) return { rate: p.rate, date: p.date }
  }
  // The provider may only publish one direction of the pair.
  const inv = index.pairs.get(pairKey(to, from))
  if (inv) {
    const p = priorPoint(inv, date)
    if (p && p.rate !== 0 && daysBetween(p.date, date) <= maxStale) {
      return { rate: 1 / p.rate, date: p.date }
    }
  }
  return null
}

export interface RateLookup {
  rate: number
  /** The day the rate is actually FOR. May be earlier than the day requested. */
  date: ISODate
  /** Non-null when the rate was crossed through a third currency. */
  via: Currency | null
}

/**
 * `1 from = rate to`, as of the last publication on or before `date`.
 *
 * Falls back to a cross rate through a pivot currency when the direct pair is
 * missing — an ECB-sourced table has EUR legs for everything but no GBP|USD,
 * so a GBP dividend in a USD portfolio can only be valued via EUR.
 */
export function lookupRate(
  from: Currency,
  to: Currency,
  date: ISODate,
  source: FxSource,
  opts: ConvertOptions = {},
): RateLookup | null {
  if (from === to) return { rate: 1, date, via: null }
  const index = asIndex(source)
  const maxStale = opts.maxStaleDays ?? DEFAULT_MAX_STALE_DAYS

  const direct = directRate(index, from, to, date, maxStale)
  if (direct) return { rate: direct.rate, date: direct.date, via: null }

  for (const pivot of pivotOrder(index, opts.via, from, to)) {
    const legA = directRate(index, from, pivot, date, maxStale)
    if (!legA) continue
    const legB = directRate(index, pivot, to, date, maxStale)
    if (!legB) continue
    // Report the STALER of the two legs: the pair is only as fresh as its
    // weakest link, and the UI shows that date as provenance.
    const effective = legA.date < legB.date ? legA.date : legB.date
    return { rate: legA.rate * legB.rate, date: effective, via: pivot }
  }
  return null
}

/**
 * Deterministic pivot preference. EUR first because every ECB/Frankfurter
 * table is EUR-based, so a EUR leg is the one most likely to exist.
 */
function pivotOrder(
  index: FxIndex,
  via: Currency | undefined,
  from: Currency,
  to: Currency,
): Currency[] {
  const preferred = [via, 'EUR', 'USD'].filter((c): c is Currency => typeof c === 'string')
  const rest = index.currencies.filter((c) => !preferred.includes(c))
  const seen = new Set<Currency>()
  const out: Currency[] = []
  for (const c of [...preferred, ...rest]) {
    if (c === from || c === to || seen.has(c)) continue
    seen.add(c)
    out.push(c)
  }
  return out
}

/**
 * Convert `amount` from one currency to another as of `date`.
 * Returns null when no rate can be established — the caller renders
 * "unavailable", never a plausible-looking wrong number.
 */
export function convert(
  amount: number,
  from: Currency,
  to: Currency,
  date: ISODate,
  rates: FxSource,
  opts: ConvertOptions = {},
): number | null {
  if (!Number.isFinite(amount)) return null
  if (from === to) return amount
  const hit = lookupRate(from, to, date, rates, opts)
  return hit === null ? null : amount * hit.rate
}

/** As `convert`, but keeps the provenance of the rate that was used. */
export function convertWithRate(
  amount: number,
  from: Currency,
  to: Currency,
  date: ISODate,
  rates: FxSource,
  opts: ConvertOptions = {},
): { amount: number; rate: number; rateDate: ISODate; via: Currency | null } | null {
  if (!Number.isFinite(amount)) return null
  if (from === to) return { amount, rate: 1, rateDate: date, via: null }
  const hit = lookupRate(from, to, date, rates, opts)
  if (hit === null) return null
  return { amount: amount * hit.rate, rate: hit.rate, rateDate: hit.date, via: hit.via }
}
