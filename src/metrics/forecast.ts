import type { Accrual, Currency, DividendProfile, ISODate } from '../domain/types'
import {
  addDays,
  addMonths,
  asIndex,
  convert,
  firstOfMonth,
  type FxSource,
  isValidISODate,
  monthKey,
  monthOfYear,
  monthsBetween,
} from './fx'
import type { Holding } from './holdings'
import type { ForwardIncome } from './income'
import { EPS_QTY, isZero, sum } from './money'

/**
 * Twelve months of forward income.
 *
 * Two sources, never mixed:
 *
 *   DECLARED  — open dividend accruals. Exact to the cent, but IBKR only posts
 *               an accrual at ex-date minus one day, so a CSV gives roughly
 *               four weeks of real visibility. Everything past that is
 *               necessarily an estimate.
 *   ESTIMATED — the provider's trailing-12-month per-share amount times the
 *               current quantity, laid out across the months the instrument
 *               HISTORICALLY paid in.
 *
 * The seasonality part is not a nicety. UCITS distributions are violently
 * seasonal — one holding's June payment can be 60% of its annual total — so
 * both classic shortcuts are wrong in the same direction:
 *   - TTM / 12 into every month smears a June payment across the year and
 *     makes any month-level chart fiction;
 *   - last payment x frequency was measured 17-49% low on real ETFs, because
 *     the last payment was one of the small ones.
 * Weighting the TTM total by each month's observed share of it keeps the
 * annual figure exact AND the monthly shape right.
 */

/**
 * Below this, a declared accrual is rounding residue rather than a payment.
 * In the accrual's own currency, so it does not drift with the base rate.
 */
const FORECAST_MIN = 0.02

export type ForecastBasis = 'declared' | 'estimated'

export interface ForecastItem {
  instrumentKey: string
  symbol: string
  /** 'YYYY-MM' */
  month: string
  basis: ForecastBasis
  /** Known for declared accruals only. */
  payDate: ISODate | null
  exDate: ISODate | null
  quantity: number
  perShare: number | null
  currency: Currency
  gross: number
  tax: number
  net: number
  /** Null when no FX rate to base exists — the UI must show "unavailable". */
  grossBase: number | null
  netBase: number | null
}

export interface ForecastMonth {
  /** 'YYYY-MM' */
  month: string
  start: ISODate
  items: ForecastItem[]
  grossBase: number
  netBase: number
  declaredBase: number
  estimatedBase: number
}

export interface ForecastCoverage {
  /** Open positions considered. */
  positions: number
  /** Positions with usable provider seasonality. */
  estimated: number
  /** Positions visible only through an accrual — about four weeks of horizon. */
  declaredOnly: string[]
  /** Positions with neither provider data nor an accrual: absent from the total. */
  missing: string[]
  /** Positions whose seasonality came from a window older than 12 months. */
  staleHistory: string[]
  /** Items that could not be converted to base currency. */
  missingFx: string[]
  /** estimated / positions, 0..1. Zero means "declared only — say so". */
  ratio: number
}

export interface Forecast {
  /** 1st of the current month. Anchoring here keeps the number stable within a month. */
  anchor: ISODate
  /** Inclusive last day of the 12th month. */
  end: ISODate
  baseCurrency: Currency
  net: boolean
  months: ForecastMonth[]
  totalGrossBase: number
  totalNetBase: number
  /** `totalNetBase` or `totalGrossBase`, per the toggle. */
  totalBase: number
  coverage: ForecastCoverage
}

export interface ForecastOptions {
  net?: boolean
  /**
   * instrumentKey -> withholding actually suffered, from
   * `income.withholdingRateByInstrument`. No assumed 15%/30% anywhere.
   */
  withholdingRates?: ReadonlyMap<string, number>
  maxStaleDays?: number
  /** Count provider projections as history too. Off: they are not observations. */
  includeProjected?: boolean
}

export interface Seasonality {
  /** month-of-year (1..12) -> share of the annual total. Sums to 1. */
  weights: Map<number, number>
  /** Per-share total over the observed 12-month window. */
  perShareTotal: number
  currency: Currency | null
  /** Median whole months from ex-date to pay date. */
  lagMonths: number
  payments: number
  /** The window ended more than a year ago — the provider data is stale. */
  stale: boolean
}

function median(ns: readonly number[]): number {
  if (ns.length === 0) return 0
  const sorted = [...ns].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/**
 * Which months an instrument pays in, and how much of the year lands in each.
 *
 * Uses the trailing 12 months of ex-dates; if the provider's history stops
 * earlier, the last 12 months it does have, flagged stale. Ex-dates are the
 * entitlement calendar, so they are what carries the seasonality; the pay
 * calendar is derived from them with the observed ex-to-pay lag, because the
 * forecast is a cash-flow view.
 */
export function seasonality(
  profile: DividendProfile,
  asOf: ISODate,
  opts: { includeProjected?: boolean } = {},
): Seasonality | null {
  const observed = profile.distributions.filter((d) =>
    (opts.includeProjected ?? false) ? true : d.declared,
  )
  if (observed.length === 0) return null

  const latest = observed.reduce((acc, d) => (d.exDate > acc ? d.exDate : acc), observed[0]?.exDate ?? asOf)
  const anchorEnd = latest > asOf ? asOf : latest
  const windowEnd = asOf
  let from = addDays(windowEnd, -365)
  let inWindow = observed.filter((d) => d.exDate > from && d.exDate <= windowEnd)
  let stale = false
  if (inWindow.length === 0) {
    from = addDays(anchorEnd, -365)
    inWindow = observed.filter((d) => d.exDate > from && d.exDate <= anchorEnd)
    stale = true
  }
  if (inWindow.length === 0) return null

  const perShareTotal = sum(inWindow.map((d) => d.amount))
  if (isZero(perShareTotal, 1e-12)) return null

  const weights = new Map<number, number>()
  for (const d of inWindow) {
    const m = monthOfYear(d.exDate)
    weights.set(m, (weights.get(m) ?? 0) + d.amount / perShareTotal)
  }
  const lags = inWindow
    .filter((d) => d.payDate !== null)
    .map((d) => monthsBetween(d.exDate, d.payDate ?? d.exDate))
    .filter((n) => n >= 0 && n <= 6)
  return {
    weights,
    perShareTotal,
    currency: profile.currency,
    lagMonths: Math.round(median(lags)),
    payments: inWindow.length,
    stale,
  }
}

/**
 * Twelve monthly buckets of expected income, from the 1st of the current month.
 *
 * Declared accruals win: wherever one exists for an instrument-month, the
 * estimate for that same instrument-month is suppressed, so nothing is ever
 * counted twice.
 */
export function project12Months(
  holdings: readonly Holding[],
  accruals: readonly Accrual[],
  profiles: readonly DividendProfile[],
  base: Currency,
  rates: FxSource,
  today: ISODate,
  opts: ForecastOptions = {},
): Forecast {
  const anchor = firstOfMonth(today)
  const end = addDays(addMonths(anchor, 12), -1)
  const wantNet = opts.net ?? false
  const fxOpts = { maxStaleDays: opts.maxStaleDays, via: base }
  const index = asIndex(rates)

  const months: ForecastMonth[] = []
  const indexOfMonth = new Map<string, number>()
  for (let i = 0; i < 12; i += 1) {
    const start = addMonths(anchor, i)
    months.push({
      month: monthKey(start),
      start,
      items: [],
      grossBase: 0,
      netBase: 0,
      declaredBase: 0,
      estimatedBase: 0,
    })
    indexOfMonth.set(monthKey(start), i)
  }

  const profileByKey = new Map(profiles.map((p) => [p.instrumentKey, p]))
  const open = holdings.filter((h) => !h.excluded && h.quantity > EPS_QTY)
  const symbolOf = new Map(holdings.map((h) => [h.instrumentKey, h.symbol]))
  // An instrument the user switched off must not contribute income either.
  // `income.yields` drops it from every denominator, so leaving its accrual in
  // the numerator invents yield out of nothing.
  const excluded = new Set(holdings.filter((h) => h.excluded).map((h) => h.instrumentKey))
  const missingFx: string[] = []

  // ── Declared ───────────────────────────────────────────────────────────────
  const declaredSlots = new Set<string>()
  const declaredExMonths = new Set<string>()
  const withAccrual = new Set<string>()
  for (const a of accruals) {
    if (a.supersededAt !== null || !a.open) continue
    if (excluded.has(a.instrumentKey)) continue
    if (a.payDate < anchor || a.payDate > end) continue
    // Rounding residue is not forward income. `Accrual.open` is an accounting
    // fact and deliberately keeps the cent that a restated Po/Re pair leaves
    // behind, because IBKR's own Ending Dividend Accruals counts it and the
    // reconciliation would otherwise disagree with the broker. A forecast is a
    // different question, and answering it with "August: -$0.01" is worse than
    // saying nothing. Presentation filters; the ledger does not.
    if (Math.abs(a.net) < FORECAST_MIN && Math.abs(a.gross) < FORECAST_MIN) continue
    const slot = indexOfMonth.get(monthKey(a.payDate))
    const bucket = slot === undefined ? undefined : months[slot]
    if (bucket === undefined) continue
    const grossBase = convert(a.gross, a.currency, base, today, index, fxOpts)
    const netBase = convert(a.net, a.currency, base, today, index, fxOpts)
    if (grossBase === null || netBase === null) missingFx.push(a.instrumentKey)
    const item: ForecastItem = {
      instrumentKey: a.instrumentKey,
      symbol: symbolOf.get(a.instrumentKey) ?? a.instrumentKey,
      month: bucket.month,
      basis: 'declared',
      payDate: a.payDate,
      exDate: a.exDate,
      quantity: a.quantity,
      perShare: a.grossRate,
      currency: a.currency,
      gross: a.gross,
      tax: a.tax,
      net: a.net,
      grossBase,
      netBase,
    }
    bucket.items.push(item)
    declaredSlots.add(`${a.instrumentKey}|${bucket.month}`)
    // Also key on the ex-month. The estimate's pay month is the ex month plus
    // a MEDIAN lag, so a payment that historically went ex late in the month
    // and paid the same month can be modelled one bucket away from where the
    // real accrual landed — and a pay-month-only guard then counts it twice.
    if (isValidISODate(a.exDate)) {
      declaredExMonths.add(`${a.instrumentKey}|${monthOfYear(a.exDate)}`)
    }
    withAccrual.add(a.instrumentKey)
  }

  // ── Estimated ──────────────────────────────────────────────────────────────
  const declaredOnly: string[] = []
  const missing: string[] = []
  const staleHistory: string[] = []
  let estimatedPositions = 0

  for (const holding of open) {
    const profile = profileByKey.get(holding.instrumentKey) ?? null
    const shape = profile === null ? null : seasonality(profile, today, opts)
    if (shape === null || profile === null) {
      if (withAccrual.has(holding.instrumentKey)) declaredOnly.push(holding.instrumentKey)
      else if (profile === null || profile.isDistributing) missing.push(holding.instrumentKey)
      continue
    }
    if (!profile.isDistributing) continue
    estimatedPositions += 1
    if (shape.stale) staleHistory.push(holding.instrumentKey)

    const currency =
      shape.currency ?? holding.instrument?.divCurrency ?? holding.instrument?.tradeCurrency ?? holding.currency
    const withholding = opts.withholdingRates?.get(holding.instrumentKey) ?? 0

    for (const [exMonth, weight] of shape.weights) {
      if (weight <= 0) continue
      const payMonthOfYear = ((exMonth - 1 + shape.lagMonths) % 12) + 1
      const offset = (payMonthOfYear - monthOfYear(anchor) + 12) % 12
      const bucket = months[offset]
      if (bucket === undefined) continue
      if (declaredSlots.has(`${holding.instrumentKey}|${bucket.month}`)) continue
      if (declaredExMonths.has(`${holding.instrumentKey}|${exMonth}`)) continue

      const perShare = shape.perShareTotal * weight
      const gross = perShare * holding.quantity
      const tax = gross * withholding
      const grossBase = convert(gross, currency, base, today, index, fxOpts)
      const netBase = convert(gross - tax, currency, base, today, index, fxOpts)
      if (grossBase === null || netBase === null) missingFx.push(holding.instrumentKey)
      bucket.items.push({
        instrumentKey: holding.instrumentKey,
        symbol: holding.symbol,
        month: bucket.month,
        basis: 'estimated',
        payDate: null,
        exDate: null,
        quantity: holding.quantity,
        perShare,
        currency,
        gross,
        tax,
        net: gross - tax,
        grossBase,
        netBase,
      })
    }
  }

  for (const bucket of months) {
    bucket.grossBase = sum(bucket.items.map((i) => i.grossBase ?? 0))
    bucket.netBase = sum(bucket.items.map((i) => i.netBase ?? 0))
    bucket.declaredBase = sum(
      bucket.items.filter((i) => i.basis === 'declared').map((i) => (wantNet ? i.netBase : i.grossBase) ?? 0),
    )
    bucket.estimatedBase = sum(
      bucket.items.filter((i) => i.basis === 'estimated').map((i) => (wantNet ? i.netBase : i.grossBase) ?? 0),
    )
    bucket.items.sort((a, b) => (b.grossBase ?? 0) - (a.grossBase ?? 0))
  }

  const totalGrossBase = sum(months.map((m) => m.grossBase))
  const totalNetBase = sum(months.map((m) => m.netBase))
  return {
    anchor,
    end,
    baseCurrency: base,
    net: wantNet,
    months,
    totalGrossBase,
    totalNetBase,
    totalBase: wantNet ? totalNetBase : totalGrossBase,
    coverage: {
      positions: open.length,
      estimated: estimatedPositions,
      declaredOnly,
      missing,
      staleHistory,
      missingFx: [...new Set(missingFx)],
      ratio: open.length === 0 ? 0 : estimatedPositions / open.length,
    },
  }
}

/** Adapter for `income.yields` — the denominators live there, the numerator here. */
export function forwardIncome(forecast: Forecast): ForwardIncome {
  const byInstrument: Record<string, number> = {}
  for (const month of forecast.months) {
    for (const item of month.items) {
      const value = (forecast.net ? item.netBase : item.grossBase) ?? 0
      byInstrument[item.instrumentKey] = (byInstrument[item.instrumentKey] ?? 0) + value
    }
  }
  return {
    totalBase: forecast.totalBase,
    byInstrument,
    net: forecast.net,
    anchor: forecast.anchor,
  }
}
