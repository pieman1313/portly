/**
 * stockanalysis.com — live prices, and the dividend fallback for anything that is
 * not an ETF (extraETF is ETF-only, and the user will add individual stocks).
 *
 * Two structural facts drive the shape of this file:
 *   - There is no batch endpoint. `/api/quotes/q/A,B` answers `{"status":404}`.
 *     Requests are serial, one per candidate symbol; seven is fine.
 *   - Failure is signalled INSIDE an HTTP 200 body as `{"status":404}`. The HTTP
 *     status is meaningless here, so every response is schema-checked and a body
 *     status other than 200 is treated as a miss on that symbol, not as an error.
 */

import type { Currency, DividendProfile, ISODateTime, Instrument, ProviderDistribution, Quote } from '../domain/types'
import { expectedQuoteCurrency, resolveSymbolCandidates } from './resolve'
import { applyPriceUnit, detectPriceUnit } from './sanity'
import type { PriceUnit } from './sanity'
import {
  asCurrency,
  asIsoDate,
  asNumber,
  asString,
  dominantCurrency,
  fail,
  fetchJson,
  frequencyFromExDates,
  isRecord,
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
  PriceProvider,
  ProviderOverride,
  Result,
} from './types'

const ID = 'stockanalysis' as const

/**
 * `q` addresses an exchange-prefixed listing, `s` a US symbol. They are not
 * interchangeable — /api/quotes/q/AAPL is a 404 and /api/quotes/s/LON-IUKD is a
 * 404 — so the caller passes the form the resolver chose rather than this
 * module guessing from the string. Guessing would misread a US ticker like
 * BRK-B as venue "BRK".
 *
 * The symbol is already constrained to an allowlist by `resolve.ts` before it
 * gets here; encodeURIComponent is belt and braces on a path segment.
 */
export type PathKind = 'q' | 's'

export function quoteUrl(symbol: string, kind: PathKind = 'q'): string {
  return `https://stockanalysis.com/api/quotes/${kind}/${encodeURIComponent(symbol)}`
}

export function dividendUrl(symbol: string, kind: PathKind = 'q'): string {
  return `https://stockanalysis.com/api/symbol/${kind}/${encodeURIComponent(symbol)}/dividend`
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTES
// ─────────────────────────────────────────────────────────────────────────────

export interface SaQuote {
  symbol: string
  price: number
  previousClose: number | null
  exchange: string | null
  /** Present only if they ever start sending one. Today they do not. */
  currency: Currency | null
  asOf: ISODateTime
}

/**
 * `u` is a human string ("Aug 20, 2026, 4:00 PM EDT"), not a timestamp. When it
 * parses we use it; when it does not — or when it lands in the future, which is
 * what a mis-parsed year looks like — we fall back to the wall clock rather than
 * stamp a quote with a date the staleness badge would then trust.
 */
function timestampFrom(raw: unknown, now: Date): ISODateTime {
  const s = asString(raw)
  if (!s) return toIsoDateTime(now)
  const t = Date.parse(s)
  if (Number.isNaN(t)) return toIsoDateTime(now)
  if (t > now.getTime() + 2 * 86_400_000) return toIsoDateTime(now)
  return toIsoDateTime(new Date(t))
}

export function parseQuoteBody(
  body: unknown,
  symbol: string,
  now: Date = new Date(),
): Result<SaQuote> {
  if (!isRecord(body)) return fail('quote: body is not an object')

  const status = asNumber(body['status'])
  if (status === null) return fail('quote: body has no status')
  // Their in-band miss. Caller moves to the next candidate symbol.
  if (status !== 200) return fail(`quote: provider status ${status}`)

  const data = body['data']
  if (!isRecord(data)) return fail('quote: body.data is not an object')

  const price = asNumber(data['p'])
  if (price === null) return fail('quote: no price in body.data.p')
  if (price <= 0) return fail(`quote: non-positive price ${price}`)

  const previousClose = asNumber(data['cl'])
  return ok({
    symbol,
    price,
    previousClose: previousClose !== null && previousClose > 0 ? previousClose : null,
    exchange: asString(data['ex']),
    currency: asCurrency(data['c']) ?? asCurrency(data['currency']),
    asOf: timestampFrom(data['u'], now),
  })
}

/** Fetch one symbol. A well-formed body — even `{"status":404}` — means the
 *  provider is up, so health tracks reachability rather than symbol coverage. */
export async function fetchQuote(
  symbol: string,
  opts: FetchOptions = {},
  now: Date = new Date(),
  kind: PathKind = 'q',
): Promise<Result<SaQuote>> {
  const res = await fetchJson(quoteUrl(symbol, kind), opts)
  if (!res.ok) {
    recordFailure(ID, res.reason)
    return fail(`${symbol}: ${res.reason}`)
  }
  recordSuccess(ID)
  const parsed = parseQuoteBody(res.value, symbol, now)
  return parsed.ok ? parsed : fail(`${symbol}: ${parsed.reason}`)
}

export function createStockanalysisPriceProvider(opts: FetchOptions = {}): PriceProvider {
  return {
    id: ID,
    async quote(inst: Instrument, override?: ProviderOverride | null): Promise<Result<Quote>> {
      const resolution = resolveSymbolCandidates(inst, override)
      if (resolution.candidates.length === 0) {
        return fail(resolution.note ?? 'no provider symbol')
      }

      const currency = expectedQuoteCurrency(inst, override)
      if (!currency) {
        // Rather than guess: an LSE line can be GBP, GBX, USD or EUR, and a wrong
        // guess is invisible downstream.
        return fail(`unknown trade currency for ${inst.symbol} — set one in Settings`)
      }

      const now = new Date()
      const misses: string[] = []
      for (const symbol of resolution.candidates) {
        const res = await fetchQuote(symbol, opts, now, resolution.pathKind)
        if (!res.ok) {
          misses.push(res.reason)
          continue
        }
        const raw = res.value
        const unit: PriceUnit = override?.priceUnit ?? detectPriceUnit(raw.price, override?.statementClose)
        return ok({
          instrumentKey: inst.key,
          price: applyPriceUnit(raw.price, unit),
          currency: raw.currency ?? currency,
          previousClose:
            raw.previousClose === null ? null : applyPriceUnit(raw.previousClose, unit),
          provenance: { source: ID, asOf: raw.asOf },
        })
      }
      return fail(misses.join('; ') || 'no candidate resolved')
    },
  }
}

export const stockanalysisPrices: PriceProvider = createStockanalysisPriceProvider()

// ─────────────────────────────────────────────────────────────────────────────
// DIVIDENDS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The dividend body is undocumented and has been reshaped before, so the row
 * container and the per-row keys are matched against every spelling seen in the
 * wild. If none match we fail the whole response rather than return an empty
 * history that reads as "this fund pays nothing".
 */
const ROW_CONTAINERS = ['list', 'data', 'dividends', 'dividendData', 'table', 'rows']
const EX_DATE_KEYS = ['exDate', 'ex_date', 'ex', 'dt', 'date']
const PAY_DATE_KEYS = ['payDate', 'pay_date', 'paymentDate', 'payment_date', 'pay']
const AMOUNT_KEYS = ['amount', 'adjDividend', 'dividend', 'dps', 'value', 'v']

function firstOf(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k)) return row[k]
  }
  return undefined
}

function rowsFrom(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data
  if (!isRecord(data)) return null
  for (const key of ROW_CONTAINERS) {
    const v = data[key]
    if (Array.isArray(v)) return v
  }
  return null
}

export function parseDividendBody(
  body: unknown,
  fallbackCurrency: Currency | null,
): Result<ProviderDistribution[]> {
  if (!isRecord(body)) return fail('dividends: body is not an object')
  const status = asNumber(body['status'])
  if (status === null) return fail('dividends: body has no status')
  if (status !== 200) return fail(`dividends: provider status ${status}`)

  const rows = rowsFrom(body['data'])
  if (!rows) return fail('dividends: no recognisable row array in body.data')

  const out: ProviderDistribution[] = []
  for (const raw of rows) {
    if (!isRecord(raw)) continue
    const exDate = asIsoDate(firstOf(raw, EX_DATE_KEYS))
    const amount = asNumber(firstOf(raw, AMOUNT_KEYS))
    if (!exDate || amount === null || amount <= 0) continue
    const currency = asCurrency(raw['currency']) ?? asCurrency(raw['cur']) ?? fallbackCurrency
    if (!currency) continue
    out.push({
      exDate,
      payDate: asIsoDate(firstOf(raw, PAY_DATE_KEYS)),
      amount,
      currency,
      declared: true,
    })
  }
  out.sort((a, b) => (a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : 0))
  return ok(out)
}

export function createStockanalysisDividendProvider(
  opts: FetchOptions = {},
): DividendProvider {
  return {
    id: ID,
    async profile(
      inst: Instrument,
      override?: ProviderOverride | null,
    ): Promise<Result<DividendProfile>> {
      const resolution = resolveSymbolCandidates(inst, override)
      if (resolution.candidates.length === 0) {
        return fail(resolution.note ?? 'no provider symbol')
      }

      // Dividends are paid in the fund's own distribution currency, which is not
      // always the trade currency: IUKD trades EUR on Borsa Italiana and pays GBP.
      const fallbackCurrency =
        override?.divCurrency ?? inst.divCurrency ?? inst.tradeCurrency ?? null

      const now = new Date()
      const misses: string[] = []
      for (const symbol of resolution.candidates) {
        const res = await fetchJson(dividendUrl(symbol, resolution.pathKind), opts)
        if (!res.ok) {
          recordFailure(ID, res.reason)
          misses.push(`${symbol}: ${res.reason}`)
          continue
        }
        recordSuccess(ID)
        const parsed = parseDividendBody(res.value, fallbackCurrency)
        if (!parsed.ok) {
          misses.push(`${symbol}: ${parsed.reason}`)
          continue
        }
        const distributions = parsed.value
        // Not `distributions[0]` — the array is sorted ex-date ASCENDING, so that
        // is the oldest payment on record. A single legacy row in another currency
        // would then filter every recent payment out of the TTM.
        const currency = dominantCurrency(distributions) ?? fallbackCurrency
        return ok({
          instrumentKey: inst.key,
          distributions,
          frequency: frequencyFromExDates(distributions.map((d) => d.exDate)),
          ttmPerShare: ttmPerShare(distributions, toIsoDate(now), currency),
          currency,
          // History caps at ~20 rows here, so "no rows" genuinely means no
          // distributions rather than a truncated window.
          isDistributing: distributions.length > 0,
          cagr: null,
          provenance: { source: ID, asOf: toIsoDateTime(now) },
        })
      }
      return fail(misses.join('; ') || 'no candidate resolved')
    },
  }
}

export const stockanalysisDividends: DividendProvider = createStockanalysisDividendProvider()
