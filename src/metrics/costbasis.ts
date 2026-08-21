import type { ISODate, ISODateTime, Transaction } from '../domain/types'
import { EPS_QTY, isZero, sum } from './money'

/**
 * Cost basis. One lot engine, two reported methods.
 *
 * The engine replays the transaction ledger once and maintains BOTH a FIFO lot
 * queue and a moving average simultaneously, because the two must agree on the
 * only thing that is objectively true — total gain. Realized + unrealized is
 * identical under FIFO and average cost; only the split between them moves.
 * Computing them in separate passes is how that invariant silently breaks.
 *
 * Fee convention (D.3): a buy commission INCREASES cost basis, a sell
 * commission REDUCES proceeds. `Transaction.fees` is always a positive cost
 * whatever sign IBKR printed.
 */

export type CostBasisMethod = 'FIFO' | 'AVERAGE'

/** An open tax lot. `unitCost` excludes fees; `feePerShare` carries them. */
export interface Lot {
  date: ISODate
  dateTime: ISODateTime
  qty: number
  unitCost: number
  feePerShare: number
}

export interface LotConsumption {
  lotDate: ISODate
  qty: number
  /** Cost removed from the lot, fees included. */
  cost: number
}

export interface Sale {
  date: ISODate
  dateTime: ISODateTime
  /** Positive share count sold. */
  qty: number
  price: number
  fees: number
  /** qty * price - fees. */
  proceedsNet: number
  costConsumedFifo: number
  realizedFifo: number
  costConsumedAverage: number
  realizedAverage: number
  consumed: LotConsumption[]
  /**
   * Shares sold that no lot covered. Non-zero means the ledger starts after
   * the purchase (the user imported one year of a ten-year account), so the
   * realized figure for this sale is overstated by the missing cost.
   */
  uncovered: number
}

export interface LedgerResult {
  /** Shares held now. Clamped at zero: short positions are not modelled. */
  quantity: number
  /** Lifetime Σ (qty * price + buy fees). */
  totalCost: number
  /** Lifetime Σ (qty * price - sell fees). */
  totalProceeds: number
  totalFees: number
  /** Remaining open lots, oldest first. */
  lots: Lot[]
  sales: Sale[]
  costBasisFifo: number
  costBasisAverage: number
  realizedFifo: number
  realizedAverage: number
  uncovered: number
  /** Times the position went flat and was bought again — each is a new trade. */
  reopens: number
  firstActivity: ISODate | null
  lastActivity: ISODate | null
  buyCount: number
  sellCount: number
}

export interface CostBasisResult {
  method: CostBasisMethod
  quantity: number
  /** Cost of the shares STILL HELD, not lifetime invested. */
  costBasis: number
  avgUnitCost: number | null
  realized: number
  lots: Lot[]
  sales: Sale[]
  totalCost: number
  totalProceeds: number
  totalFees: number
  uncovered: number
  reopens: number
  firstActivity: ISODate | null
  lastActivity: ISODate | null
}

/**
 * A `Trades` row with DataDiscriminator=ClosedLot restates which lot a sale
 * consumed. It carries a POSITIVE quantity against the negative sale, so
 * treating it as a buy makes a round trip net to zero and hides the position.
 * We only replay orders.
 */
export function isClosedLot(txn: Transaction): boolean {
  return txn.codes.some((c) => c.replace(/[\s_-]/g, '').toLowerCase() === 'closedlot')
}

export function isReplayable(txn: Transaction): boolean {
  return txn.supersededAt === null && !isClosedLot(txn) && Number.isFinite(txn.quantity)
}

/**
 * Buys before sells at an identical timestamp, so a same-second round trip
 * finds its own lot instead of reporting uncovered shares.
 */
export function sortForReplay(txns: readonly Transaction[]): Transaction[] {
  return [...txns].sort((a, b) => {
    if (a.dateTime !== b.dateTime) return a.dateTime < b.dateTime ? -1 : 1
    const ab = a.quantity > 0 ? 0 : 1
    const bb = b.quantity > 0 ? 0 : 1
    if (ab !== bb) return ab - bb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** IBKR occasionally prints a 0 price on transfers; recover it from proceeds. */
function unitPrice(txn: Transaction): number {
  if (Number.isFinite(txn.price) && txn.price !== 0) return Math.abs(txn.price)
  const q = Math.abs(txn.quantity)
  if (q > 0 && Number.isFinite(txn.proceeds) && txn.proceeds !== 0) {
    return Math.abs(txn.proceeds) / q
  }
  return 0
}

function feesOf(txn: Transaction): number {
  return Number.isFinite(txn.fees) ? Math.abs(txn.fees) : 0
}

/** Replay the ledger once, maintaining FIFO lots and a moving average together. */
export function replayLedger(txns: readonly Transaction[]): LedgerResult {
  const ordered = sortForReplay(txns.filter(isReplayable))

  const lots: Lot[] = []
  const sales: Sale[] = []
  let quantity = 0
  let avgHeldCost = 0
  let realizedFifo = 0
  let realizedAverage = 0
  let uncovered = 0
  let reopens = 0
  let buyCount = 0
  let sellCount = 0
  let flat = true
  const costs: number[] = []
  const proceeds: number[] = []
  const fees: number[] = []

  for (const txn of ordered) {
    const qty = txn.quantity
    if (isZero(qty, EPS_QTY)) continue
    const price = unitPrice(txn)
    const fee = feesOf(txn)
    fees.push(fee)

    if (qty > 0) {
      // A buy after a full exit opens a NEW trade; nothing carries over.
      if (flat && (buyCount > 0 || sellCount > 0)) reopens += 1
      flat = false
      buyCount += 1
      const cost = qty * price + fee
      costs.push(cost)
      lots.push({
        date: txn.date,
        dateTime: txn.dateTime,
        qty,
        unitCost: price,
        feePerShare: qty === 0 ? 0 : fee / qty,
      })
      avgHeldCost += cost
      quantity += qty
      continue
    }

    sellCount += 1
    const sellQty = -qty
    const proceedsNet = sellQty * price - fee
    proceeds.push(proceedsNet)

    // Average cost: the average is fixed at the moment of sale and must NOT be
    // recomputed afterwards. This is the single most common average-cost bug.
    const avgUnit = quantity > 0 ? avgHeldCost / quantity : 0
    const avgQty = Math.min(sellQty, Math.max(quantity, 0))
    let costConsumedAverage = avgUnit * avgQty
    avgHeldCost -= costConsumedAverage

    // FIFO: oldest lots first.
    const consumed: LotConsumption[] = []
    let remaining = sellQty
    let costConsumedFifo = 0
    while (remaining > EPS_QTY && lots.length > 0) {
      const lot = lots[0]
      if (lot === undefined) break
      const take = Math.min(lot.qty, remaining)
      const cost = take * (lot.unitCost + lot.feePerShare)
      consumed.push({ lotDate: lot.date, qty: take, cost })
      costConsumedFifo += cost
      lot.qty -= take
      remaining -= take
      if (isZero(lot.qty, EPS_QTY)) lots.shift()
    }
    const shortfall = remaining > EPS_QTY ? remaining : 0
    uncovered += shortfall

    quantity -= sellQty
    if (quantity < 0) quantity = 0

    // Fully flat: sweep float dust into this sale so that
    // totalCost === costHeld + costConsumed stays exact under both methods.
    if (isZero(quantity, EPS_QTY)) {
      quantity = 0
      flat = true
      const dustFifo = sum(lots.map((l) => l.qty * (l.unitCost + l.feePerShare)))
      lots.length = 0
      costConsumedFifo += dustFifo
      costConsumedAverage += avgHeldCost
      avgHeldCost = 0
    }

    sales.push({
      date: txn.date,
      dateTime: txn.dateTime,
      qty: sellQty,
      price,
      fees: fee,
      proceedsNet,
      costConsumedFifo,
      realizedFifo: proceedsNet - costConsumedFifo,
      costConsumedAverage,
      realizedAverage: proceedsNet - costConsumedAverage,
      consumed,
      uncovered: shortfall,
    })
    realizedFifo += proceedsNet - costConsumedFifo
    realizedAverage += proceedsNet - costConsumedAverage
  }

  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  return {
    quantity,
    totalCost: sum(costs),
    totalProceeds: sum(proceeds),
    totalFees: sum(fees),
    lots,
    sales,
    costBasisFifo: sum(lots.map((l) => l.qty * (l.unitCost + l.feePerShare))),
    costBasisAverage: avgHeldCost,
    realizedFifo,
    realizedAverage,
    uncovered,
    reopens,
    firstActivity: first ? first.date : null,
    lastActivity: last ? last.date : null,
    buyCount,
    sellCount,
  }
}

/** Open lots after replaying every buy and sell, oldest first. */
export function buildLots(txns: readonly Transaction[]): Lot[] {
  return replayLedger(txns).lots
}

function project(ledger: LedgerResult, method: CostBasisMethod): CostBasisResult {
  const costBasis = method === 'FIFO' ? ledger.costBasisFifo : ledger.costBasisAverage
  return {
    method,
    quantity: ledger.quantity,
    costBasis,
    avgUnitCost: ledger.quantity > 0 ? costBasis / ledger.quantity : null,
    realized: method === 'FIFO' ? ledger.realizedFifo : ledger.realizedAverage,
    lots: ledger.lots,
    sales: ledger.sales,
    totalCost: ledger.totalCost,
    totalProceeds: ledger.totalProceeds,
    totalFees: ledger.totalFees,
    uncovered: ledger.uncovered,
    reopens: ledger.reopens,
    firstActivity: ledger.firstActivity,
    lastActivity: ledger.lastActivity,
  }
}

export function fifo(txns: readonly Transaction[]): CostBasisResult {
  return project(replayLedger(txns), 'FIFO')
}

/**
 * Moving average. On buy the average moves to
 * `(qty*avg + qtyBuy*priceBuy + buyFees) / (qty + qtyBuy)`; on sell it does not
 * move at all — only the quantity does.
 */
export function averageCost(txns: readonly Transaction[]): CostBasisResult {
  return project(replayLedger(txns), 'AVERAGE')
}

export function costBasis(
  txns: readonly Transaction[],
  method: CostBasisMethod,
): CostBasisResult {
  return project(replayLedger(txns), method)
}

/** Total gain = realized + unrealized. Method-independent by construction. */
export function totalGain(ledger: LedgerResult, priceNow: number): number {
  return ledger.totalProceeds + ledger.quantity * priceNow - ledger.totalCost
}
