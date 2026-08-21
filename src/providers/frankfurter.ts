/**
 * Frankfurter — ECB daily reference rates, keyless, back to 1999-01-04.
 *
 * The one thing that must never be forgotten here: **it snaps weekends and TARGET
 * holidays back to the previous business day and echoes the real date in `date`.**
 * Ask for 2025-12-25 and you get 2025-12-24's rate stamped 2025-12-24. Storing it
 * under the requested date silently invents a rate for a day the ECB never
 * published, so every `FxRate` below carries the ECHOED date.
 *
 * Batch by date RANGE, never per transaction: one `/v1/{start}..{end}` covers a
 * whole statement in a single request.
 */

import type { Currency, FxRate, ISODate } from '../domain/types'
import {
  asNumber,
  asString,
  fail,
  fetchJson,
  isRecord,
  isSafeKey,
  ok,
  recordFailure,
  recordSuccess,
} from './types'
import type { FetchOptions, Result } from './types'

const ID = 'frankfurter' as const
const BASE_URL = 'https://api.frankfurter.dev/v1'

const CURRENCY = /^[A-Z]{3}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Every currency the ECB publishes, and therefore every currency this app can
 * convert to or from. Not a preference list — a hard boundary. Ask Frankfurter
 * for a base outside it and the request 404s, which takes every conversion in
 * the app down with it, so the UI offers exactly these and nothing else.
 *
 * Checked against /v1/currencies. The ECB set changes about once a decade
 * (HRK left on euro adoption in 2023); `fetchSupportedCurrencies` reads the
 * live list when you want to confirm it.
 */
export const SUPPORTED_CURRENCIES: Readonly<Record<Currency, string>> = Object.freeze({
  AUD: 'Australian Dollar', BRL: 'Brazilian Real', CAD: 'Canadian Dollar',
  CHF: 'Swiss Franc', CNY: 'Chinese Renminbi Yuan', CZK: 'Czech Koruna',
  DKK: 'Danish Krone', EUR: 'Euro', GBP: 'British Pound',
  HKD: 'Hong Kong Dollar', HUF: 'Hungarian Forint', IDR: 'Indonesian Rupiah',
  ILS: 'Israeli New Shekel', INR: 'Indian Rupee', ISK: 'Icelandic Króna',
  JPY: 'Japanese Yen', KRW: 'South Korean Won', MXN: 'Mexican Peso',
  MYR: 'Malaysian Ringgit', NOK: 'Norwegian Krone', NZD: 'New Zealand Dollar',
  PHP: 'Philippine Peso', PLN: 'Polish Złoty', RON: 'Romanian Leu',
  SEK: 'Swedish Krona', SGD: 'Singapore Dollar', THB: 'Thai Baht',
  TRY: 'Turkish Lira', USD: 'US Dollar', ZAR: 'South African Rand',
})

export function isSupportedCurrency(c: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_CURRENCIES, c.trim().toUpperCase())
}

export interface FxSnapshot {
  base: Currency
  /** What the ECB actually published, which may precede the date requested. */
  date: ISODate
  rates: Record<string, number>
}

function validCurrency(c: string): Currency | null {
  const up = c.trim().toUpperCase()
  return CURRENCY.test(up) ? up : null
}

/** Inputs are interpolated into a URL, so they are validated rather than escaped. */
function buildQuery(base: Currency, symbols: Currency[]): Result<string> {
  const b = validCurrency(base)
  if (!b) return fail(`"${base}" is not an ISO 4217 code`)
  const wanted: Currency[] = []
  for (const s of symbols) {
    const v = validCurrency(s)
    if (!v) return fail(`"${s}" is not an ISO 4217 code`)
    // Frankfurter drops the base from `rates`; asking for it wastes nothing but
    // confuses the caller, so it is filtered out and re-added as 1 on the way back.
    if (v !== b) wanted.push(v)
  }
  const params = new URLSearchParams({ base: b })
  if (wanted.length > 0) params.set('symbols', wanted.join(','))
  return ok(params.toString())
}

function parseRates(raw: unknown, base: Currency): Record<string, number> | null {
  if (!isRecord(raw)) return null
  const out: Record<string, number> = {}
  let any = false
  for (const [code, value] of Object.entries(raw)) {
    if (!isSafeKey(code)) continue
    const c = validCurrency(code)
    const n = asNumber(value)
    if (!c || n === null || n <= 0) continue
    out[c] = n
    any = true
  }
  if (!any) return null
  // Self-rate is implicit in the response and explicit everywhere downstream.
  out[base] = 1
  return out
}

export function parseSnapshotBody(body: unknown): Result<FxSnapshot> {
  // `{}` is a real Frankfurter-family failure body served with HTTP 200.
  if (!isRecord(body)) return fail('fx: body is not an object')
  const base = asString(body['base'])
  const baseCode = base ? validCurrency(base) : null
  if (!baseCode) return fail('fx: missing base currency')
  const date = asString(body['date'])
  if (!date || !ISO_DATE.test(date)) return fail('fx: missing or malformed date')

  const rates = parseRates(body['rates'], baseCode)
  if (!rates) return fail('fx: no usable rates')

  // We never send `amount`, but if one comes back it scales every rate.
  const amount = asNumber(body['amount'])
  if (amount !== null && amount !== 1 && amount > 0) {
    for (const code of Object.keys(rates)) rates[code] = rates[code]! / amount
    // The base self-rate is ours, synthesised in `parseRates` — it was never
    // multiplied by `amount`, so it must not be divided by it. Leaving it scaled
    // makes every base→base conversion off by exactly `amount`.
    rates[baseCode] = 1
  }
  return ok({ base: baseCode, date, rates })
}

export function parseRangeBody(
  body: unknown,
): Result<{ base: Currency; days: Record<ISODate, Record<string, number>> }> {
  if (!isRecord(body)) return fail('fx: body is not an object')
  const base = asString(body['base'])
  const baseCode = base ? validCurrency(base) : null
  if (!baseCode) return fail('fx: missing base currency')

  const byDate = body['rates']
  if (!isRecord(byDate)) return fail('fx: no rates map')

  const days: Record<ISODate, Record<string, number>> = {}
  let any = false
  for (const [date, raw] of Object.entries(byDate)) {
    if (!isSafeKey(date) || !ISO_DATE.test(date)) continue
    const rates = parseRates(raw, baseCode)
    if (!rates) continue
    days[date] = rates
    any = true
  }
  if (!any) return fail('fx: no usable rates in range')
  return ok({ base: baseCode, days })
}

export function toFxRates(base: Currency, date: ISODate, rates: Record<string, number>): FxRate[] {
  return Object.entries(rates).map(([quote, rate]) => ({
    id: `${base}|${quote}|${date}`,
    base,
    quote,
    date,
    rate,
  }))
}

async function get(path: string, query: string, opts: FetchOptions): Promise<Result<unknown>> {
  const res = await fetchJson(`${BASE_URL}/${path}?${query}`, opts)
  if (!res.ok) {
    recordFailure(ID, res.reason)
    return res
  }
  recordSuccess(ID)
  return res
}

export async function fetchLatestRates(
  base: Currency,
  symbols: Currency[],
  opts: FetchOptions = {},
): Promise<Result<FxSnapshot>> {
  const query = buildQuery(base, symbols)
  if (!query.ok) return query
  const res = await get('latest', query.value, opts)
  return res.ok ? parseSnapshotBody(res.value) : fail(res.reason)
}

/** `date` is a REQUEST; the answer carries the business day it resolved to. */
export async function fetchRatesOn(
  date: ISODate,
  base: Currency,
  symbols: Currency[],
  opts: FetchOptions = {},
): Promise<Result<FxSnapshot>> {
  if (!ISO_DATE.test(date)) return fail(`"${date}" is not a YYYY-MM-DD date`)
  const query = buildQuery(base, symbols)
  if (!query.ok) return query
  const res = await get(date, query.value, opts)
  return res.ok ? parseSnapshotBody(res.value) : fail(res.reason)
}

/**
 * One request for a whole statement period. Non-business days are simply absent
 * from the response — there is no row to mistake for a stale one.
 */
export async function fetchRatesRange(
  start: ISODate,
  end: ISODate,
  base: Currency,
  symbols: Currency[],
  opts: FetchOptions = {},
): Promise<Result<FxRate[]>> {
  if (!ISO_DATE.test(start)) return fail(`"${start}" is not a YYYY-MM-DD date`)
  if (!ISO_DATE.test(end)) return fail(`"${end}" is not a YYYY-MM-DD date`)
  if (start > end) return fail(`range start ${start} is after end ${end}`)
  const query = buildQuery(base, symbols)
  if (!query.ok) return query
  const res = await get(`${start}..${end}`, query.value, opts)
  if (!res.ok) return fail(res.reason)
  const parsed = parseRangeBody(res.value)
  if (!parsed.ok) return fail(parsed.reason)
  const out: FxRate[] = []
  for (const [date, rates] of Object.entries(parsed.value.days)) {
    out.push(...toFxRates(parsed.value.base, date, rates))
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return ok(out)
}

export const frankfurter = {
  id: ID,
  latest: fetchLatestRates,
  on: fetchRatesOn,
  range: fetchRatesRange,
} as const
