import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useSyncExternalStore } from 'react'
import { db, DEFAULT_SETTINGS } from '../db/schema'
import { buildHoldings } from '../metrics/holdings'
import { project12Months, forwardIncome as forwardIncomeOf } from '../metrics/forecast'
import { yields as computeYields, dividendsByPeriod, paymentsMatrix } from '../metrics/income'
import { asIndex, convert } from '../metrics/fx'
import { externalFlows, xirr } from '../metrics/returns'
import type { Period } from '../metrics/income'
import type {
  Accrual,
  CashEvent,
  Distribution,
  DividendProfile,
  Instrument,
  InstrumentOverride,
  ISODate,
  PositionSnapshot,
  Quote,
  RawFile,
  Settings,
  Transaction,
} from '../domain/types'

/**
 * The single seam between storage and the screens.
 *
 * Everything a tab needs is derived here, once, from live Dexie queries. Tabs
 * stay pure renderers — no tab reaches into the database, and no tab recomputes
 * a metric, so two screens can never disagree about the same number.
 */

const todayISO = (): ISODate => new Date().toISOString().slice(0, 10)

export interface PortfolioView {
  loading: boolean
  hasData: boolean
  today: ISODate

  settings: Settings
  files: RawFile[]
  instruments: Instrument[]
  overrides: InstrumentOverride[]
  transactions: Transaction[]
  distributions: Distribution[]
  accruals: Accrual[]
  cashEvents: CashEvent[]
  snapshots: PositionSnapshot[]
  quotes: Quote[]
  profiles: DividendProfile[]

  portfolio: ReturnType<typeof buildHoldings>
  forecast: ReturnType<typeof project12Months>
  yields: ReturnType<typeof computeYields>

  /** Lifetime money-weighted return, or null when it cannot be trusted. */
  xirrPct: number | null

  /** Dividends actually received, bucketed by PAY date. */
  incomeBy: (period: Period) => ReturnType<typeof dividendsByPeriod>
  matrix: ReturnType<typeof paymentsMatrix>

  totalDividendsBase: number
  totalPnlBase: number
  totalPnlPct: number | null
  /** Net external contributions. Understated if `investedMissingFx` is non-zero. */
  investedBase: number
  /**
   * Deposits or withdrawals that could not be converted to base. `investedBase`
   * silently omits them, so a screen showing that figure must disclose this
   * rather than presenting a confident, understated total.
   */
  investedMissingFx: number
  /** Distributions dropped from `totalDividendsBase` for the same reason. */
  dividendsMissingFx: number
}

export function usePortfolio(): PortfolioView {
  const data = useLiveQuery(async () => {
    const [
      settings, files, instruments, overrides, transactions,
      distributions, accruals, cashEvents, snapshots, fxRates,
    ] = await Promise.all([
      db.settings.get('settings'),
      db.rawFiles.orderBy('importedAt').toArray(),
      db.instruments.toArray(),
      db.overrides.toArray(),
      db.transactions.toArray(),
      db.distributions.toArray(),
      db.accruals.toArray(),
      db.cashEvents.toArray(),
      db.positions.toArray(),
      db.fxRates.toArray(),
    ])
    return {
      settings: settings ?? DEFAULT_SETTINGS,
      files, instruments, overrides, transactions,
      distributions, accruals, cashEvents, snapshots, fxRates,
    }
  }, [])

  // Quotes and dividend profiles are session state, not persisted: they are
  // fetched client-side on demand and must never be mistaken for statement
  // truth. The market-data provider writes them into this module's cache.
  const quotes = useQuoteCache()
  const profiles = useProfileCache()

  return useMemo<PortfolioView>(() => {
    const today = todayISO()
    const empty = !data || data.files.length === 0

    const settings = data?.settings ?? DEFAULT_SETTINGS
    const instruments = data?.instruments ?? []
    const overrides = data?.overrides ?? []
    const transactions = live(data?.transactions)
    const distributions = live(data?.distributions)
    const accruals = live(data?.accruals)
    const cashEvents = live(data?.cashEvents)
    const snapshots = data?.snapshots ?? []
    const rates = asIndex(data?.fxRates ?? [])
    const base = settings.baseCurrency
    const net = settings.showNetDividends

    const portfolio = buildHoldings(transactions, instruments, quotes, snapshots, settings, {
      overrides,
      rates,
    })

    const forecast = project12Months(
      portfolio.holdings, accruals, profiles, base, rates, today, { net },
    )
    const income = forwardIncomeOf(forecast)
    const yieldSet = computeYields(portfolio.holdings, income)

    const labels = Object.fromEntries(instruments.map((i) => [i.key, i.symbol]))
    const matrix = paymentsMatrix(distributions, base, rates, { net, labels })

    const { total: totalDividendsBase, missing: dividendsMissingFx } = sumBase(
      distributions, base, rates, net,
    )

    // Invested = net external contributions. Buys and sells are internal — they
    // move value between sleeves inside the same boundary, they do not add money.
    const flows = externalFlows(cashEvents, base, rates)
    const investedBase = flows.flows.reduce((t, f) => t + f.amount, 0)

    const marketValue = portfolio.marketValueBase
    const totalPnlBase =
      portfolio.unrealizedPnlBase + portfolio.realizedPnlBase + totalDividendsBase
    const totalPnlPct =
      portfolio.costBasisBase > 0 ? (totalPnlBase / portfolio.costBasisBase) * 100 : null

    // Suppress the return entirely if any external flow could not be converted:
    // a partial flow vector produces a confidently wrong number.
    const xirrPct = flows.missingFx.length > 0 ? null : safeXirr(flows.flows, marketValue, today)

    return {
      loading: data === undefined,
      hasData: !empty,
      today,
      settings,
      files: data?.files ?? [],
      instruments,
      overrides,
      transactions,
      distributions,
      accruals,
      cashEvents,
      snapshots,
      quotes,
      profiles,
      portfolio,
      forecast,
      yields: yieldSet,
      xirrPct,
      incomeBy: (period: Period) => dividendsByPeriod(distributions, period, base, rates, { net }),
      matrix,
      totalDividendsBase,
      totalPnlBase,
      totalPnlPct,
      investedBase,
      investedMissingFx: flows.missingFx.length,
      dividendsMissingFx,
    }
  }, [data, quotes, profiles])
}

/** Soft-deleted rows are kept for provenance but must never reach a total. */
function live<T extends { supersededAt: string | null }>(rows: T[] | undefined): T[] {
  return (rows ?? []).filter((r) => r.supersededAt === null)
}

function sumBase(
  dists: readonly Distribution[],
  base: string,
  rates: ReturnType<typeof asIndex>,
  net: boolean,
): { total: number; missing: number } {
  let total = 0
  let missing = 0
  for (const d of dists) {
    const amount = net ? d.net : d.gross
    const converted = convertOrNull(amount, d.currency, base, d.payDate, rates)
    // Skipping an unconvertible payment is the only safe option, but the count
    // has to travel with the total or the caller cannot tell it is incomplete.
    if (converted === null) missing++
    else total += converted
  }
  return { total, missing }
}

function convertOrNull(
  amount: number,
  from: string,
  to: string,
  date: string,
  rates: ReturnType<typeof asIndex>,
): number | null {
  if (from === to) return amount
  return convert(amount, from, to, date, rates)
}

function safeXirr(
  flows: readonly { date: ISODate; amount: number }[],
  endValue: number,
  today: ISODate,
): number | null {
  if (!flows.length || !(endValue > 0)) return null
  // The two modules use OPPOSITE sign conventions and the same shape, so the
  // compiler cannot catch a mix-up here: externalFlows reports positive as
  // money INTO the portfolio, while xirr wants money in NEGATIVE. Negate.
  const signed = flows.map((f) => ({ date: f.date, amount: -f.amount }))
  // XIRR also needs the terminal value as a synthetic positive flow, or the
  // equation has no root.
  const r = xirr([...signed, { date: today, amount: endValue }])
  return r === null ? null : r * 100
}

// ─────────────────────────────────────────────────────────────────────────────
// Session caches for market data
// ─────────────────────────────────────────────────────────────────────────────

let quoteCache: Quote[] = []
let profileCache: DividendProfile[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function setQuotes(next: Quote[]): void {
  quoteCache = next
  emit()
}

export function setProfiles(next: DividendProfile[]): void {
  profileCache = next
  emit()
}

function useQuoteCache(): Quote[] {
  return useSyncStore(() => quoteCache)
}

function useProfileCache(): DividendProfile[] {
  return useSyncStore(() => profileCache)
}

function useSyncStore<T>(get: () => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    get,
    get,
  )
}
