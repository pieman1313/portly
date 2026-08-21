import { describe, expect, it } from 'vitest'
import type {
  Distribution,
  DividendProfile,
  FxRate,
  Instrument,
  InstrumentOverride,
} from '../domain/types'
import {
  displaySymbols,
  dividendsByPeriod,
  dividendsByPeriodGrouped,
  effectiveWithholdingRate,
  instrumentLabel,
  isRegular,
  paymentsMatrix,
  ttmPerShare,
  UNATTRIBUTED,
  UNATTRIBUTED_LABEL,
  withholdingRateByInstrument,
  yields,
} from './income'
import type { Holding } from './holdings'

let seq = 0
function dist(
  instrumentKey: string,
  payDate: string,
  gross: number,
  extra: Partial<Distribution> = {},
): Distribution {
  seq += 1
  return {
    id: `d${seq}`,
    fileIds: ['f1'],
    sourceRowIds: [`f1:${seq}`],
    instrumentKey,
    isin: null,
    payDate,
    exDate: null,
    currency: 'USD',
    gross,
    tax: 0,
    net: gross,
    perShare: null,
    description: `${instrumentKey} Cash Dividend`,
    divType: 'Ordinary Dividend',
    supersededAt: null,
    ...extra,
  }
}

function holding(instrumentKey: string, marketValueBase: number, costBasisBase: number): Holding {
  return {
    instrumentKey,
    symbol: instrumentKey,
    name: instrumentKey,
    assetCategory: 'Stocks',
    instrument: null,
    currency: 'USD',
    quantity: 100,
    quantitySource: 'ledger',
    method: 'FIFO',
    costBasis: costBasisBase,
    costBasisBase,
    avgUnitCost: costBasisBase / 100,
    price: marketValueBase / 100,
    priceCurrency: 'USD',
    priceSource: 'quote',
    priceAsOf: '2026-08-21T20:00:00',
    marketValue: marketValueBase,
    marketValueBase,
    unrealizedPnl: marketValueBase - costBasisBase,
    unrealizedPnlBase: marketValueBase - costBasisBase,
    realizedPnl: 0,
    realizedPnlBase: 0,
    totalPnlBase: marketValueBase - costBasisBase,
    weightPct: null,
    closed: false,
    excluded: false,
    uncoveredShares: 0,
    reopens: 0,
    lots: [],
    sales: [],
    check: null,
  }
}

describe('dividendsByPeriod buckets by PAY date', () => {
  it('puts a December ex-date with a January pay date in January', () => {
    const buckets = dividendsByPeriod(
      [dist('NEWT', '2026-01-15', 63, { exDate: '2025-12-31' })],
      'month',
      'USD',
      [],
    )
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.key).toBe('2026-01')
    expect(buckets[0]?.gross).toBe(63)
  })

  it('emits dense buckets so a chart has no gaps', () => {
    const buckets = dividendsByPeriod(
      [dist('ACME', '2025-04-10', 60.15), dist('ACME', '2025-10-10', 35.09)],
      'month',
      'USD',
      [],
    )
    expect(buckets.map((b) => b.key)).toEqual([
      '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10',
    ])
    expect(buckets[1]?.amount).toBe(0)
    expect(buckets[0]?.end).toBe('2025-04-30')
  })

  it('groups by quarter and by year', () => {
    const rows = [dist('ACME', '2025-04-10', 10), dist('ACME', '2025-05-10', 20), dist('ACME', '2026-01-10', 30)]
    expect(dividendsByPeriod(rows, 'quarter', 'USD', []).map((b) => [b.key, b.gross])).toEqual([
      ['2025-Q2', 30],
      ['2025-Q3', 0],
      ['2025-Q4', 0],
      ['2026-Q1', 30],
    ])
    expect(dividendsByPeriod(rows, 'year', 'USD', []).map((b) => [b.key, b.gross])).toEqual([
      ['2025', 30],
      ['2026', 30],
    ])
  })

  it('nets using the withholding actually on the statement', () => {
    const rows = [dist('OLDT', '2025-06-20', 50, { tax: 7.5, net: 42.5 })]
    expect(dividendsByPeriod(rows, 'year', 'USD', [])[0]?.amount).toBe(50)
    expect(dividendsByPeriod(rows, 'year', 'USD', [], { net: true })[0]?.amount).toBe(42.5)
    // 15% here, not an assumed 15% everywhere.
    expect(effectiveWithholdingRate(rows)).toBeCloseTo(0.15, 12)
  })

  it('converts gross and tax at the same pay-date rate', () => {
    const rates: FxRate[] = [
      { id: 'EUR|USD|2025-06-20', base: 'EUR', quote: 'USD', date: '2025-06-20', rate: 1.085 },
    ]
    const rows = [dist('OLDT', '2025-06-20', 50, { currency: 'EUR', tax: 7.5, net: 42.5 })]
    const bucket = dividendsByPeriod(rows, 'year', 'USD', rates)[0]
    expect(bucket?.gross).toBeCloseTo(54.25, 9)
    expect(bucket?.tax).toBeCloseTo(8.1375, 9)
    expect(bucket?.net).toBeCloseTo(54.25 - 8.1375, 9)
  })

  it('counts what it could not convert instead of dropping it silently', () => {
    const rows = [dist('OLDT', '2025-06-20', 50, { currency: 'EUR' })]
    const bucket = dividendsByPeriod(rows, 'year', 'USD', [])[0]
    expect(bucket?.gross).toBe(0)
    expect(bucket?.missingFx).toBe(1)
  })

  it('excludes return of capital by default', () => {
    expect(isRegular('Return of Capital')).toBe(false)
    expect(isRegular('Ordinary Dividend')).toBe(true)
    expect(isRegular(null, 'ACME Payment in Lieu of Dividend')).toBe(false)
    const rows = [dist('ACME', '2025-04-10', 100, { divType: 'Return of Capital' })]
    expect(dividendsByPeriod(rows, 'year', 'USD', [])).toEqual([])
    expect(dividendsByPeriod(rows, 'year', 'USD', [], { regularOnly: false })[0]?.gross).toBe(100)
  })
})

describe('dividendsByPeriodGrouped splits a bucket without changing it', () => {
  const rows = [
    dist('ACME', '2025-04-10', 60),
    dist('GLOB', '2025-04-15', 10),
    dist('ACME', '2025-06-10', 40),
    dist('TINY', '2025-06-12', 5),
  ]

  it('produces exactly the buckets dividendsByPeriod does', () => {
    const plain = dividendsByPeriod(rows, 'month', 'USD', [])
    const grouped = dividendsByPeriodGrouped(rows, 'month', 'USD', [])
    expect(grouped.buckets.map(({ byInstrument: _drop, ...b }) => b)).toEqual(plain)
  })

  it('has segments that sum to the bar, bucket by bucket', () => {
    const grouped = dividendsByPeriodGrouped(rows, 'month', 'USD', [])
    for (const bucket of grouped.buckets) {
      const parts = Object.values(bucket.byInstrument).reduce((t, v) => t + v, 0)
      expect(parts).toBeCloseTo(bucket.amount, 9)
    }
    expect(grouped.buckets[0]?.byInstrument).toEqual({ ACME: 60, GLOB: 10 })
    // A month with no payment carries no segments rather than a row of zeros.
    expect(grouped.buckets[1]?.byInstrument).toEqual({})
  })

  it('totals to the same money as the ungrouped chart', () => {
    const plain = dividendsByPeriod(rows, 'quarter', 'USD', [])
    const grouped = dividendsByPeriodGrouped(rows, 'quarter', 'USD', [])
    const fromBars = plain.reduce((t, b) => t + b.amount, 0)
    const fromInstruments = Object.values(grouped.totals).reduce((t, v) => t + v, 0)
    expect(fromInstruments).toBeCloseTo(fromBars, 9)
    expect(fromInstruments).toBeCloseTo(115, 9)
  })

  it('orders by contribution, descending — that order is the colour order', () => {
    // Not first-seen (ACME, GLOB, TINY happens to match) and not alphabetical.
    const grouped = dividendsByPeriodGrouped(
      [dist('ZED', '2025-04-10', 90), dist('ACME', '2025-04-11', 5)],
      'month',
      'USD',
      [],
    )
    expect(grouped.order).toEqual(['ZED', 'ACME'])
    // Stable across the period toggle: the same window, so the same ranking.
    expect(dividendsByPeriodGrouped(rows, 'month', 'USD', []).order).toEqual(
      dividendsByPeriodGrouped(rows, 'year', 'USD', []).order,
    )
    expect(dividendsByPeriodGrouped(rows, 'month', 'USD', []).order).toEqual([
      'ACME',
      'GLOB',
      'TINY',
    ])
  })

  it('breaks a tie on the key so two equal payers never swap hues', () => {
    const tied = [dist('BBB', '2025-04-10', 10), dist('AAA', '2025-04-11', 10)]
    expect(dividendsByPeriodGrouped(tied, 'month', 'USD', []).order).toEqual(['AAA', 'BBB'])
  })

  it('splits on the same basis as the bar, net or gross', () => {
    const taxed = [
      dist('US', '2025-06-20', 100, { tax: 30, net: 70 }),
      dist('IE', '2025-06-20', 50, { tax: 0, net: 50 }),
    ]
    const gross = dividendsByPeriodGrouped(taxed, 'year', 'USD', [])
    expect(gross.buckets[0]?.amount).toBe(150)
    expect(gross.buckets[0]?.byInstrument).toEqual({ US: 100, IE: 50 })
    expect(gross.order).toEqual(['US', 'IE'])

    const net = dividendsByPeriodGrouped(taxed, 'year', 'USD', [], { net: true })
    expect(net.buckets[0]?.amount).toBe(120)
    expect(net.buckets[0]?.byInstrument).toEqual({ US: 70, IE: 50 })
    // Withholding can reorder the stack: US out-pays IE gross, barely net.
    expect(net.totals).toEqual({ US: 70, IE: 50 })
  })

  it('drops irregular payments exactly as the ungrouped chart does', () => {
    const withSpecial = [
      dist('ACME', '2025-04-10', 60),
      dist('ACME', '2025-04-11', 500, { divType: 'Return of Capital' }),
    ]
    expect(dividendsByPeriodGrouped(withSpecial, 'year', 'USD', []).totals).toEqual({ ACME: 60 })
    expect(
      dividendsByPeriodGrouped(withSpecial, 'year', 'USD', [], { regularOnly: false }).totals,
    ).toEqual({ ACME: 560 })
  })

  it('counts an unconvertible payment as missingFx and attributes it to nobody', () => {
    const grouped = dividendsByPeriodGrouped(
      [dist('ACME', '2025-06-20', 50, { currency: 'EUR' }), dist('GLOB', '2025-06-21', 10)],
      'year',
      'USD',
      [],
    )
    const bucket = grouped.buckets[0]
    expect(bucket?.missingFx).toBe(1)
    // The bar and its segments are understated together rather than disagreeing.
    expect(bucket?.amount).toBe(10)
    expect(bucket?.byInstrument).toEqual({ GLOB: 10 })
    expect(grouped.order).toEqual(['GLOB'])
  })

  it('groups a payment with no instrument under one stable Unattributed key', () => {
    const grouped = dividendsByPeriodGrouped(
      [
        dist('X', '2025-04-10', 7, { instrumentKey: null, isin: null }),
        dist('Y', '2025-04-11', 3, { instrumentKey: null, isin: null }),
      ],
      'month',
      'USD',
      [],
    )
    expect(grouped.order).toEqual([UNATTRIBUTED])
    expect(grouped.totals[UNATTRIBUTED]).toBe(10)
    expect(instrumentLabel(UNATTRIBUTED, new Map())).toBe(UNATTRIBUTED_LABEL)
  })

  it('does not split a holding whose rows only sometimes carry the key', () => {
    // Same rule the payments matrix follows, so the chart and the matrix cannot
    // disagree about how many holdings paid.
    const grouped = dividendsByPeriodGrouped(
      [
        dist('conid:123', '2024-01-15', 100, { isin: 'IE00B0M62Q58' }),
        dist('conid:123', '2024-04-15', 120, { isin: 'IE00B0M62Q58', instrumentKey: null }),
      ],
      'year',
      'USD',
      [],
    )
    expect(grouped.order).toEqual(['conid:123'])
    expect(grouped.totals).toEqual({ 'conid:123': 220 })
  })

  it('labels a key from the instrument, falling back to the key itself', () => {
    const symbols = new Map([['conid:123', 'VWRL']])
    expect(instrumentLabel('conid:123', symbols)).toBe('VWRL')
    expect(instrumentLabel('LU0000000000', symbols)).toBe('LU0000000000')
    expect(instrumentLabel('conid:9', new Map([['conid:9', '']]))).toBe('conid:9')
  })

  it("prints the user's renamed ticker over the one IBKR picked", () => {
    const instruments = [
      { key: 'conid:234004667', symbol: 'VDIVd' },
      { key: 'conid:9', symbol: 'ACME' },
    ] as unknown as Instrument[]
    const overrides = [
      { instrumentKey: 'conid:234004667', displaySymbol: 'TDIV' },
      // An empty or cleared override must not blank the ticker.
      { instrumentKey: 'conid:9', displaySymbol: '' },
    ] as InstrumentOverride[]
    const symbols = displaySymbols(instruments, overrides)
    expect(instrumentLabel('conid:234004667', symbols)).toBe('TDIV')
    expect(instrumentLabel('conid:9', symbols)).toBe('ACME')
    expect(displaySymbols(instruments).get('conid:234004667')).toBe('VDIVd')
  })

  it('is empty, not broken, with no payments', () => {
    expect(dividendsByPeriodGrouped([], 'month', 'USD', [])).toEqual({
      buckets: [],
      order: [],
      totals: {},
    })
  })
})

describe('paymentsMatrix', () => {
  const rows = [
    dist('ACME', '2025-04-10', 60),
    dist('ACME', '2025-10-10', 40),
    dist('GLOB', '2025-04-15', 10),
  ]

  it('pivots holdings against months with consistent totals', () => {
    const matrix = paymentsMatrix(rows, 'USD', [], { labels: { ACME: 'ACME CORP' } })
    expect(matrix.months).toEqual(['2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10'])
    expect(matrix.rows[0]?.label).toBe('ACME CORP')
    expect(matrix.rows[0]?.cells[0]).toBe(60)
    expect(matrix.rows[0]?.total).toBe(100)
    expect(matrix.columnTotals[0]).toBe(70)
    expect(matrix.grandTotal).toBe(110)
    // Row totals, column totals and the grand total must agree.
    const fromRows = matrix.rows.reduce((a, r) => a + r.total, 0)
    const fromColumns = matrix.columnTotals.reduce((a, c) => a + c, 0)
    expect(fromRows).toBe(matrix.grandTotal)
    expect(fromColumns).toBe(matrix.grandTotal)
  })

  it('is empty, not broken, with no payments', () => {
    expect(paymentsMatrix([], 'USD', [])).toEqual({
      months: [],
      rows: [],
      columnTotals: [],
      grandTotal: 0,
      missingFx: 0,
    })
  })
})

describe('ttmPerShare buckets by EX date', () => {
  it('counts a December ex-date in the trailing year even though it pays in January', () => {
    const rows = [
      dist('NEWT', '2026-01-15', 63, { exDate: '2025-12-31', perShare: 0.42 }),
      dist('NEWT', '2025-06-20', 50, { exDate: '2025-06-11', perShare: 0.5 }),
    ]
    const ttm = ttmPerShare(rows, '2025-12-31')
    expect(ttm?.perShare).toBeCloseTo(0.92, 12)
    expect(ttm?.count).toBe(2)
    // The pay-date view for 2025 sees only one of them. Both are correct;
    // they answer different questions.
    expect(dividendsByPeriod(rows, 'year', 'USD', [])[0]?.gross).toBe(50)
  })

  it('drops the window edge exactly one year back', () => {
    const rows = [dist('A', '2024-12-31', 1, { exDate: '2024-12-31', perShare: 1 })]
    expect(ttmPerShare(rows, '2025-12-31')).toBeNull()
    expect(ttmPerShare(rows, '2025-12-30')?.perShare).toBe(1)
  })

  it('skips a payment whose ex-date IBKR never gave us', () => {
    const rows = [dist('A', '2025-06-20', 50, { exDate: null, perShare: 0.5 })]
    expect(ttmPerShare(rows, '2025-12-31')).toBeNull()
  })

  it('reads a provider profile and ignores its projections', () => {
    const profile: DividendProfile = {
      instrumentKey: 'VDIVd',
      distributions: [
        { exDate: '2025-06-11', payDate: '2025-06-20', amount: 0.9, currency: 'EUR', declared: true },
        { exDate: '2025-12-11', payDate: '2025-12-20', amount: 0.6, currency: 'EUR', declared: true },
        { exDate: '2026-06-11', payDate: '2026-06-20', amount: 1.0, currency: 'EUR', declared: false },
      ],
      frequency: 2,
      ttmPerShare: 1.5,
      currency: 'EUR',
      isDistributing: true,
      cagr: null,
      provenance: { source: 'extraetf', asOf: '2025-12-31T00:00:00' },
    }
    expect(ttmPerShare(profile, '2025-12-31')?.perShare).toBeCloseTo(1.5, 12)
    expect(ttmPerShare(profile, '2025-12-31')?.count).toBe(2)
    expect(ttmPerShare(profile, '2026-06-30', { includeProjected: true })?.perShare).toBeCloseTo(1.6, 12)
    // No observations left in the window: fall back to the provider's own TTM.
    const stale = ttmPerShare(profile, '2027-06-30')
    expect(stale?.perShare).toBe(1.5)
    expect(stale?.count).toBe(0)
  })
})

describe('withholding', () => {
  it('is measured per instrument from the statement', () => {
    const rows = [
      dist('NL', '2025-06-20', 100, { tax: 15, net: 85 }),
      dist('US', '2025-04-10', 100, { tax: 30, net: 70 }),
      dist('US', '2025-10-10', 100, { tax: 30, net: 70 }),
      dist('IE', '2025-10-10', 100, { tax: 0, net: 100 }),
    ]
    const byKey = withholdingRateByInstrument(rows)
    expect(byKey.get('NL')).toBeCloseTo(0.15, 12)
    expect(byKey.get('US')).toBeCloseTo(0.3, 12)
    expect(byKey.get('IE')).toBe(0)
    expect(effectiveWithholdingRate(rows)).toBeCloseTo(0.1875, 12)
    expect(effectiveWithholdingRate([])).toBeNull()
  })
})

describe('yields', () => {
  const holdings = [holding('SMALL', 1000, 500), holding('BIG', 9000, 4000)]
  const forward = {
    totalBase: 910,
    byInstrument: { SMALL: 10, BIG: 900 },
    net: false,
    anchor: '2026-08-01',
  }

  it('is a ratio of sums, never an average of ratios', () => {
    const result = yields(holdings, forward)
    // Per-position yields are 1% and 10%; their mean is 5.5% and is wrong.
    expect(result.byInstrument.map((y) => y.forwardYieldPct)).toEqual([1, 10])
    expect(result.forwardYieldExCashPct).toBeCloseTo(9.1, 9)
    expect(result.forwardYieldExCashPct).not.toBeCloseTo(5.5, 6)
  })

  it('separates the ex-cash, incl-cash and on-cost numbers', () => {
    const result = yields(holdings, forward, { cashBase: 10000 })
    expect(result.marketValueExCashBase).toBe(10000)
    expect(result.marketValueInclCashBase).toBe(20000)
    // Dry powder halves the honest number; that is the point of showing both.
    expect(result.forwardYieldExCashPct).toBeCloseTo(9.1, 9)
    expect(result.forwardYieldInclCashPct).toBeCloseTo(4.55, 9)
    expect(result.yieldOnCostPct).toBeCloseTo((910 / 4500) * 100, 9)
    expect(result.anchor).toBe('2026-08-01')
  })

  it('drops excluded holdings and survives an empty portfolio', () => {
    const excluded = [{ ...holding('SMALL', 1000, 500), excluded: true }, holding('BIG', 9000, 4000)]
    expect(yields(excluded, forward).marketValueExCashBase).toBe(9000)
    expect(yields([], forward).forwardYieldExCashPct).toBeNull()
  })
})

describe('a row whose pay date is not a date', () => {
  it('is dropped rather than spinning the bucket loop until memory runs out', () => {
    const started = Date.now()
    const buckets = dividendsByPeriod(
      [dist('A', '2024-01-15', 100), dist('A', 'N/A', 20), dist('A', '', 5)],
      'month',
      'USD',
      [],
    )
    expect(Date.now() - started).toBeLessThan(1000)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.key).toBe('2024-01')
    expect(buckets[0]?.gross).toBe(100)
  })

  it('leaves paymentsMatrix bounded too', () => {
    const started = Date.now()
    const matrix = paymentsMatrix(
      [dist('A', '2024-01-15', 100), dist('A', 'N/A', 20)],
      'USD',
      [],
    )
    expect(Date.now() - started).toBeLessThan(1000)
    expect(matrix.months).toEqual(['2024-01'])
    expect(matrix.grandTotal).toBe(100)
  })
})

describe('one instrument, one matrix row', () => {
  it('does not split a holding whose statement rows only sometimes carry the key', () => {
    // IBKR matches some dividend lines to an instrument and leaves others with
    // nothing but the ISIN out of the description.
    const matrix = paymentsMatrix(
      [
        dist('conid:123', '2024-01-15', 100, { isin: 'IE00B0M62Q58' }),
        dist('conid:123', '2024-04-15', 120, { isin: 'IE00B0M62Q58', instrumentKey: null }),
      ],
      'USD',
      [],
    )
    expect(matrix.rows).toHaveLength(1)
    expect(matrix.rows[0]?.instrumentKey).toBe('conid:123')
    expect(matrix.rows[0]?.total).toBe(220)
    expect(matrix.grandTotal).toBe(220)
  })

  it('still keeps a genuinely unmatched ISIN on its own row', () => {
    const matrix = paymentsMatrix(
      [dist('X', '2024-01-15', 10, { instrumentKey: null, isin: 'LU0000000000' })],
      'USD',
      [],
    )
    expect(matrix.rows).toHaveLength(1)
    expect(matrix.rows[0]?.label).toBe('LU0000000000')
    expect(matrix.rows[0]?.instrumentKey).toBeNull()
  })
})
