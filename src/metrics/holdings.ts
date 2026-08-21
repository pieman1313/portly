import type {
  Currency,
  ISODate,
  ISODateTime,
  Instrument,
  InstrumentOverride,
  PositionSnapshot,
  Quote,
  Settings,
  Transaction,
} from '../domain/types'
import type { CostBasisMethod, Lot, Sale } from './costbasis'
import { isReplayable, replayLedger } from './costbasis'
import { asIndex, convert, type FxSource } from './fx'
import { EPS_QTY, isZero, pct, sum, sumBy } from './money'

/**
 * Current holdings, derived from the transaction ledger.
 *
 * Quantity comes from the LEDGER, not from Open Positions, because Open
 * Positions is a snapshot of one statement's end date: a position sold last
 * week simply vanishes from it, and a position opened after the last import
 * never appears. Replaying trades handles sells, re-entries and brand new
 * tickers without any special casing.
 *
 * But the broker is still the authority on what is actually in the account, so
 * every ledger quantity is cross-checked against the latest snapshot and any
 * disagreement is surfaced as a `QuantityCheck` rather than quietly resolved.
 * A ledger that disagrees with IBKR means we dropped or double-counted a row,
 * and the user needs to know that before they trust the totals.
 */

export type PriceSource = 'manual' | 'quote' | 'snapshot'

export interface QuantityCheck {
  instrumentKey: string
  asOf: ISODate
  /** Signed sum of ledger quantities up to `asOf` — NOT today's quantity. */
  ledgerQuantity: number
  snapshotQuantity: number
  difference: number
}

export interface Holding {
  instrumentKey: string
  symbol: string
  name: string
  assetCategory: string
  instrument: Instrument | null

  /** Currency the position is denominated in — the currency of its trades. */
  currency: Currency
  quantity: number
  quantitySource: 'ledger' | 'snapshot'
  method: CostBasisMethod

  /** Cost of the shares still held, in `currency`. */
  costBasis: number
  /** Same, converted leg by leg at the FX rate of each acquisition date. */
  costBasisBase: number | null
  avgUnitCost: number | null

  price: number | null
  priceCurrency: Currency | null
  priceSource: PriceSource | null
  priceAsOf: ISODateTime | null

  /** In `priceCurrency`, which is not always `currency`. */
  marketValue: number | null
  marketValueBase: number | null

  /** Null when the price is quoted in a different currency than the cost. */
  unrealizedPnl: number | null
  unrealizedPnlBase: number | null
  /** Lifetime, in `currency`. */
  realizedPnl: number
  /**
   * Lifetime, in base: each sale's proceeds at its own trade date less the
   * lots it consumed at their acquisition dates, so realized FX is included
   * exactly as it is on the unrealized side.
   */
  realizedPnlBase: number | null
  totalPnlBase: number | null

  /** Share of portfolio market value, 0..100. Null while unpriced. */
  weightPct: number | null

  closed: boolean
  excluded: boolean
  /** Sold shares no lot covered — the ledger starts after the purchase. */
  uncoveredShares: number
  reopens: number
  lots: Lot[]
  sales: Sale[]
  check: QuantityCheck | null
}

export interface Portfolio {
  asOf: ISODate
  baseCurrency: Currency
  method: CostBasisMethod
  holdings: Holding[]
  /** Securities only. Cash is not a holding and is never in here. */
  marketValueBase: number
  costBasisBase: number
  unrealizedPnlBase: number
  realizedPnlBase: number
  /** Instruments held with no usable price. Their weight is null. */
  unpriced: string[]
  /** Instruments whose base-currency conversion failed. */
  missingFx: string[]
  discrepancies: QuantityCheck[]
}

export interface HoldingsOptions {
  overrides?: readonly InstrumentOverride[]
  rates?: FxSource
  /** Valuation date. Defaults to the latest snapshot, else the last trade. */
  asOf?: ISODate
  /**
   * 'auto' (default) trusts the ledger, and only falls back to the snapshot
   * for instruments the ledger has never seen — a position bought before the
   * earliest imported statement.
   */
  quantitySource?: 'ledger' | 'snapshot' | 'auto'
  /** Fractional shares are real, so the check needs a tolerance. */
  quantityTolerance?: number
  maxStaleDays?: number
}

interface SnapshotAgg {
  asOf: ISODate
  quantity: number
  closePrice: number | null
  currency: Currency
  costBasis: number
}

/** Latest snapshot per (account, instrument), then aggregated across accounts. */
function aggregateSnapshots(
  snapshots: readonly PositionSnapshot[],
): Map<string, SnapshotAgg> {
  const latestPerAccount = new Map<string, PositionSnapshot>()
  for (const s of snapshots) {
    const key = `${s.account}|${s.instrumentKey}`
    const seen = latestPerAccount.get(key)
    if (!seen || s.asOf > seen.asOf) latestPerAccount.set(key, s)
  }
  const out = new Map<string, SnapshotAgg>()
  for (const s of latestPerAccount.values()) {
    const cur = out.get(s.instrumentKey)
    if (!cur) {
      out.set(s.instrumentKey, {
        asOf: s.asOf,
        quantity: s.quantity,
        closePrice: Number.isFinite(s.closePrice) ? s.closePrice : null,
        currency: s.currency,
        costBasis: s.costBasis,
      })
      continue
    }
    out.set(s.instrumentKey, {
      asOf: s.asOf > cur.asOf ? s.asOf : cur.asOf,
      quantity: cur.quantity + s.quantity,
      // Same instrument, same close price — keep whichever we already have.
      closePrice: cur.closePrice ?? (Number.isFinite(s.closePrice) ? s.closePrice : null),
      currency: cur.currency,
      costBasis: cur.costBasis + s.costBasis,
    })
  }
  return out
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
}

/** Signed ledger quantity on a given date — the snapshot cross-check basis. */
export function quantityAsOf(txns: readonly Transaction[], date: ISODate): number {
  return sumBy(
    txns.filter((t) => isReplayable(t) && t.date <= date),
    (t) => t.quantity,
  )
}

export function buildHoldings(
  txns: readonly Transaction[],
  instruments: readonly Instrument[],
  quotes: readonly Quote[],
  snapshots: readonly PositionSnapshot[],
  settings: Settings,
  opts: HoldingsOptions = {},
): Portfolio {
  const base = settings.baseCurrency
  const method = settings.costBasisMethod
  // Indexed once: `convert` re-indexes (and re-sorts) a raw rate array on
  // every single call, and this file converts once per lot and once per sale.
  const rates: FxSource = asIndex(opts.rates ?? [])
  const fxOpts = { maxStaleDays: opts.maxStaleDays, via: base }
  const tolerance = opts.quantityTolerance ?? 1e-6
  const mode = opts.quantitySource ?? 'auto'

  const instrumentByKey = new Map(instruments.map((i) => [i.key, i]))
  const quoteByKey = new Map(quotes.map((q) => [q.instrumentKey, q]))
  const overrideByKey = new Map((opts.overrides ?? []).map((o) => [o.instrumentKey, o]))
  const snapByKey = aggregateSnapshots(snapshots)
  const txnsByKey = groupBy(txns.filter(isReplayable), (t) => t.instrumentKey)

  const latestSnapshotDate = [...snapByKey.values()].reduce<ISODate | null>(
    (acc, s) => (acc === null || s.asOf > acc ? s.asOf : acc),
    null,
  )
  const latestTradeDate = txns.reduce<ISODate | null>(
    (acc, t) => (acc === null || t.date > acc ? t.date : acc),
    null,
  )
  const asOf = opts.asOf ?? latestSnapshotDate ?? latestTradeDate ?? '1970-01-01'

  const keys = new Set<string>([...txnsByKey.keys(), ...snapByKey.keys()])
  const holdings: Holding[] = []
  const unpriced: string[] = []
  const missingFx: string[] = []
  const discrepancies: QuantityCheck[] = []

  for (const key of keys) {
    const instrument = instrumentByKey.get(key) ?? null
    const rows = txnsByKey.get(key) ?? []
    const snap = snapByKey.get(key) ?? null
    const override = overrideByKey.get(key) ?? null
    const ledger = replayLedger(rows)

    const currency: Currency =
      rows[0]?.currency ?? instrument?.tradeCurrency ?? snap?.currency ?? base

    // Fall back to the broker only when we have no ledger at all: the position
    // predates every imported statement, so there is nothing to replay.
    const useSnapshot =
      mode === 'snapshot' || (mode === 'auto' && rows.length === 0 && snap !== null)
    const quantity = useSnapshot && snap ? snap.quantity : ledger.quantity
    const quantitySource: 'ledger' | 'snapshot' = useSnapshot && snap ? 'snapshot' : 'ledger'

    let costBasis = method === 'FIFO' ? ledger.costBasisFifo : ledger.costBasisAverage
    if (quantitySource === 'snapshot' && snap) costBasis = snap.costBasis

    // Cross-check against the broker AT THE SNAPSHOT DATE. Comparing today's
    // ledger quantity to a month-old snapshot would flag every trade since.
    let check: QuantityCheck | null = null
    if (snap && quantitySource === 'ledger') {
      const ledgerAt = quantityAsOf(rows, snap.asOf)
      const difference = ledgerAt - snap.quantity
      check = {
        instrumentKey: key,
        asOf: snap.asOf,
        ledgerQuantity: ledgerAt,
        snapshotQuantity: snap.quantity,
        difference,
      }
      if (Math.abs(difference) > tolerance) discrepancies.push(check)
    }

    const priced = resolvePrice(override, quoteByKey.get(key) ?? null, snap, currency, asOf)
    // An excluded holding contributes to no total, so a missing price for it is
    // not a gap in the numbers. Counting it here inflated the "N holdings have
    // no price" warning with instruments the user had deliberately switched off.
    if (priced === null && !isZero(quantity, EPS_QTY) && override?.excluded !== true) {
      unpriced.push(key)
    }

    const marketValue = priced === null ? null : quantity * priced.price
    const marketValueBase =
      priced === null || marketValue === null
        ? null
        : convert(marketValue, priced.currency, base, asOf, rates, fxOpts)

    const costBasisBase = costBasisInBase(
      ledger,
      costBasis,
      quantitySource,
      currency,
      base,
      asOf,
      rates,
      fxOpts,
    )
    const realizedPnlBase = realizedInBase(ledger, method, currency, base, rates, fxOpts)

    if (
      (marketValue !== null && marketValueBase === null) ||
      (costBasis !== 0 && costBasisBase === null) ||
      realizedPnlBase === null
    ) {
      missingFx.push(key)
    }

    const unrealizedPnl =
      marketValue !== null && priced !== null && priced.currency === currency
        ? marketValue - costBasis
        : null
    const unrealizedPnlBase =
      marketValueBase !== null && costBasisBase !== null ? marketValueBase - costBasisBase : null

    holdings.push({
      instrumentKey: key,
      symbol: instrument?.symbol ?? key,
      name: instrument?.name ?? instrument?.symbol ?? key,
      assetCategory: instrument?.assetCategory ?? 'Stocks',
      instrument,
      currency,
      quantity,
      quantitySource,
      method,
      costBasis,
      costBasisBase,
      avgUnitCost: quantity > 0 ? costBasis / quantity : null,
      price: priced?.price ?? null,
      priceCurrency: priced?.currency ?? null,
      priceSource: priced?.source ?? null,
      priceAsOf: priced?.asOf ?? null,
      marketValue,
      marketValueBase,
      unrealizedPnl,
      unrealizedPnlBase,
      realizedPnl: method === 'FIFO' ? ledger.realizedFifo : ledger.realizedAverage,
      realizedPnlBase,
      totalPnlBase:
        unrealizedPnlBase !== null && realizedPnlBase !== null
          ? unrealizedPnlBase + realizedPnlBase
          : null,
      weightPct: null,
      // Kept in the list on purpose: the holdings table has a "show sold"
      // toggle, and realized P/L on a closed position still counts.
      closed: isZero(quantity, EPS_QTY),
      excluded: override?.excluded === true,
      uncoveredShares: ledger.uncovered,
      reopens: ledger.reopens,
      lots: ledger.lots,
      sales: ledger.sales,
      check,
    })
  }

  const counted = holdings.filter((h) => !h.excluded)
  const totalMv = sum(
    counted.map((h) => h.marketValueBase).filter((v): v is number => v !== null),
  )
  for (const h of counted) {
    h.weightPct = h.marketValueBase === null ? null : pct(h.marketValueBase, totalMv)
  }

  holdings.sort((a, b) => {
    if (a.closed !== b.closed) return a.closed ? 1 : -1
    const av = a.marketValueBase ?? -1
    const bv = b.marketValueBase ?? -1
    if (av !== bv) return bv - av
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0
  })

  return {
    asOf,
    baseCurrency: base,
    method,
    holdings,
    marketValueBase: totalMv,
    costBasisBase: sum(
      counted.map((h) => h.costBasisBase).filter((v): v is number => v !== null),
    ),
    unrealizedPnlBase: sum(
      counted.map((h) => h.unrealizedPnlBase).filter((v): v is number => v !== null),
    ),
    realizedPnlBase: sum(
      counted.map((h) => h.realizedPnlBase).filter((v): v is number => v !== null),
    ),
    unpriced,
    missingFx,
    discrepancies,
  }
}

interface ResolvedPrice {
  price: number
  currency: Currency
  source: PriceSource
  asOf: ISODateTime
}

/**
 * Manual override > live quote > the statement's own close price > nothing.
 * The statement price is what makes the app useful offline the second a file
 * is dropped, and it is never worse than "unavailable".
 */
function resolvePrice(
  override: InstrumentOverride | null,
  quote: Quote | null,
  snap: SnapshotAgg | null,
  currency: Currency,
  asOf: ISODate,
): ResolvedPrice | null {
  const manual = override?.manualPrice
  if (manual !== null && manual !== undefined && Number.isFinite(manual)) {
    return {
      price: manual,
      currency: override?.manualPriceCurrency ?? currency,
      source: 'manual',
      asOf,
    }
  }
  if (quote && Number.isFinite(quote.price)) {
    return {
      price: quote.price,
      currency: quote.currency,
      source: 'quote',
      asOf: quote.provenance.asOf,
    }
  }
  if (snap && snap.closePrice !== null) {
    return { price: snap.closePrice, currency: snap.currency, source: 'snapshot', asOf: snap.asOf }
  }
  return null
}

/**
 * Convert cost basis leg by leg at the FX rate of each ACQUISITION date.
 * Converting the whole basis at today's rate is the classic multi-currency
 * bug: it makes FX gain vanish and a USD position look flat while EUR/USD moved.
 *
 * Under average cost there are no lots to attribute, so the FIFO lot dates are
 * reused as the FX timeline and scaled to the average-cost total. Same money,
 * same dates, just a different split.
 */
function costBasisInBase(
  ledger: ReturnType<typeof replayLedger>,
  costBasis: number,
  quantitySource: 'ledger' | 'snapshot',
  currency: Currency,
  base: Currency,
  asOf: ISODate,
  rates: FxSource,
  fxOpts: { maxStaleDays?: number; via?: Currency },
): number | null {
  if (currency === base) return costBasis
  if (isZero(costBasis, 1e-9)) return 0
  if (quantitySource === 'snapshot' || ledger.lots.length === 0) {
    // No lot history: the broker's own cost figure, converted at `asOf`. Marked
    // by `quantitySource` so the UI can disclose the weaker attribution.
    return convert(costBasis, currency, base, asOf, rates, fxOpts)
  }
  const legs: number[] = []
  for (const lot of ledger.lots) {
    const converted = convert(
      lot.qty * (lot.unitCost + lot.feePerShare),
      currency,
      base,
      lot.date,
      rates,
      fxOpts,
    )
    if (converted === null) return null
    legs.push(converted)
  }
  const fifoBase = sum(legs)
  if (ledger.costBasisFifo === 0) return fifoBase
  return fifoBase * (costBasis / ledger.costBasisFifo)
}

/**
 * Realized P/L in base: proceeds at the SALE date minus the cost of the lots
 * that funded the sale, each at its own ACQUISITION date.
 *
 * Converting the already-netted local realized figure at the sale-date rate
 * looks right and is not: it values the cost leg at the sale-date rate too, so
 * the FX move between buying and selling disappears. A EUR holder who bought a
 * USD position at 1.10 and sold it flat at 1.20 really did lose money, and the
 * unrealized side of this file already says so — leaving realized on the other
 * convention makes `totalPnlBase` drop the moment the position is sold, with
 * no price and no rate having moved.
 *
 * Under average cost there are no per-sale lots, so the FIFO consumption of
 * that same sale supplies the FX timeline and is scaled to the average-cost
 * amount. Same money, same dates, different split — as in `costBasisInBase`.
 */
function realizedInBase(
  ledger: ReturnType<typeof replayLedger>,
  method: CostBasisMethod,
  currency: Currency,
  base: Currency,
  rates: FxSource,
  fxOpts: { maxStaleDays?: number; via?: Currency },
): number | null {
  const total = method === 'FIFO' ? ledger.realizedFifo : ledger.realizedAverage
  if (currency === base) return total
  if (ledger.sales.length === 0) return 0
  const legs: number[] = []
  for (const sale of ledger.sales) {
    const proceeds = convert(sale.proceedsNet, currency, base, sale.date, rates, fxOpts)
    if (proceeds === null) return null

    const consumedLocal = method === 'FIFO' ? sale.costConsumedFifo : sale.costConsumedAverage
    const fifoLocal = sum(sale.consumed.map((c) => c.cost))
    let costBase: number
    if (sale.consumed.length === 0 || fifoLocal === 0) {
      // Nothing to attribute (an uncovered sale, or a cost of exactly zero):
      // fall back to the sale date rather than dropping the leg.
      if (consumedLocal === 0) costBase = 0
      else {
        const c = convert(consumedLocal, currency, base, sale.date, rates, fxOpts)
        if (c === null) return null
        costBase = c
      }
    } else {
      const parts: number[] = []
      for (const c of sale.consumed) {
        const converted = convert(c.cost, currency, base, c.lotDate, rates, fxOpts)
        if (converted === null) return null
        parts.push(converted)
      }
      costBase = sum(parts) * (consumedLocal / fifoLocal)
    }
    legs.push(proceeds - costBase)
  }
  return sum(legs)
}
