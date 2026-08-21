import type {
  Currency,
  Distribution,
  DividendProfile,
  Instrument,
  InstrumentOverride,
  ISODate,
} from '../domain/types'
import {
  addDays,
  addMonths,
  asIndex,
  convert,
  type FxSource,
  isValidISODate,
  monthKey,
  quarterKey,
  yearKey,
} from './fx'
import type { Holding } from './holdings'
import { pct, ratio, sum } from './money'

/**
 * Dividend income — what actually arrived.
 *
 * The one rule that governs this whole file: DO NOT CROSS THE TWO DATE
 * CONVENTIONS. Cash-flow views (calendars, monthly charts, payment matrices)
 * bucket by PAY date. Entitlement views (TTM per share, yields) bucket by EX
 * date. A December ex-date with a January pay date gets counted twice or not
 * at all the moment those two mix.
 *
 * Gross/net uses the withholding ACTUALLY on the statement, never an assumed
 * 15%/30%. IBKR reports the real number per payment and it varies by domicile,
 * treaty status and, occasionally, by IBKR restating it a month later.
 */

export type Period = 'month' | 'quarter' | 'year'

export interface PeriodBucket {
  /** 'YYYY-MM' | 'YYYY-Qn' | 'YYYY' */
  key: string
  start: ISODate
  /** Inclusive. */
  end: ISODate
  gross: number
  tax: number
  net: number
  /** `net` or `gross` per the toggle — what the chart plots. */
  amount: number
  count: number
  /** Payments dropped for want of an FX rate. The bucket is incomplete. */
  missingFx: number
}

export interface IncomeOptions {
  /** Show net of withholding. Defaults to gross. */
  net?: boolean
  /**
   * Drop return-of-capital, payment-in-lieu and one-off specials. On by
   * default: a special makes TTM yield spike and then look like a cut a year
   * later.
   */
  regularOnly?: boolean
  from?: ISODate
  to?: ISODate
  maxStaleDays?: number
}

const IRREGULAR = /return of capital|payment in lieu|special/i

/** Ordinary and mixed-income distributions count; capital returns do not. */
export function isRegular(divType: string | null, description?: string): boolean {
  if (divType !== null && divType !== undefined && IRREGULAR.test(divType)) return false
  if (description !== undefined && IRREGULAR.test(description)) return false
  return true
}

function usable(d: Distribution, opts: IncomeOptions): boolean {
  if (d.supersededAt !== null) return false
  // A pay date that is not a real date cannot be bucketed, and letting it into
  // the bucket loop below spins that loop until it exhausts memory.
  if (!isValidISODate(d.payDate)) return false
  if ((opts.regularOnly ?? true) && !isRegular(d.divType, d.description)) return false
  return true
}

/**
 * The payments any cash-flow view is allowed to see: live, bucketable, regular
 * unless asked otherwise, and inside the window. Shared so the chart, the
 * stacked chart and the matrix can never disagree about which rows exist.
 */
function selectRows(dists: readonly Distribution[], opts: IncomeOptions): Distribution[] {
  return dists.filter((d) => {
    if (!usable(d, opts)) return false
    if (opts.from !== undefined && d.payDate < opts.from) return false
    if (opts.to !== undefined && d.payDate > opts.to) return false
    return true
  })
}

/**
 * One instrument, one group.
 *
 * IBKR matches some dividend lines to an instrument and leaves others carrying
 * only the ISIN, and grouping on whichever happened to be filled in splits a
 * single holding into two half-populated series. `unmatched` is the sentinel
 * for a payment with neither.
 */
function instrumentGrouper(
  rows: readonly Distribution[],
  unmatched: string,
): (d: Distribution) => string {
  const keyOfIsin = new Map<string, string>()
  for (const d of rows) {
    if (d.instrumentKey !== null && d.isin !== null && !keyOfIsin.has(d.isin)) {
      keyOfIsin.set(d.isin, d.instrumentKey)
    }
  }
  return (d) => d.instrumentKey ?? (d.isin === null ? unmatched : keyOfIsin.get(d.isin) ?? d.isin)
}

function periodKey(date: ISODate, period: Period): string {
  return period === 'month' ? monthKey(date) : period === 'quarter' ? quarterKey(date) : yearKey(date)
}

function periodStart(date: ISODate, period: Period): ISODate {
  if (period === 'year') return `${date.slice(0, 4)}-01-01`
  if (period === 'quarter') {
    const q = Math.floor((Number(date.slice(5, 7)) - 1) / 3) * 3 + 1
    return `${date.slice(0, 4)}-${String(q).padStart(2, '0')}-01`
  }
  return `${date.slice(0, 7)}-01`
}

function periodStep(period: Period): number {
  return period === 'month' ? 1 : period === 'quarter' ? 3 : 12
}

function emptyBucket(start: ISODate, period: Period): PeriodBucket {
  return {
    key: periodKey(start, period),
    start,
    end: addDays(addMonths(start, periodStep(period)), -1),
    gross: 0,
    tax: 0,
    net: 0,
    amount: 0,
    count: 0,
    missingFx: 0,
  }
}

/**
 * The bucketing, FX and net/gross core. Every dividend cash-flow chart in the
 * app runs through this one loop; `onPayment` is how a caller layers a
 * breakdown on top without a second, drifting copy of the arithmetic.
 *
 * `onPayment` fires only for payments that converted. The bucket objects it
 * receives are the very ones returned, so a caller may key a side table off
 * them — but `amount` is not settled until the loop ends, so read it from the
 * returned array, never from inside the callback.
 */
function bucketDividends(
  rows: readonly Distribution[],
  period: Period,
  base: Currency,
  rates: FxSource,
  opts: IncomeOptions,
  onPayment?: (bucket: PeriodBucket, d: Distribution, gross: number, tax: number) => void,
): PeriodBucket[] {
  if (rows.length === 0) return []

  const dates = rows.map((d) => d.payDate).sort()
  const from = isValidISODate(opts.from) ? opts.from : undefined
  const to = isValidISODate(opts.to) ? opts.to : undefined
  const firstDate = from ?? dates[0] ?? ''
  const lastDate = to ?? dates[dates.length - 1] ?? firstDate
  if (!isValidISODate(firstDate) || !isValidISODate(lastDate)) return []

  const index = asIndex(rates)
  const buckets = new Map<string, PeriodBucket>()
  const order: string[] = []
  for (
    let cursor = periodStart(firstDate, period);
    isValidISODate(cursor) && cursor <= lastDate;
    cursor = addMonths(cursor, periodStep(period))
  ) {
    const bucket = emptyBucket(cursor, period)
    buckets.set(bucket.key, bucket)
    order.push(bucket.key)
  }

  const wantNet = opts.net ?? false
  for (const d of rows) {
    const bucket = buckets.get(periodKey(d.payDate, period))
    if (bucket === undefined) continue
    // Gross and tax converted at the SAME rate — the pay-date rate. Using two
    // different rates for the two halves of one payment is a real shipped bug.
    const gross = convert(d.gross, d.currency, base, d.payDate, index, {
      maxStaleDays: opts.maxStaleDays,
      via: base,
    })
    const tax = convert(d.tax, d.currency, base, d.payDate, index, {
      maxStaleDays: opts.maxStaleDays,
      via: base,
    })
    if (gross === null || tax === null) {
      bucket.missingFx += 1
      continue
    }
    bucket.gross += gross
    bucket.tax += tax
    bucket.net += gross - tax
    bucket.count += 1
    onPayment?.(bucket, d, gross, tax)
  }
  for (const key of order) {
    const bucket = buckets.get(key)
    if (bucket) bucket.amount = wantNet ? bucket.net : bucket.gross
  }
  return order.map((k) => buckets.get(k)).filter((b): b is PeriodBucket => b !== undefined)
}

/**
 * Received dividends bucketed by PAY date — the cash-flow view. Buckets are
 * dense: an empty month between two payments is a zero bar, not a gap in the
 * x-axis.
 */
export function dividendsByPeriod(
  dists: readonly Distribution[],
  period: Period,
  base: Currency,
  rates: FxSource,
  opts: IncomeOptions = {},
): PeriodBucket[] {
  return bucketDividends(selectRows(dists, opts), period, base, rates, opts)
}

/** Group key for a payment IBKR never matched to an instrument or an ISIN. */
export const UNATTRIBUTED = '__unknown'
/** Display label for {@link UNATTRIBUTED}. Not a ticker, so not a symbol. */
export const UNATTRIBUTED_LABEL = 'Unattributed'

/**
 * instrumentKey -> ticker to print, with the user's rename applied.
 *
 * Same precedence as `buildHoldings`: an override the user set wins, then the
 * instrument's own most-recent symbol. Display only — identity, dedupe and
 * every lookup still go through instrumentKey.
 */
export function displaySymbols(
  instruments: readonly Instrument[],
  overrides: readonly InstrumentOverride[] = [],
): Map<string, string> {
  const symbols = new Map<string, string>()
  for (const i of instruments) symbols.set(i.key, i.symbol)
  for (const o of overrides) {
    if (o.displaySymbol !== null && o.displaySymbol !== undefined && o.displaySymbol !== '') {
      symbols.set(o.instrumentKey, o.displaySymbol)
    }
  }
  return symbols
}

/**
 * Ticker for a key produced by {@link dividendsByPeriodGrouped}.
 *
 * Lives beside the sentinel it has to recognise rather than being copied into
 * each screen that stacks these buckets. The raw key is the fallback, because a
 * payment matched only by an ISIN should still name something the user can look
 * up rather than read as another "Unattributed".
 */
export function instrumentLabel(key: string, symbols: ReadonlyMap<string, string>): string {
  if (key === UNATTRIBUTED) return UNATTRIBUTED_LABEL
  const symbol = symbols.get(key)
  return symbol === undefined || symbol === '' ? key : symbol
}

export interface GroupedPeriodBucket extends PeriodBucket {
  /**
   * instrumentKey -> amount in base, on the SAME net/gross basis as `amount`,
   * so the parts always sum to the bar. Only contributors present in the
   * bucket appear; there is no zero-filling.
   */
  byInstrument: Record<string, number>
}

export interface GroupedIncome {
  buckets: GroupedPeriodBucket[]
  /**
   * instrumentKeys ordered by total contribution, descending — the colour
   * order. It spans the whole window, not one bucket, so a stack segment keeps
   * its hue as the period toggle reshapes the bars. Ties break on the key so
   * two holdings that paid the same never swap.
   */
  order: string[]
  /** instrumentKey -> contribution over the whole window, same basis again. */
  totals: Record<string, number>
}

/**
 * `dividendsByPeriod` with the per-holding split kept rather than summed away.
 *
 * Identical bucketing, FX, net/gross and `regularOnly` handling — it is the
 * same loop, called with a collector. A payment that could not be converted
 * counts towards `missingFx` and contributes to no holding, exactly as before:
 * the bar and its segments are understated together rather than the segments
 * disagreeing with the total.
 */
export function dividendsByPeriodGrouped(
  dists: readonly Distribution[],
  period: Period,
  base: Currency,
  rates: FxSource,
  opts: IncomeOptions = {},
): GroupedIncome {
  const rows = selectRows(dists, opts)
  const groupOf = instrumentGrouper(rows, UNATTRIBUTED)
  const wantNet = opts.net ?? false

  const totals = new Map<string, number>()
  const splits = new Map<PeriodBucket, Record<string, number>>()

  const buckets = bucketDividends(rows, period, base, rates, opts, (bucket, d, gross, tax) => {
    const value = wantNet ? gross - tax : gross
    const key = groupOf(d)
    let split = splits.get(bucket)
    if (split === undefined) {
      split = {}
      splits.set(bucket, split)
    }
    split[key] = (split[key] ?? 0) + value
    totals.set(key, (totals.get(key) ?? 0) + value)
  })

  const order = [...totals.keys()].sort(
    (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b),
  )

  return {
    buckets: buckets.map((b) => ({ ...b, byInstrument: splits.get(b) ?? {} })),
    order,
    totals: Object.fromEntries(totals),
  }
}

export interface MatrixRow {
  instrumentKey: string | null
  label: string
  /** One cell per month in `months`, same order. */
  cells: number[]
  total: number
}

export interface PaymentsMatrix {
  /** 'YYYY-MM', ascending, dense. */
  months: string[]
  rows: MatrixRow[]
  columnTotals: number[]
  grandTotal: number
  missingFx: number
}

export interface MatrixOptions extends IncomeOptions {
  /** instrumentKey -> display label. Falls back to the key. */
  labels?: Readonly<Record<string, string>>
}

/**
 * Holdings x months pivot with row and column totals — Portfolio Performance's
 * "Payments" view. Bucketed by PAY date, like every other cash-flow view.
 */
export function paymentsMatrix(
  dists: readonly Distribution[],
  base: Currency,
  rates: FxSource,
  opts: MatrixOptions = {},
): PaymentsMatrix {
  const rows = selectRows(dists, opts)
  const dates = rows.map((d) => d.payDate).sort()
  const from = isValidISODate(opts.from) ? opts.from : undefined
  const to = isValidISODate(opts.to) ? opts.to : undefined
  const firstDate = from ?? dates[0]
  const lastDate = to ?? dates[dates.length - 1]
  if (!isValidISODate(firstDate) || !isValidISODate(lastDate)) {
    return { months: [], rows: [], columnTotals: [], grandTotal: 0, missingFx: 0 }
  }

  const months: string[] = []
  for (
    let cursor = `${firstDate.slice(0, 7)}-01`;
    isValidISODate(cursor) && cursor.slice(0, 7) <= lastDate.slice(0, 7);
    cursor = addMonths(cursor, 1)
  ) {
    months.push(monthKey(cursor))
  }
  const columnOf = new Map(months.map((m, i) => [m, i]))

  // One instrument, one row. The matrix keeps its own '(unmatched)' sentinel
  // because that string is the row's printed label; the charts use
  // UNATTRIBUTED and label it themselves.
  const groupKey = instrumentGrouper(rows, '(unmatched)')

  const index = asIndex(rates)
  const wantNet = opts.net ?? false
  const byInstrument = new Map<string, MatrixRow>()
  let missingFx = 0

  for (const d of rows) {
    const column = columnOf.get(monthKey(d.payDate))
    if (column === undefined) continue
    const gross = convert(d.gross, d.currency, base, d.payDate, index, {
      maxStaleDays: opts.maxStaleDays,
      via: base,
    })
    const tax = convert(d.tax, d.currency, base, d.payDate, index, {
      maxStaleDays: opts.maxStaleDays,
      via: base,
    })
    if (gross === null || tax === null) {
      missingFx += 1
      continue
    }
    const value = wantNet ? gross - tax : gross
    const key = groupKey(d)
    let row = byInstrument.get(key)
    if (row === undefined) {
      row = {
        instrumentKey: d.instrumentKey ?? (key === '(unmatched)' || key === d.isin ? null : key),
        label: opts.labels?.[key] ?? key,
        cells: months.map(() => 0),
        total: 0,
      }
      byInstrument.set(key, row)
    }
    const cell = row.cells[column]
    row.cells[column] = (cell ?? 0) + value
    row.total += value
  }

  const out = [...byInstrument.values()].sort((a, b) => b.total - a.total)
  const columnTotals = months.map((_, i) => sum(out.map((r) => r.cells[i] ?? 0)))
  return {
    months,
    rows: out,
    columnTotals,
    grandTotal: sum(out.map((r) => r.total)),
    missingFx,
  }
}

export interface TtmPerShare {
  perShare: number
  currency: Currency | null
  /** Payments counted. Zero means the figure came from the provider's own TTM. */
  count: number
  /** Window is (from, to]. */
  from: ISODate
  to: ISODate
  source: 'provider' | 'statement'
}

export interface TtmOptions {
  regularOnly?: boolean
  /** Count provider projections as well as declared payments. Off by default. */
  includeProjected?: boolean
}

/**
 * Trailing-12-month dividend per share, bucketed by EX DATE — the entitlement
 * view. Never pay date: yield is fixed when the share goes ex, and mixing the
 * two conventions double-counts a December/January payment.
 *
 * Statement distributions only contribute when their ex-date is known (IBKR
 * only gives it via the accrual pairing); a payment with an unknown ex-date is
 * skipped rather than bucketed by its pay date.
 */
export function ttmPerShare(
  source: DividendProfile | readonly Distribution[],
  asOf: ISODate,
  opts: TtmOptions = {},
): TtmPerShare | null {
  const from = addDays(asOf, -365)
  if (Array.isArray(source)) {
    const dists = source as readonly Distribution[]
    const inWindow = dists.filter(
      (d) =>
        d.supersededAt === null &&
        d.exDate !== null &&
        d.exDate > from &&
        d.exDate <= asOf &&
        d.perShare !== null &&
        ((opts.regularOnly ?? true) ? isRegular(d.divType, d.description) : true),
    )
    if (inWindow.length === 0) return null
    return {
      perShare: sum(inWindow.map((d) => d.perShare ?? 0)),
      currency: inWindow[0]?.currency ?? null,
      count: inWindow.length,
      from,
      to: asOf,
      source: 'statement',
    }
  }

  const profile = source as DividendProfile
  const inWindow = profile.distributions.filter(
    (d) => (opts.includeProjected ?? false ? true : d.declared) && d.exDate > from && d.exDate <= asOf,
  )
  if (inWindow.length === 0) {
    if (profile.ttmPerShare === null) return null
    return {
      perShare: profile.ttmPerShare,
      currency: profile.currency,
      count: 0,
      from,
      to: asOf,
      source: 'provider',
    }
  }
  return {
    perShare: sum(inWindow.map((d) => d.amount)),
    currency: profile.currency ?? inWindow[0]?.currency ?? null,
    count: inWindow.length,
    from,
    to: asOf,
    source: 'provider',
  }
}

/**
 * Withholding actually suffered, Σtax / Σgross. Used to net down FORWARD
 * income: the rate a Dutch ETF really withheld last year beats any assumption
 * about what it should have withheld.
 */
export function effectiveWithholdingRate(
  dists: readonly Distribution[],
  instrumentKey?: string,
): number | null {
  const rows = dists.filter(
    (d) =>
      d.supersededAt === null &&
      (instrumentKey === undefined || d.instrumentKey === instrumentKey) &&
      isRegular(d.divType, d.description),
  )
  const gross = sum(rows.map((d) => d.gross))
  const tax = sum(rows.map((d) => d.tax))
  const r = ratio(tax, gross)
  if (r === null) return null
  return Math.min(Math.max(r, 0), 1)
}

export function withholdingRateByInstrument(
  dists: readonly Distribution[],
): Map<string, number> {
  const keys = new Set<string>()
  for (const d of dists) if (d.instrumentKey !== null) keys.add(d.instrumentKey)
  const out = new Map<string, number>()
  for (const key of keys) {
    const rate = effectiveWithholdingRate(dists, key)
    if (rate !== null) out.set(key, rate)
  }
  return out
}

export interface ForwardIncome {
  /** Expected over the next 12 months, base currency. */
  totalBase: number
  /** instrumentKey -> expected income over the same window, base currency. */
  byInstrument: Readonly<Record<string, number>>
  net: boolean
  /** 1st of the current month — the anchor the window counts from. */
  anchor: ISODate
}

export interface PositionYield {
  instrumentKey: string
  forwardIncomeBase: number
  forwardYieldPct: number | null
  yieldOnCostPct: number | null
}

export interface YieldSet {
  anchor: ISODate
  net: boolean
  forwardIncomeBase: number
  marketValueExCashBase: number
  marketValueInclCashBase: number
  costBasisBase: number
  /**
   * Snowball's "passive income %": next 12 months of expected dividends over
   * market value EXCLUDING cash. Comparable with a stock's quoted yield.
   */
  forwardYieldExCashPct: number | null
  /** The honest "what does my whole pot pay me", cash dragging it down. */
  forwardYieldInclCashPct: number | null
  /** Forward income over the cost of the shares still held. */
  yieldOnCostPct: number | null
  byInstrument: PositionYield[]
}

export interface YieldOptions {
  /** Total cash across currencies, already in base. */
  cashBase?: number
}

/**
 * The three yields, separately labelled, because one ambiguous "yield" number
 * generates support tickets forever.
 *
 * Every portfolio-level figure is a RATIO OF SUMS. Averaging per-position
 * yields weights a EUR200 punt the same as a EUR40k core holding and is simply
 * a different, wrong number.
 */
export function yields(
  holdings: readonly Holding[],
  forwardIncome: ForwardIncome,
  opts: YieldOptions = {},
): YieldSet {
  const counted = holdings.filter((h) => !h.excluded)
  const marketValueExCash = sum(
    counted.map((h) => h.marketValueBase).filter((v): v is number => v !== null),
  )
  const cash = opts.cashBase ?? 0
  const costBasis = sum(
    counted.map((h) => h.costBasisBase).filter((v): v is number => v !== null),
  )

  const byInstrument: PositionYield[] = counted.map((h) => {
    const income = forwardIncome.byInstrument[h.instrumentKey] ?? 0
    return {
      instrumentKey: h.instrumentKey,
      forwardIncomeBase: income,
      forwardYieldPct: h.marketValueBase === null ? null : pct(income, h.marketValueBase),
      yieldOnCostPct: h.costBasisBase === null ? null : pct(income, h.costBasisBase),
    }
  })

  return {
    anchor: forwardIncome.anchor,
    net: forwardIncome.net,
    forwardIncomeBase: forwardIncome.totalBase,
    marketValueExCashBase: marketValueExCash,
    marketValueInclCashBase: marketValueExCash + cash,
    costBasisBase: costBasis,
    forwardYieldExCashPct: pct(forwardIncome.totalBase, marketValueExCash),
    forwardYieldInclCashPct: pct(forwardIncome.totalBase, marketValueExCash + cash),
    yieldOnCostPct: pct(forwardIncome.totalBase, costBasis),
    byInstrument,
  }
}
