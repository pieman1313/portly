import { describe, expect, it } from 'vitest'
import type {
  FxRate,
  Instrument,
  PositionSnapshot,
  Quote,
  Settings,
  Transaction,
} from '../domain/types'
import { buildHoldings, quantityAsOf } from './holdings'

const SETTINGS: Settings = {
  id: 'settings',
  baseCurrency: 'USD',
  showNetDividends: false,
  costBasisMethod: 'FIFO',
  enableMarketData: true,
  lastRefresh: null,
}

let seq = 0
function txn(
  instrumentKey: string,
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
    instrumentKey,
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

function instrument(key: string, extra: Partial<Instrument> = {}): Instrument {
  return {
    key,
    identitySource: 'conid',
    conid: `c-${key}`,
    isin: null,
    symbol: key,
    aliases: [key],
    name: `${key} Inc`,
    assetCategory: 'Stocks',
    type: 'COMMON',
    listingExchange: 'NASDAQ',
    multiplier: 1,
    tradeCurrency: 'USD',
    divCurrency: 'USD',
    firstSeen: '2025-01-01',
    lastSeen: '2025-12-31',
    ...extra,
  }
}

function snapshot(
  instrumentKey: string,
  asOf: string,
  quantity: number,
  closePrice: number,
  extra: Partial<PositionSnapshot> = {},
): PositionSnapshot {
  return {
    id: `A1|${asOf}|${instrumentKey}`,
    fileId: 'f1',
    account: 'A1',
    asOf,
    instrumentKey,
    currency: 'USD',
    quantity,
    costPrice: 0,
    costBasis: 0,
    closePrice,
    value: quantity * closePrice,
    unrealizedPnl: 0,
    ...extra,
  }
}

function quote(instrumentKey: string, price: number, currency = 'USD'): Quote {
  return {
    instrumentKey,
    price,
    currency,
    previousClose: null,
    provenance: { source: 'stockanalysis', asOf: '2025-12-31T20:00:00' },
  }
}

describe('quantity comes from the ledger', () => {
  it('reflects a sale, and keeps the closed position visible', () => {
    const portfolio = buildHoldings(
      [
        txn('ACME', '2025-02-01', 200.5, 50),
        txn('ACME', '2025-09-15', -200.5, 60),
        txn('GLOB', '2025-06-01', 80, 100),
      ],
      [instrument('ACME'), instrument('GLOB')],
      [],
      [],
      SETTINGS,
      { asOf: '2025-12-31' },
    )
    const acme = portfolio.holdings.find((h) => h.instrumentKey === 'ACME')
    expect(acme?.quantity).toBe(0)
    expect(acme?.closed).toBe(true)
    // A "show sold" toggle needs the row, and realized P/L still counts.
    expect(acme?.realizedPnl).toBeCloseTo(200.5 * 10, 9)
    expect(portfolio.holdings.map((h) => h.instrumentKey)).toEqual(['GLOB', 'ACME'])
  })

  it('picks up an instrument bought after the last statement snapshot', () => {
    const portfolio = buildHoldings(
      [txn('NEWETF', '2026-01-10', 10, 25)],
      [],
      [],
      [snapshot('ACME', '2025-12-31', 100, 55)],
      SETTINGS,
      { asOf: '2026-01-31' },
    )
    expect(portfolio.holdings.find((h) => h.instrumentKey === 'NEWETF')?.quantity).toBe(10)
  })
})

describe('cross-check against the broker snapshot', () => {
  it('flags a disagreement instead of silently picking a side', () => {
    const portfolio = buildHoldings(
      [txn('ACME', '2025-02-01', 150, 50)],
      [instrument('ACME')],
      [],
      [snapshot('ACME', '2025-12-31', 100, 55)],
      SETTINGS,
    )
    expect(portfolio.discrepancies).toHaveLength(1)
    expect(portfolio.discrepancies[0]).toMatchObject({
      instrumentKey: 'ACME',
      asOf: '2025-12-31',
      ledgerQuantity: 150,
      snapshotQuantity: 100,
      difference: 50,
    })
    // The ledger still wins — it is the only thing that knows about later trades.
    expect(portfolio.holdings[0]?.quantity).toBe(150)
    expect(portfolio.holdings[0]?.quantitySource).toBe('ledger')
  })

  it('compares at the SNAPSHOT date, so later trades are not a discrepancy', () => {
    const portfolio = buildHoldings(
      [txn('ACME', '2025-02-01', 100, 50), txn('ACME', '2026-02-01', 50, 60)],
      [instrument('ACME')],
      [],
      [snapshot('ACME', '2025-12-31', 100, 55)],
      SETTINGS,
      { asOf: '2026-03-01' },
    )
    expect(portfolio.discrepancies).toEqual([])
    expect(portfolio.holdings[0]?.quantity).toBe(150)
    expect(quantityAsOf([txn('ACME', '2025-02-01', 100, 50)], '2025-12-31')).toBe(100)
  })

  it('falls back to the snapshot for a position that predates every import', () => {
    const portfolio = buildHoldings(
      [],
      [instrument('OLD')],
      [],
      [snapshot('OLD', '2025-12-31', 42, 10, { costBasis: 300 })],
      SETTINGS,
    )
    expect(portfolio.holdings[0]?.quantity).toBe(42)
    expect(portfolio.holdings[0]?.quantitySource).toBe('snapshot')
    expect(portfolio.holdings[0]?.costBasis).toBe(300)
    expect(portfolio.discrepancies).toEqual([])
  })

  it('sums the same instrument across accounts, latest snapshot per account', () => {
    const portfolio = buildHoldings(
      [],
      [instrument('ACME')],
      [],
      [
        snapshot('ACME', '2025-06-30', 10, 55),
        snapshot('ACME', '2025-12-31', 30, 55),
        { ...snapshot('ACME', '2025-12-31', 20, 55), id: 'A2|2025-12-31|ACME', account: 'A2' },
      ],
      SETTINGS,
    )
    expect(portfolio.holdings[0]?.quantity).toBe(50)
  })
})

describe('price precedence', () => {
  const txns = [txn('ACME', '2025-02-01', 100, 50)]
  const snaps = [snapshot('ACME', '2025-12-31', 100, 55)]

  it('prefers a manual override over everything', () => {
    const portfolio = buildHoldings(txns, [instrument('ACME')], [quote('ACME', 60)], snaps, SETTINGS, {
      overrides: [{ instrumentKey: 'ACME', manualPrice: 70 }],
    })
    expect(portfolio.holdings[0]?.price).toBe(70)
    expect(portfolio.holdings[0]?.priceSource).toBe('manual')
  })

  it('prefers a live quote over the statement close', () => {
    const portfolio = buildHoldings(txns, [instrument('ACME')], [quote('ACME', 60)], snaps, SETTINGS)
    expect(portfolio.holdings[0]?.price).toBe(60)
    expect(portfolio.holdings[0]?.priceSource).toBe('quote')
  })

  it('falls back to the statement close, so the app works offline', () => {
    const portfolio = buildHoldings(txns, [instrument('ACME')], [], snaps, SETTINGS)
    expect(portfolio.holdings[0]?.price).toBe(55)
    expect(portfolio.holdings[0]?.priceSource).toBe('snapshot')
    expect(portfolio.holdings[0]?.marketValue).toBe(5500)
  })

  it('reports no price rather than a stale guess', () => {
    const portfolio = buildHoldings(txns, [instrument('ACME')], [], [], SETTINGS)
    expect(portfolio.holdings[0]?.price).toBeNull()
    expect(portfolio.holdings[0]?.marketValue).toBeNull()
    expect(portfolio.holdings[0]?.weightPct).toBeNull()
    expect(portfolio.unpriced).toEqual(['ACME'])
  })
})

describe('weights', () => {
  it('are a share of the priced, non-excluded total and add to 100', () => {
    const portfolio = buildHoldings(
      [txn('A', '2025-01-01', 100, 10), txn('B', '2025-01-01', 100, 30), txn('C', '2025-01-01', 100, 1)],
      [instrument('A'), instrument('B'), instrument('C')],
      [quote('A', 10), quote('B', 30), quote('C', 1)],
      [],
      SETTINGS,
      { overrides: [{ instrumentKey: 'C', excluded: true }] },
    )
    const weights = portfolio.holdings
      .filter((h) => !h.excluded)
      .map((h) => h.weightPct as number)
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9)
    expect(portfolio.holdings.find((h) => h.instrumentKey === 'A')?.weightPct).toBeCloseTo(25, 9)
    expect(portfolio.marketValueBase).toBe(4000)
  })
})

describe('multi-currency', () => {
  const rates: FxRate[] = [
    { id: 'EUR|USD|2025-03-10', base: 'EUR', quote: 'USD', date: '2025-03-10', rate: 1.1 },
    { id: 'EUR|USD|2025-12-31', base: 'EUR', quote: 'USD', date: '2025-12-31', rate: 1.2 },
  ]

  it('converts cost basis at the TRADE date and market value at the valuation date', () => {
    const portfolio = buildHoldings(
      [txn('EURO', '2025-03-10', 100, 40, { currency: 'EUR' })],
      [instrument('EURO', { tradeCurrency: 'EUR' })],
      [],
      [snapshot('EURO', '2025-12-31', 100, 42, { currency: 'EUR' })],
      SETTINGS,
      { rates, asOf: '2025-12-31' },
    )
    const holding = portfolio.holdings[0]
    expect(holding?.costBasis).toBe(4000)
    expect(holding?.costBasisBase).toBeCloseTo(4400, 9)
    expect(holding?.marketValueBase).toBeCloseTo(5040, 9)
    // Converting cost at today's rate would give 4800 and hide 400 of FX gain.
    expect(holding?.unrealizedPnlBase).toBeCloseTo(640, 9)
    expect(holding?.unrealizedPnl).toBeCloseTo(200, 9)
  })

  it('flags the position rather than inventing a rate', () => {
    const portfolio = buildHoldings(
      [txn('EURO', '2025-03-10', 100, 40, { currency: 'EUR' })],
      [instrument('EURO', { tradeCurrency: 'EUR' })],
      [],
      [snapshot('EURO', '2025-12-31', 100, 42, { currency: 'EUR' })],
      SETTINGS,
      { rates: [], asOf: '2025-12-31' },
    )
    expect(portfolio.holdings[0]?.costBasisBase).toBeNull()
    expect(portfolio.holdings[0]?.marketValueBase).toBeNull()
    expect(portfolio.missingFx).toEqual(['EURO'])
  })

  it('prices the proceeds at the sale date and the cost at the purchase date', () => {
    const portfolio = buildHoldings(
      [
        txn('EURO', '2025-03-10', 100, 40, { currency: 'EUR' }),
        txn('EURO', '2025-12-31', -100, 50, { currency: 'EUR' }),
      ],
      [instrument('EURO', { tradeCurrency: 'EUR' })],
      [],
      [],
      SETTINGS,
      { rates, asOf: '2025-12-31' },
    )
    // 5000 EUR out at 1.20 less 4000 EUR in at 1.10. Converting the netted
    // 1000 EUR at the sale rate gives 1200 and loses the 400 of FX gain.
    expect(portfolio.holdings[0]?.realizedPnl).toBeCloseTo(1000, 9)
    expect(portfolio.holdings[0]?.realizedPnlBase).toBeCloseTo(1600, 9)
  })

  it('does not lose FX gain the instant a position is sold', () => {
    const buy = txn('EURO', '2025-03-10', 100, 40, { currency: 'EUR' })
    const held = buildHoldings(
      [buy],
      [instrument('EURO', { tradeCurrency: 'EUR' })],
      [quote('EURO', 50, 'EUR')],
      [],
      SETTINGS,
      { rates, asOf: '2025-12-31' },
    )
    const sold = buildHoldings(
      [buy, txn('EURO', '2025-12-31', -100, 50, { currency: 'EUR' })],
      [instrument('EURO', { tradeCurrency: 'EUR' })],
      [quote('EURO', 50, 'EUR')],
      [],
      SETTINGS,
      { rates, asOf: '2025-12-31' },
    )
    // Same prices, same rates, same day: selling must not change total P/L.
    expect(held.holdings[0]?.totalPnlBase).toBeCloseTo(1600, 9)
    expect(sold.holdings[0]?.totalPnlBase).toBeCloseTo(1600, 9)
  })

  it('agrees between FIFO and average cost on realized-plus-unrealized in base', () => {
    const rows = [
      txn('EURO', '2025-03-10', 100, 40, { currency: 'EUR' }),
      txn('EURO', '2025-12-31', -60, 50, { currency: 'EUR' }),
    ]
    const args = [
      rows,
      [instrument('EURO', { tradeCurrency: 'EUR' })],
      [quote('EURO', 50, 'EUR')],
      [],
    ] as const
    const asFifo = buildHoldings(...args, SETTINGS, { rates, asOf: '2025-12-31' })
    const asAvg = buildHoldings(...args, { ...SETTINGS, costBasisMethod: 'AVERAGE' }, {
      rates,
      asOf: '2025-12-31',
    })
    expect(asFifo.holdings[0]?.totalPnlBase).toBeCloseTo(asAvg.holdings[0]?.totalPnlBase ?? 0, 9)
  })
})

describe('cost basis method', () => {
  it('follows the setting', () => {
    const rows = [
      txn('ACME', '2025-01-10', 100, 10),
      txn('ACME', '2025-02-10', 100, 20),
      txn('ACME', '2025-03-10', -100, 30),
    ]
    const asFifo = buildHoldings(rows, [instrument('ACME')], [quote('ACME', 25)], [], SETTINGS)
    const asAverage = buildHoldings(rows, [instrument('ACME')], [quote('ACME', 25)], [], {
      ...SETTINGS,
      costBasisMethod: 'AVERAGE',
    })
    expect(asFifo.holdings[0]?.costBasis).toBe(2000)
    expect(asAverage.holdings[0]?.costBasis).toBe(1500)
    const totalF = (asFifo.holdings[0]?.unrealizedPnl ?? 0) + (asFifo.holdings[0]?.realizedPnl ?? 0)
    const totalA = (asAverage.holdings[0]?.unrealizedPnl ?? 0) + (asAverage.holdings[0]?.realizedPnl ?? 0)
    expect(totalF).toBeCloseTo(totalA, 9)
  })
})
