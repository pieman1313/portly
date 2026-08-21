import type { CashEvent, CashKind, Currency, ISODate } from '../domain/types'
import { asIndex, convert, daysBetween, type FxSource, toEpochDay } from './fx'
import { clamp, isZero, sum } from './money'

/**
 * Return measurement.
 *
 * Two numbers, and they answer different questions:
 *   TWR  — how did the INVESTMENTS do, ignoring when money arrived. Compare
 *          this to an index.
 *   XIRR — how did YOU do, including your timing. Compare this to a savings
 *          account.
 *
 * Both are meaningless until the portfolio boundary is fixed. Only deposits,
 * withdrawals and in-kind transfers are external. Buys, sells, dividends into
 * the cash balance, fees, taxes and FX conversions are INTERNAL and must never
 * appear in a flow vector — a "return" that jumps when you buy something is
 * always this bug.
 *
 * All returns are decimal fractions (0.0734 = 7.34%), never percentages.
 */

export interface CashFlow {
  date: ISODate
  /**
   * XIRR sign convention: money INTO the portfolio is negative, money OUT is
   * positive. Opening market value is an initial negative flow, closing market
   * value a final positive one.
   */
  amount: number
}

/** Positive = money entering the portfolio. Used by Dietz and TWR. */
export interface FlowPoint {
  date: ISODate
  amount: number
}

export interface ValuePoint {
  date: ISODate
  value: number
}

/**
 * Deposits and withdrawals only. In-kind transfers arrive from IBKR as
 * deposits/withdrawals too. 'OTHER' is deliberately treated as internal: it is
 * mostly corporate-action cash and misclassifying it as external silently
 * rewrites the return.
 */
export function isExternalFlow(kind: CashKind): boolean {
  return kind === 'DEPOSIT' || kind === 'WITHDRAWAL'
}

export interface ExternalFlowsResult {
  /** Positive = into the portfolio. Converted at each event's own date. */
  flows: FlowPoint[]
  /** Events that could not be converted. Returns must be suppressed if any. */
  missingFx: CashEvent[]
}

/**
 * Each flow converted at the rate ON ITS OWN DATE. Converting the whole series
 * at today's rate quietly turns FX drift into investment performance.
 */
export function externalFlows(
  events: readonly CashEvent[],
  base: Currency,
  rates: FxSource,
  opts: { maxStaleDays?: number } = {},
): ExternalFlowsResult {
  const flows: FlowPoint[] = []
  const missingFx: CashEvent[] = []
  const index = asIndex(rates)
  for (const e of events) {
    if (e.supersededAt !== null || !isExternalFlow(e.kind)) continue
    const amount = convert(e.amount, e.currency, base, e.date, index, {
      maxStaleDays: opts.maxStaleDays,
      via: base,
    })
    if (amount === null) missingFx.push(e)
    else flows.push({ date: e.date, amount })
  }
  return { flows, missingFx }
}

// ─────────────────────────────────────────────────────────────────────────────
// XIRR
// ─────────────────────────────────────────────────────────────────────────────

export interface XirrOptions {
  /**
   * Below this the annualization is nonsense — a 2% move over three days
   * annualizes to ~1000%. Parqet waits 90 days; so do we.
   */
  minDays?: number
  tolerance?: number
  maxIterations?: number
}

const RATE_LO = -0.9999
const RATE_HI = 10

/** Σ cf_i / (1+r)^((d_i − d_0)/365), act/365. */
export function xnpv(rate: number, flows: readonly CashFlow[]): number {
  const first = flows[0]
  if (first === undefined) return 0
  const terms = flows.map((f) => f.amount / Math.pow(1 + rate, daysBetween(first.date, f.date) / 365))
  return sum(terms)
}

/**
 * Bracketed bisection over [-0.9999, 10]. Deliberately NOT Newton: with
 * alternating flow signs the derivative flips and Newton diverges or lands on
 * a second root, and a wrong IRR looks entirely believable.
 *
 * Returns null instead of throwing whenever it cannot answer honestly: too
 * short a period, no sign change, or a flow vector with no solution.
 */
export function xirr(flows: readonly CashFlow[], opts: XirrOptions = {}): number | null {
  const minDays = opts.minDays ?? 90
  const tolerance = opts.tolerance ?? 1e-9
  const maxIterations = opts.maxIterations ?? 300

  const usable = flows
    .filter((f) => Number.isFinite(f.amount) && Number.isFinite(toEpochDay(f.date)))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  if (usable.length < 2) return null

  const first = usable[0]
  const last = usable[usable.length - 1]
  if (first === undefined || last === undefined) return null
  if (daysBetween(first.date, last.date) < minDays) return null

  // Without both signs there is no rate at all: you cannot earn a return on
  // money you never put in, or on money you never got back.
  const hasNegative = usable.some((f) => f.amount < 0)
  const hasPositive = usable.some((f) => f.amount > 0)
  if (!hasNegative || !hasPositive) return null

  let lo = RATE_LO
  let hi = RATE_HI
  let fLo = xnpv(lo, usable)
  let fHi = xnpv(hi, usable)
  if (!Number.isFinite(fLo) && !Number.isFinite(fHi)) return null
  if (Number.isNaN(fLo) || Number.isNaN(fHi)) return null
  if (fLo === 0) return lo
  if (fHi === 0) return hi
  if (Math.sign(fLo) === Math.sign(fHi)) return null

  for (let i = 0; i < maxIterations; i += 1) {
    const mid = (lo + hi) / 2
    const fMid = xnpv(mid, usable)
    if (Number.isNaN(fMid)) return null
    if (Math.abs(fMid) < tolerance || hi - lo < 1e-12) return mid
    if (Math.sign(fMid) === Math.sign(fLo)) {
      lo = mid
      fLo = fMid
    } else {
      hi = mid
      fHi = fMid
    }
  }
  const mid = (lo + hi) / 2
  return Number.isFinite(mid) ? mid : null
}

export interface PortfolioPeriod {
  start: ISODate
  end: ISODate
  /** Market value at `start`. Omitting it makes "IRR for 2025" meaningless. */
  valueStart: number
  /** Market value at `end`. XIRR has no solution without a terminal value. */
  valueEnd: number
  /** External flows only. Positive = money entering the portfolio. */
  contributions: readonly FlowPoint[]
}

/**
 * Build the XIRR flow vector with the signs the right way round. Use this
 * rather than assembling the vector by hand — the sign convention is inverted
 * relative to how deposits are stored, and that is where the bug always is.
 */
export function portfolioFlows(period: PortfolioPeriod): CashFlow[] {
  const flows: CashFlow[] = [{ date: period.start, amount: -period.valueStart }]
  for (const c of period.contributions) {
    if (c.date < period.start || c.date > period.end) continue
    flows.push({ date: c.date, amount: -c.amount })
  }
  flows.push({ date: period.end, amount: period.valueEnd })
  return flows
}

// ─────────────────────────────────────────────────────────────────────────────
// MODIFIED DIETZ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fallback when XIRR will not converge — no root-finding, always defined.
 * Sharesight uses it as its primary engine for exactly that reason.
 *
 * `flows` are external contributions, POSITIVE when money enters (the opposite
 * of the XIRR convention — Dietz's formula is written that way). `days` is the
 * length of the period. Without `start` the flows fall back to a half-period
 * weight, which is Simple Dietz; that is a documented method, not a guess.
 *
 * Returns a period return, never annualized. Annualize outside, and only past
 * a year.
 */
export function modifiedDietz(
  valueBegin: number,
  valueEnd: number,
  flows: readonly FlowPoint[],
  days: number,
  start?: ISODate,
): number | null {
  if (!Number.isFinite(valueBegin) || !Number.isFinite(valueEnd)) return null
  if (!Number.isFinite(days) || days <= 0) return null
  const net = sum(flows.map((f) => f.amount))
  const weighted = sum(
    flows.map((f) => {
      const elapsed = start === undefined ? days / 2 : daysBetween(start, f.date)
      const weight = (days - elapsed) / days
      return f.amount * clamp(weight, 0, 1)
    }),
  )
  const denominator = valueBegin + weighted
  if (isZero(denominator, 1e-9) || !Number.isFinite(denominator)) return null
  const r = (valueEnd - valueBegin - net) / denominator
  // An unparseable `start` makes every weight NaN. Say "unavailable" rather
  // than handing a NaN to a caller that will render it as a return.
  return Number.isFinite(r) ? r : null
}

/** Only past a year. `(1+r)^(365/21)` on a 3-week 4% gain claims +95% p.a. */
export function annualize(periodReturn: number, days: number): number | null {
  // `NaN < 365` is false, so an unmeasurable period used to sail past this
  // guard and come back as a NaN annualized return.
  if (!Number.isFinite(days) || days < 365) return null
  if (!Number.isFinite(periodReturn) || periodReturn <= -1) return null
  const r = Math.pow(1 + periodReturn, 365 / days) - 1
  return Number.isFinite(r) ? r : null
}

// ─────────────────────────────────────────────────────────────────────────────
// TIME-WEIGHTED RETURN
// ─────────────────────────────────────────────────────────────────────────────

export interface IndexPoint {
  date: ISODate
  /** TWR index, base 100 on the first day. */
  index: number
}

export interface TwrResult {
  cumulative: number | null
  /** Null under a year — annualizing a short period is a lie, not a rounding. */
  annualized: number | null
  days: number
  index: IndexPoint[]
  /** Days whose denominator was zero: the chain restarted there. */
  restarts: ISODate[]
}

/**
 * Daily-chained true TWR.
 *
 *   r_t = (V_t + outflow_t) / (V_{t−1} + inflow_t) − 1
 *
 * Inflows are treated as arriving at the START of the day (they belong in the
 * denominator, the money was investable all day); outflows at the END (added
 * back to the numerator, they were invested all day). That is Portfolio
 * Performance's convention and it is the right one.
 *
 * `V_t` MUST include cash. With cash inside the boundary a buy moves value
 * between sleeves and contributes nothing, which is exactly right; with cash
 * outside it, every buy becomes a flow and the number falls apart. Dividends
 * land in cash and so lift `V_t` on their own — if your valuation drops them,
 * TWR under-reports by precisely the dividend yield.
 *
 * `dailyValues[0]` is the OPENING value; any flow dated on that day is assumed
 * already reflected in it.
 */
export function twr(
  dailyValues: readonly ValuePoint[],
  dailyFlows: readonly FlowPoint[] = [],
): TwrResult {
  const points = [...dailyValues].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const first = points[0]
  const last = points[points.length - 1]
  if (first === undefined || last === undefined || points.length < 2) {
    return {
      cumulative: null,
      annualized: null,
      days: 0,
      index: first ? [{ date: first.date, index: 100 }] : [],
      restarts: [],
    }
  }

  // Attribute every flow to the first valuation on or after its own date.
  // Keying the maps on the flow's raw date drops anything that landed on a day
  // the series has no value for — a weekend deposit, a bank holiday
  // withdrawal, a month-end-only valuation series — and a dropped inflow is
  // indistinguishable from a gain of exactly that size.
  const dates = points.map((p) => p.date)
  const alignTo = (date: ISODate): ISODate | null => {
    let lo = 0
    let hi = dates.length - 1
    let found: ISODate | null = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const d = dates[mid]
      if (d === undefined) break
      if (d >= date) {
        found = d
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }
    return found
  }

  const inflow = new Map<ISODate, number>()
  const outflow = new Map<ISODate, number>()
  for (const f of dailyFlows) {
    if (!Number.isFinite(f.amount) || f.amount === 0) continue
    // Later than the last valuation: outside the measured window entirely.
    const at = alignTo(f.date)
    if (at === null) continue
    if (f.amount > 0) inflow.set(at, (inflow.get(at) ?? 0) + f.amount)
    else outflow.set(at, (outflow.get(at) ?? 0) - f.amount)
  }

  const index: IndexPoint[] = [{ date: first.date, index: 100 }]
  const restarts: ISODate[] = []
  let level = 1

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]
    const cur = points[i]
    if (prev === undefined || cur === undefined) continue
    const inFlow = inflow.get(cur.date) ?? 0
    const outFlow = outflow.get(cur.date) ?? 0
    const denominator = prev.value + inFlow
    if (isZero(denominator, 1e-9)) {
      // Portfolio emptied and refunded: r_t explodes. Restart the chain
      // instead of multiplying by a meaningless number.
      restarts.push(cur.date)
      index.push({ date: cur.date, index: level * 100 })
      continue
    }
    const r = (cur.value + outFlow) / denominator - 1
    level *= 1 + r
    index.push({ date: cur.date, index: level * 100 })
  }

  const days = daysBetween(first.date, last.date)
  const cumulative = level - 1
  return {
    cumulative,
    annualized: annualize(cumulative, days),
    days,
    index,
    restarts,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DRAWDOWN
// ─────────────────────────────────────────────────────────────────────────────

export interface DrawdownEpisode {
  peakDate: ISODate
  peakIndex: number
  troughDate: ISODate
  troughIndex: number
  /** Negative fraction: −0.234 is a 23.4% drawdown. */
  depth: number
  /** Null while still under water. */
  recoveryDate: ISODate | null
  /** Peak to RECOVERY, not peak to trough. Null while still under water. */
  durationDays: number | null
  ongoing: boolean
}

export interface DrawdownResult {
  /** Depth of the deepest episode; 0 when the series only ever rose. */
  depth: number
  worst: DrawdownEpisode | null
  /** Not always the deepest one — the longest underwater run is its own stat. */
  longest: DrawdownEpisode | null
  episodes: DrawdownEpisode[]
}

/**
 * Max drawdown on the TWR INDEX, never on raw portfolio value: withdrawing
 * half your portfolio is not a 50% drawdown, and computing on value says it is.
 */
export function maxDrawdown(series: readonly IndexPoint[]): DrawdownResult {
  const episodes: DrawdownEpisode[] = []
  let peak: IndexPoint | null = null
  let current: DrawdownEpisode | null = null

  for (const point of series) {
    if (!Number.isFinite(point.index)) continue
    if (peak === null || point.index >= peak.index) {
      if (current !== null) {
        current.recoveryDate = point.date
        current.durationDays = daysBetween(current.peakDate, point.date)
        current.ongoing = false
        episodes.push(current)
        current = null
      }
      peak = point
      continue
    }
    const depth = point.index / peak.index - 1
    if (current === null) {
      current = {
        peakDate: peak.date,
        peakIndex: peak.index,
        troughDate: point.date,
        troughIndex: point.index,
        depth,
        recoveryDate: null,
        durationDays: null,
        ongoing: true,
      }
    } else if (depth < current.depth) {
      current.depth = depth
      current.troughDate = point.date
      current.troughIndex = point.index
    }
  }
  if (current !== null) episodes.push(current)

  const worst = episodes.reduce<DrawdownEpisode | null>(
    (acc, e) => (acc === null || e.depth < acc.depth ? e : acc),
    null,
  )
  const lastPoint = series[series.length - 1]
  const longest = episodes.reduce<DrawdownEpisode | null>((acc, e) => {
    const span = e.durationDays ?? (lastPoint ? daysBetween(e.peakDate, lastPoint.date) : 0)
    const accSpan =
      acc === null ? -1 : (acc.durationDays ?? (lastPoint ? daysBetween(acc.peakDate, lastPoint.date) : 0))
    return span > accSpan ? e : acc
  }, null)

  return { depth: worst?.depth ?? 0, worst, longest, episodes }
}
