import { describe, expect, it } from 'vitest'
import type { Transaction } from '../domain/types'
import { averageCost, buildLots, fifo, isClosedLot, replayLedger, totalGain } from './costbasis'

let seq = 0
function txn(
  date: string,
  quantity: number,
  price: number,
  extra: Partial<Transaction> = {},
): Transaction {
  seq += 1
  return {
    id: `t${seq}`,
    fileIds: ['f1'],
    sourceRowIds: [`f1:${seq}`],
    instrumentKey: 'ACME',
    kind: quantity >= 0 ? 'BUY' : 'SELL',
    dateTime: `${date}T10:00:00`,
    date,
    quantity,
    price,
    currency: 'USD',
    proceeds: -quantity * price,
    fees: 0,
    basis: quantity * price,
    realizedPnl: 0,
    codes: [],
    supersededAt: null,
    ...extra,
  }
}

describe('FIFO', () => {
  it('consumes the oldest lot first and leaves the newer one open', () => {
    const result = fifo([txn('2025-01-10', 100, 10), txn('2025-02-10', 100, 20), txn('2025-03-10', -100, 30)])
    expect(result.quantity).toBe(100)
    expect(result.costBasis).toBe(2000)
    expect(result.realized).toBe(2000)
    expect(result.lots).toHaveLength(1)
    expect(result.lots[0]?.date).toBe('2025-02-10')
  })

  it('moves the average price of the REMAINING shares after a sale', () => {
    const before = fifo([txn('2025-01-10', 100, 10), txn('2025-02-10', 100, 20)])
    const after = fifo([txn('2025-01-10', 100, 10), txn('2025-02-10', 100, 20), txn('2025-03-10', -100, 30)])
    expect(before.avgUnitCost).toBe(15)
    expect(after.avgUnitCost).toBe(20)
  })

  it('splits one sale across several lots', () => {
    const result = fifo([txn('2025-01-10', 60, 10), txn('2025-02-10', 60, 20), txn('2025-03-10', -90, 25)])
    const sale = result.sales[0]
    expect(sale?.consumed).toHaveLength(2)
    expect(sale?.costConsumedFifo).toBeCloseTo(60 * 10 + 30 * 20, 9)
    expect(result.quantity).toBe(30)
  })
})

describe('average cost', () => {
  it('does NOT move the average on a sale', () => {
    const buys = [txn('2025-01-10', 100, 10), txn('2025-02-10', 100, 20)]
    const before = averageCost(buys)
    const after = averageCost([...buys, txn('2025-03-10', -150, 30)])
    expect(before.avgUnitCost).toBe(15)
    expect(after.avgUnitCost).toBe(15)
    expect(after.quantity).toBe(50)
    expect(after.costBasis).toBeCloseTo(750, 9)
  })

  it('folds buy fees into the new average', () => {
    // (0*0 + 100*10 + 5) / 100
    const result = averageCost([txn('2025-01-10', 100, 10, { fees: 5 })])
    expect(result.avgUnitCost).toBeCloseTo(10.05, 12)
  })
})

describe('fees', () => {
  it('adds buy commissions to basis and subtracts sell commissions from proceeds', () => {
    const result = fifo([txn('2025-01-10', 100, 10, { fees: 5 }), txn('2025-06-10', -100, 12, { fees: 4 })])
    expect(result.totalCost).toBe(1005)
    expect(result.totalProceeds).toBe(1196)
    expect(result.realized).toBeCloseTo(191, 9)
  })

  it('treats the fee as a positive cost whatever sign the broker printed', () => {
    const result = fifo([txn('2025-01-10', 100, 10, { fees: -5 })])
    expect(result.totalCost).toBe(1005)
  })
})

describe('the invariant: realized + unrealized is identical under both methods', () => {
  const ledger = [
    txn('2025-01-10', 100, 10, { fees: 5 }),
    txn('2025-02-10', 100, 20, { fees: 5 }),
    txn('2025-03-10', -100, 30, { fees: 5 }),
  ]
  const priceNow = 25

  it('agrees on the total and disagrees on the split', () => {
    const f = fifo(ledger)
    const a = averageCost(ledger)
    const unrealizedF = f.quantity * priceNow - f.costBasis
    const unrealizedA = a.quantity * priceNow - a.costBasis
    expect(f.realized + unrealizedF).toBeCloseTo(a.realized + unrealizedA, 9)
    expect(f.realized + unrealizedF).toBeCloseTo(2485, 9)
    // Only the split moves — that is the whole point of the two methods.
    expect(f.realized).toBeCloseTo(1990, 9)
    expect(a.realized).toBeCloseTo(1490, 9)
    expect(f.realized).not.toBeCloseTo(a.realized, 6)
  })

  it('holds after a full exit, a re-entry and fractional shares', () => {
    const messy = [
      txn('2024-05-02', 144.6797, 27.31, { fees: 1.35 }),
      txn('2024-11-08', 55.3203, 31.02, { fees: 1.35 }),
      txn('2025-01-15', -200, 29.8, { fees: 2.1 }),
      txn('2025-04-01', 80.5, 33.4, { fees: 1.2 }),
      txn('2025-07-19', -30.25, 35.9, { fees: 1.1 }),
    ]
    const f = fifo(messy)
    const a = averageCost(messy)
    const price = 34.5
    const totalF = f.realized + (f.quantity * price - f.costBasis)
    const totalA = a.realized + (a.quantity * price - a.costBasis)
    expect(totalF).toBeCloseTo(totalA, 8)
    expect(totalF).toBeCloseTo(totalGain(replayLedger(messy), price), 8)
    expect(f.quantity).toBeCloseTo(50.25, 9)
  })
})

describe('quirks', () => {
  it('ignores ClosedLot rows, which would otherwise cancel out the sale', () => {
    const rows = [
      txn('2025-02-01', 200.5, 50),
      txn('2025-09-15', -100.25, 60),
      // IBKR's ClosedLot restatement: positive quantity, same lot, same P/L.
      txn('2025-02-01', 100.25, 50, { codes: ['ClosedLot'] }),
    ]
    expect(isClosedLot(rows[2] as Transaction)).toBe(true)
    const result = fifo(rows)
    expect(result.quantity).toBeCloseTo(100.25, 9)
    expect(result.realized).toBeCloseTo(100.25 * 10, 9)
  })

  it('ignores superseded rows from a restated statement', () => {
    const result = fifo([
      txn('2025-01-10', 100, 10),
      txn('2025-01-10', 100, 10, { supersededAt: '2025-02-01T00:00:00' }),
    ])
    expect(result.quantity).toBe(100)
  })

  it('starts fresh after a full exit — a new buy is a new trade', () => {
    const result = averageCost([
      txn('2025-01-10', 100, 10),
      txn('2025-03-10', -100, 12),
      txn('2025-06-10', 50, 20),
    ])
    expect(result.reopens).toBe(1)
    expect(result.avgUnitCost).toBe(20)
    expect(result.costBasis).toBe(1000)
    expect(result.realized).toBe(200)
    expect(buildLots([txn('2025-01-10', 100, 10), txn('2025-03-10', -100, 12)])).toHaveLength(0)
  })

  it('leaves no float dust in the basis of a fully closed position', () => {
    const result = fifo([
      txn('2025-01-10', 0.1, 10.1),
      txn('2025-02-10', 0.2, 20.2),
      txn('2025-03-10', -0.3, 30.3),
    ])
    expect(result.quantity).toBe(0)
    expect(result.costBasis).toBe(0)
    expect(result.lots).toHaveLength(0)
    expect(result.realized).toBeCloseTo(0.3 * 30.3 - (0.1 * 10.1 + 0.2 * 20.2), 12)
  })

  it('flags shares sold that no imported lot covers', () => {
    const result = fifo([txn('2025-01-10', 40, 10), txn('2025-03-10', -100, 12)])
    expect(result.quantity).toBe(0)
    expect(result.uncovered).toBe(60)
    expect(result.sales[0]?.uncovered).toBe(60)
  })

  it('sorts a same-timestamp round trip so the buy funds the sale', () => {
    const buy = txn('2025-05-05', 10, 100)
    const sell = { ...txn('2025-05-05', -10, 110), dateTime: buy.dateTime }
    const result = fifo([sell, buy])
    expect(result.uncovered).toBe(0)
    expect(result.realized).toBe(100)
  })

  it('recovers a missing price from proceeds', () => {
    const result = fifo([txn('2025-01-10', 100, 0, { proceeds: -1500 })])
    expect(result.totalCost).toBe(1500)
  })
})
