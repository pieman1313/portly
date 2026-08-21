/**
 * Provider kernel — the only seam between the app and the outside world.
 *
 * Nothing above `src/providers/` may learn that "stockanalysis" exists. Everything
 * up-stack consumes `Quote` / `DividendProfile` / `FxRate` from the domain contract,
 * so retiring a dead source is deleting one file and one entry in `index.ts`.
 *
 * The runtime primitives (transport, health ledger, a few pure stats) live in this
 * file rather than in a provider so that no provider ever imports another provider.
 * That is what keeps the "delete one file" property true.
 */

import type {
  Currency,
  DividendProfile,
  ISODate,
  ISODateTime,
  Instrument,
  InstrumentOverride,
  ProviderDistribution,
  ProviderId,
  Quote,
} from '../domain/types'

// ─────────────────────────────────────────────────────────────────────────────
// RESULT — errors are values. A provider must never throw into the UI.
// ─────────────────────────────────────────────────────────────────────────────

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function fail<T = never>(reason: string): Result<T> {
  return { ok: false, reason }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  return String(e)
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The user's per-instrument override, plus the one statement fact a provider needs
 * to interpret its own response.
 *
 * `statementClose` is not a user setting: it is the calibration reference that lets
 * `detectPriceUnit` notice that stockanalysis just answered in pence. It has to
 * travel with the override because a provider is otherwise given no price context.
 */
export interface ProviderOverride
  extends Partial<Omit<InstrumentOverride, 'instrumentKey'>> {
  /** Latest Open Positions `Close Price`, in the instrument's trade currency. */
  statementClose?: number | null
}

export interface PriceProvider {
  id: ProviderId
  quote(inst: Instrument, override?: ProviderOverride | null): Promise<Result<Quote>>
}

export interface DividendProvider {
  id: ProviderId
  profile(
    inst: Instrument,
    override?: ProviderOverride | null,
  ): Promise<Result<DividendProfile>>
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSPORT
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 8_000
/** extraETF ships a fixed ~173 KB per ISIN. Anything an order of magnitude past
 *  that is an error page or a hijacked edge, not data. */
const MAX_BODY_BYTES = 4_000_000

export interface FetchOptions {
  /** Hard per-request ceiling. Every call carries one; a hung socket must not
   *  hold the refresh open forever. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Injectable for tests. Resolved late so `globalThis.fetch` can be mocked. */
  fetchImpl?: typeof globalThis.fetch
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const combine = (AbortSignal as unknown as { any?(s: AbortSignal[]): AbortSignal }).any
  if (typeof combine === 'function') return combine.call(AbortSignal, signals)
  const controller = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason)
      break
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}

/**
 * The single fetch used by every provider.
 *
 * Two non-negotiables are encoded here rather than left to each call site:
 *
 * 1. `credentials: 'omit'`. Several of these hosts emit the spec-invalid pair
 *    `ACAO: *` + `Access-Control-Allow-Credentials: true`. That works only while
 *    nobody sends credentials; the first code path that does breaks all of them.
 * 2. No request headers at all — not even `Accept`. A non-safelisted header turns
 *    this into a preflighted request, and several of these edges answer OPTIONS
 *    badly (ECB 403s it outright, Finnhub omits allow-headers).
 */
export async function fetchJson(
  url: string,
  opts: FetchOptions = {},
): Promise<Result<unknown>> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return fail('fetch is unavailable in this runtime')

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = opts.signal ? anySignal([opts.signal, timeout]) : timeout

  let res: Response
  try {
    res = await doFetch(url, {
      method: 'GET',
      credentials: 'omit',
      mode: 'cors',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal,
    })
  } catch (e) {
    return fail(`network: ${errorMessage(e)}`)
  }

  if (!res || typeof res.status !== 'number') return fail('malformed response object')
  if (res.status < 200 || res.status >= 300) return fail(`http ${res.status}`)

  let text: string
  try {
    text = await res.text()
  } catch (e) {
    return fail(`body: ${errorMessage(e)}`)
  }
  if (text.length > MAX_BODY_BYTES) return fail(`body too large (${text.length} bytes)`)

  try {
    return ok(JSON.parse(text) as unknown)
  } catch {
    return fail('body is not JSON')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH LEDGER — feeds the Settings "Data sources" panel.
// ─────────────────────────────────────────────────────────────────────────────

export type HealthStatus = 'unknown' | 'ok' | 'degraded' | 'down'

export interface ProviderHealthEntry {
  id: ProviderId
  status: HealthStatus
  lastError: string | null
  lastErrorAt: ISODateTime | null
  lastSuccessAt: ISODateTime | null
  successes: number
  failures: number
  consecutiveFailures: number
}

interface MutableHealth {
  lastError: string | null
  lastErrorAt: ISODateTime | null
  lastSuccessAt: ISODateTime | null
  successes: number
  failures: number
  consecutiveFailures: number
}

/** Session-scoped only. Health is diagnostics, not data — it is never persisted. */
const HEALTH = new Map<ProviderId, MutableHealth>()

function slot(id: ProviderId): MutableHealth {
  const existing = HEALTH.get(id)
  if (existing) return existing
  const created: MutableHealth = {
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
  }
  HEALTH.set(id, created)
  return created
}

/**
 * Record that the provider ANSWERED, not that we got the data we wanted.
 * A body of `{"status":404}` for a mistyped ticker means the API is healthy and
 * our symbol is wrong; conflating the two makes the Settings panel useless.
 */
export function recordSuccess(id: ProviderId, at: Date = new Date()): void {
  const s = slot(id)
  s.successes += 1
  s.consecutiveFailures = 0
  s.lastSuccessAt = toIsoDateTime(at)
}

export function recordFailure(id: ProviderId, reason: string, at: Date = new Date()): void {
  const s = slot(id)
  s.failures += 1
  s.consecutiveFailures += 1
  s.lastError = reason
  s.lastErrorAt = toIsoDateTime(at)
}

function statusOf(s: MutableHealth): HealthStatus {
  if (s.successes === 0 && s.failures === 0) return 'unknown'
  if (s.consecutiveFailures >= 3) return 'down'
  if (s.consecutiveFailures > 0) return 'degraded'
  return 'ok'
}

export function providerHealthSnapshot(): ProviderHealthEntry[] {
  return [...HEALTH.entries()].map(([id, s]) => ({
    id,
    status: statusOf(s),
    lastError: s.lastError,
    lastErrorAt: s.lastErrorAt,
    lastSuccessAt: s.lastSuccessAt,
    successes: s.successes,
    failures: s.failures,
    consecutiveFailures: s.consecutiveFailures,
  }))
}

export function resetProviderHealth(): void {
  HEALTH.clear()
}

// ─────────────────────────────────────────────────────────────────────────────
// COERCION — every one of these APIs is undocumented. Trust nothing.
// ─────────────────────────────────────────────────────────────────────────────

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * A CSV column name or a JSON key can be `__proto__`. Writing it onto a plain
 * object replaces the prototype, so every key we copy from untrusted input is
 * filtered through here.
 */
export function isSafeKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

/** Numbers arrive as numbers, as `"12.34"`, and as `"3,334.34"`. All are real. */
export function asNumber(v: unknown): number | null {
  if (isFiniteNumber(v)) return v
  if (typeof v !== 'string') return null
  const cleaned = v.replace(/[\s, ]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '--') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

export function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' || t === '-' || t === '--' ? null : t
}

export function asBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    if (t === 'true' || t === 'yes' || t === '1') return true
    if (t === 'false' || t === 'no' || t === '0') return false
  }
  return null
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/**
 * Calendar fields read in the SAME frame the date was parsed in.
 *
 * `Date.parse('Aug 21, 2025')` is specified to read a non-ISO string in the HOST
 * timezone, so it lands on local midnight. Formatting that back through
 * `toISOString()` moves it a day west of UTC for every user east of Greenwich —
 * an ex-date of 2025-08-21 stored as 2025-08-20, which is enough to drop a
 * payment out of the trailing-12-month window.
 */
function localIsoDate(d: Date): ISODate | null {
  if (Number.isNaN(d.getTime())) return null
  const y = String(d.getFullYear()).padStart(4, '0')
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Accepts `YYYY-MM-DD[...]`, `M/D/YYYY` and epoch seconds/millis. */
export function asIsoDate(v: unknown): ISODate | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = Math.abs(v) < 1e11 ? v * 1000 : v
    // An epoch is an absolute instant, so UTC is the right frame — but a garbage
    // magnitude must degrade to null, not throw `RangeError` out of a parser.
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : toIsoDate(d)
  }
  const s = asString(v)
  if (!s) return null
  const iso = ISO_DATE.exec(s)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const us = US_DATE.exec(s)
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`
  const parsed = Date.parse(s)
  return Number.isNaN(parsed) ? null : localIsoDate(new Date(parsed))
}

const CURRENCY = /^[A-Z]{3}$/

export function asCurrency(v: unknown): Currency | null {
  const s = asString(v)
  if (!s) return null
  const up = s.toUpperCase()
  return CURRENCY.test(up) ? up : null
}

// ─────────────────────────────────────────────────────────────────────────────
// DATES & DIVIDEND STATS
// ─────────────────────────────────────────────────────────────────────────────

/** UTC, second precision, no zone suffix — matches the `ISODateTime` contract. */
export function toIsoDateTime(d: Date): ISODateTime {
  return d.toISOString().slice(0, 19)
}

export function toIsoDate(d: Date): ISODate {
  return d.toISOString().slice(0, 10)
}

function epochOf(date: ISODate): number | null {
  const m = ISO_DATE.exec(date)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

export function daysBetween(from: ISODate, to: ISODate): number | null {
  const a = epochOf(from)
  const b = epochOf(to)
  if (a === null || b === null) return null
  return (b - a) / 86_400_000
}

/**
 * Real payment schedules drift, so the median gap is the only stable estimator.
 *
 * Dates are de-duplicated first: a fund that posts two rows for one ex-date (an
 * ordinary and a special, or the same payment reported twice) would otherwise
 * contribute 0-day gaps that drag the median to 0 and destroy the frequency.
 */
export function medianGapDays(dates: ISODate[]): number | null {
  const stamps = [
    ...new Set(dates.map(epochOf).filter((n): n is number => n !== null)),
  ].sort((a, b) => a - b)
  if (stamps.length < 2) return null
  const gaps: number[] = []
  for (let i = 1; i < stamps.length; i += 1) {
    gaps.push((stamps[i]! - stamps[i - 1]!) / 86_400_000)
  }
  gaps.sort((a, b) => a - b)
  const mid = Math.floor(gaps.length / 2)
  return gaps.length % 2 === 1 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2
}

/** The only frequencies UCITS distributors actually use. Snapping suppresses the
 *  "28-day median gap → 13.04 payments a year" artefact. */
const PLAUSIBLE_FREQUENCIES = [1, 2, 4, 6, 12, 52]

export function frequencyFromExDates(exDates: ISODate[]): number | null {
  const gap = medianGapDays(exDates)
  if (gap === null || gap <= 0) return null
  const raw = 365.25 / gap
  let best = PLAUSIBLE_FREQUENCIES[0]!
  for (const f of PLAUSIBLE_FREQUENCIES) {
    if (Math.abs(Math.log(f / raw)) < Math.abs(Math.log(best / raw))) best = f
  }
  return best
}

/**
 * The one currency a mixed history should be reported in.
 *
 * Neither end of the sorted array is safe. `distributions[0]` is the OLDEST
 * payment, so a redenomination a decade ago wins forever; the last element is a
 * single trailing row whose currency we may simply have failed to identify. Either
 * mistake picks a currency that `ttmPerShare` then filters everything out of,
 * turning a paying fund into `ttmPerShare: null`. The modal currency is right in
 * both cases, with the most recent payment breaking a tie.
 */
export function dominantCurrency(
  distributions: readonly ProviderDistribution[],
): Currency | null {
  const counts = new Map<Currency, number>()
  const latest = new Map<Currency, ISODate>()
  for (const d of distributions) {
    const c = asCurrency(d?.currency)
    if (!c) continue
    counts.set(c, (counts.get(c) ?? 0) + 1)
    const exDate = typeof d.exDate === 'string' ? d.exDate : ''
    if (exDate > (latest.get(c) ?? '')) latest.set(c, exDate)
  }
  let best: Currency | null = null
  for (const [c, n] of counts) {
    if (best === null) {
      best = c
      continue
    }
    const bn = counts.get(best)!
    if (n > bn || (n === bn && (latest.get(c) ?? '') > (latest.get(best) ?? ''))) best = c
  }
  return best
}

/**
 * Trailing 12 months per share, ex-date bucketed.
 *
 * Ex-date, never pay-date: a December ex-date with a January pay date belongs to
 * the year it went ex, and crossing the two conventions double-counts it.
 * Currency-filtered because a fund can report the same payment in four currencies.
 */
export function ttmPerShare(
  distributions: ProviderDistribution[],
  asOf: ISODate,
  currency: Currency | null,
): number | null {
  const end = epochOf(asOf)
  if (end === null) return null
  const start = end - 365 * 86_400_000
  let total = 0
  let counted = 0
  for (const d of distributions) {
    if (currency && d.currency !== currency) continue
    const t = epochOf(d.exDate)
    if (t === null || t <= start || t > end) continue
    if (!isFiniteNumber(d.amount)) continue
    total += d.amount
    counted += 1
  }
  return counted === 0 ? null : total
}
