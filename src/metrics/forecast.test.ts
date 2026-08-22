import { describe, expect, it } from 'vitest'
import type { Accrual, DividendProfile, FxRate, ProviderDistribution } from '../domain/types'
import type { Holding } from './holdings'
import { forwardIncome, project12Months, seasonality } from './forecast'
import { yields } from './income'

const TODAY = '2026-08-21'

function holding(instrumentKey: string, quantity: number, extra: Partial<Holding> = {}): Holding {
  return {
    instrumentKey,
    symbol: instrumentKey,
    name: instrumentKey,
    assetCategory: 'Stocks',
    instrument: null,
    currency: 'USD',
    quantity,
    quantitySource: 'ledger',
    method: 'FIFO',
    costBasis: 1000,
    costBasisBase: 1000,
    avgUnitCost: 10,
    price: 12,
    priceCurrency: 'USD',
    priceSource: 'quote',
    priceAsOf: `${TODAY}T20:00:00`,
    marketValue: quantity * 12,
    marketValueBase: quantity * 12,
    unrealizedPnl: 0,
    unrealizedPnlBase: 0,
    realizedPnl: 0,
    realizedPnlBase: 0,
    totalPnlBase: 0,
    weightPct: null,
    closed: false,
    excluded: false,
    uncoveredShares: 0,
    reopens: 0,
    lots: [],
    sales: [],
    check: null,
    ...extra,
  }
}

function pd(exDate: string, payDate: string, amount: number, currency = 'USD'): ProviderDistribution {
  return { exDate, payDate, amount, currency, declared: true }
}

function profile(
  instrumentKey: string,
  distributions: ProviderDistribution[],
  extra: Partial<DividendProfile> = {},
): DividendProfile {
  return {
    instrumentKey,
    distributions,
    frequency: distributions.length,
    ttmPerShare: distributions.reduce((a, d) => a + d.amount, 0),
    currency: distributions[0]?.currency ?? 'USD',
    isDistributing: true,
    cagr: null,
    provenance: { source: 'extraetf', asOf: `${TODAY}T00:00:00` },
    ...extra,
  }
}

function accrual(
  instrumentKey: string,
  exDate: string,
  payDate: string,
  gross: number,
  extra: Partial<Accrual> = {},
): Accrual {
  return {
    id: `a-${instrumentKey}-${payDate}`,
    fileIds: ['f1'],
    sourceRowIds: ['f1:1'],
    instrumentKey,
    exDate,
    payDate,
    quantity: 100,
    grossRate: gross / 100,
    currency: 'USD',
    gross,
    tax: 0,
    net: gross,
    open: true,
    supersededAt: null,
    ...extra,
  }
}

// Violently seasonal, like a real UCITS distributor: 60% of the year in June.
const SEASONAL = [pd('2025-12-11', '2025-12-20', 0.4), pd('2026-06-11', '2026-06-20', 0.6)]

describe('the window', () => {
  it('is 12 months anchored on the 1st of the current month', () => {
    const forecast = project12Months([], [], [], 'USD', [], TODAY)
    expect(forecast.anchor).toBe('2026-08-01')
    expect(forecast.end).toBe('2027-07-31')
    expect(forecast.months).toHaveLength(12)
    expect(forecast.months[0]?.month).toBe('2026-08')
    expect(forecast.months[11]?.month).toBe('2027-07')
  })
})

describe('declared income', () => {
  it('comes from open accruals, to the cent, in their pay month', () => {
    const forecast = project12Months(
      [holding('NEWT', 150)],
      [accrual('NEWT', '2026-08-31', '2026-09-15', 63, { tax: 9.45, net: 53.55 })],
      [],
      'USD',
      [],
      TODAY,
    )
    const september = forecast.months[1]
    expect(september?.month).toBe('2026-09')
    expect(september?.items[0]?.basis).toBe('declared')
    expect(september?.items[0]?.gross).toBe(63)
    expect(september?.declaredBase).toBe(63)
    expect(forecast.totalGrossBase).toBe(63)
    expect(forecast.totalNetBase).toBe(53.55)
  })

  it('ignores reversed accruals and anything outside the window', () => {
    const forecast = project12Months(
      [holding('NEWT', 150)],
      [
        accrual('NEWT', '2026-08-31', '2026-09-15', 63, { open: false }),
        accrual('NEWT', '2027-08-31', '2027-09-15', 70),
        accrual('NEWT', '2026-07-01', '2026-07-15', 12),
      ],
      [],
      'USD',
      [],
      TODAY,
    )
    expect(forecast.totalGrossBase).toBe(0)
  })
})

describe('estimated income preserves seasonality', () => {
  it('places the TTM total in the months the instrument actually pays in', () => {
    const forecast = project12Months(
      [holding('SEAS', 100)],
      [],
      [profile('SEAS', SEASONAL)],
      'USD',
      [],
      TODAY,
    )
    const byMonth = Object.fromEntries(forecast.months.map((m) => [m.month, m.grossBase]))
    expect(byMonth['2026-12']).toBeCloseTo(40, 9)
    expect(byMonth['2027-06']).toBeCloseTo(60, 9)
    expect(byMonth['2026-08']).toBe(0)
    // Not TTM/12 smeared across the year, and not 60% x 2 payments a year.
    expect(byMonth['2026-09']).not.toBeCloseTo(100 / 12, 6)
    expect(forecast.totalGrossBase).toBeCloseTo(100, 9)
    expect(forecast.months[4]?.items[0]?.basis).toBe('estimated')
  })

  it('shifts the payment by the observed ex-to-pay lag', () => {
    const lagged = [pd('2025-12-11', '2026-01-20', 0.4), pd('2026-06-11', '2026-07-20', 0.6)]
    const shape = seasonality(profile('LAG', lagged), TODAY)
    expect(shape?.lagMonths).toBe(1)
    const forecast = project12Months([holding('LAG', 100)], [], [profile('LAG', lagged)], 'USD', [], TODAY)
    const byMonth = Object.fromEntries(forecast.months.map((m) => [m.month, m.grossBase]))
    expect(byMonth['2027-01']).toBeCloseTo(40, 9)
    expect(byMonth['2027-07']).toBeCloseTo(60, 9)
    expect(byMonth['2026-12']).toBe(0)
  })

  it('scales with the CURRENT quantity, not the historical one', () => {
    const forecast = project12Months(
      [holding('SEAS', 250)],
      [],
      [profile('SEAS', SEASONAL)],
      'USD',
      [],
      TODAY,
    )
    expect(forecast.totalGrossBase).toBeCloseTo(250, 9)
  })

  it('nets with the withholding actually suffered, not an assumed rate', () => {
    const forecast = project12Months(
      [holding('SEAS', 100)],
      [],
      [profile('SEAS', SEASONAL)],
      'USD',
      [],
      TODAY,
      { net: true, withholdingRates: new Map([['SEAS', 0.15]]) },
    )
    expect(forecast.totalNetBase).toBeCloseTo(85, 9)
    expect(forecast.totalBase).toBeCloseTo(85, 9)
  })

  it('falls back to the last 12 months it has, flagged stale', () => {
    const old = [pd('2024-06-11', '2024-06-20', 1.0)]
    const shape = seasonality(profile('OLD', old), TODAY)
    expect(shape?.stale).toBe(true)
    const forecast = project12Months([holding('OLD', 10)], [], [profile('OLD', old)], 'USD', [], TODAY)
    expect(forecast.coverage.staleHistory).toEqual(['OLD'])
    expect(forecast.totalGrossBase).toBeCloseTo(10, 9)
  })
})

describe('declared and estimated never double-count', () => {
  it('suppresses the estimate for an instrument-month a declared accrual covers', () => {
    const forecast = project12Months(
      [holding('SEAS', 100)],
      [accrual('SEAS', '2026-12-11', '2026-12-20', 42)],
      [profile('SEAS', SEASONAL)],
      'USD',
      [],
      TODAY,
    )
    const december = forecast.months.find((m) => m.month === '2026-12')
    expect(december?.items).toHaveLength(1)
    expect(december?.items[0]?.basis).toBe('declared')
    expect(december?.grossBase).toBe(42)
    // The June estimate is untouched — only that one month is covered.
    expect(forecast.months.find((m) => m.month === '2027-06')?.grossBase).toBeCloseTo(60, 9)
    expect(forecast.totalGrossBase).toBeCloseTo(102, 9)
  })
})

describe('the declared/estimated guard survives a lag mismatch', () => {
  it('does not pay the same dividend twice when the modelled month is off by one', () => {
    // History: ex late in August, paid the same month, so the modelled lag is
    // zero and the estimate lands in August. IBKR's real accrual for this
    // year's August ex-date pays in September.
    const lateAugust = [pd('2025-08-28', '2025-08-30', 1.0)]
    const forecast = project12Months(
      [holding('LAG', 100)],
      [accrual('LAG', '2026-08-27', '2026-09-04', 95)],
      [profile('LAG', lateAugust)],
      'USD',
      [],
      TODAY,
    )
    const items = forecast.months.flatMap((m) => m.items)
    expect(items).toHaveLength(1)
    expect(items[0]?.basis).toBe('declared')
    expect(forecast.totalGrossBase).toBe(95)
  })
})

describe('degrading without provider data', () => {
  it('emits declared-only and reports zero coverage', () => {
    const forecast = project12Months(
      [holding('A', 100), holding('B', 100)],
      [accrual('A', '2026-08-31', '2026-09-15', 20)],
      [],
      'USD',
      [],
      TODAY,
    )
    expect(forecast.totalGrossBase).toBe(20)
    expect(forecast.coverage).toMatchObject({
      positions: 2,
      estimated: 0,
      declaredOnly: ['A'],
      missing: ['B'],
      ratio: 0,
    })
  })

  it('does not call an accumulating ETF missing', () => {
    const forecast = project12Months(
      [holding('ACC', 100)],
      [],
      [profile('ACC', [], { isDistributing: false, ttmPerShare: 0 })],
      'USD',
      [],
      TODAY,
    )
    expect(forecast.coverage.missing).toEqual([])
    expect(forecast.totalGrossBase).toBe(0)
  })

  it('skips closed and excluded positions', () => {
    const forecast = project12Months(
      [holding('SEAS', 0), holding('SEAS2', 100, { excluded: true })],
      [],
      [profile('SEAS', SEASONAL), profile('SEAS2', SEASONAL)],
      'USD',
      [],
      TODAY,
    )
    expect(forecast.coverage.positions).toBe(0)
    expect(forecast.totalGrossBase).toBe(0)
  })
})

describe('currency', () => {
  const rates: FxRate[] = [
    { id: 'EUR|USD|2026-08-20', base: 'EUR', quote: 'USD', date: '2026-08-20', rate: 1.2 },
  ]
  const eurProfile = profile('EUR1', [pd('2026-06-11', '2026-06-20', 1.0, 'EUR')])

  it('converts forward estimates at today’s rate', () => {
    const forecast = project12Months([holding('EUR1', 100)], [], [eurProfile], 'USD', rates, TODAY)
    expect(forecast.totalGrossBase).toBeCloseTo(120, 9)
    expect(forecast.coverage.missingFx).toEqual([])
  })

  it('says unavailable rather than guessing', () => {
    const forecast = project12Months([holding('EUR1', 100)], [], [eurProfile], 'USD', [], TODAY)
    expect(forecast.coverage.missingFx).toEqual(['EUR1'])
    const item = forecast.months.flatMap((m) => m.items)[0]
    expect(item?.gross).toBeCloseTo(100, 9)
    expect(item?.grossBase).toBeNull()
    expect(forecast.totalGrossBase).toBe(0)
  })
})

describe('forwardIncome adapter', () => {
  it('feeds the yield block with a total that matches the buckets', () => {
    const forecast = project12Months(
      [holding('SEAS', 100), holding('OTHER', 50)],
      [accrual('OTHER', '2026-08-31', '2026-09-15', 25)],
      [profile('SEAS', SEASONAL)],
      'USD',
      [],
      TODAY,
    )
    const income = forwardIncome(forecast)
    expect(income.totalBase).toBeCloseTo(125, 9)
    expect(income.byInstrument['SEAS']).toBeCloseTo(100, 9)
    expect(income.byInstrument['OTHER']).toBe(25)
    expect(income.anchor).toBe('2026-08-01')

    const y = yields([holding('SEAS', 100), holding('OTHER', 50)], income)
    // 125 of income on 1800 of market value, as a ratio of sums.
    expect(y.forwardYieldExCashPct).toBeCloseTo((125 / 1800) * 100, 9)
  })
})

describe('excluded positions are excluded from income too', () => {
  it('drops a declared accrual belonging to an instrument the user switched off', () => {
    const holdings = [holding('CORE', 100), holding('EXCL', 100, { excluded: true })]
    const forecast = project12Months(
      holdings,
      [accrual('EXCL', '2026-08-25', '2026-09-10', 500)],
      [],
      'USD',
      [],
      TODAY,
    )
    expect(forecast.totalBase).toBe(0)
    expect(forecast.months.flatMap((m) => m.items)).toEqual([])
  })

  it('so the yield is not computed from income the denominator never saw', () => {
    const holdings = [holding('CORE', 100), holding('EXCL', 100, { excluded: true })]
    const forecast = project12Months(
      holdings,
      [accrual('EXCL', '2026-08-25', '2026-09-10', 500)],
      [],
      'USD',
      [],
      TODAY,
    )
    // CORE is 100 x 12 = 1200 of market value and pays nothing we know about.
    expect(yields(holdings, forwardIncome(forecast)).forwardYieldExCashPct).toBe(0)
  })

  it('still counts an accrual for a position that has been sold', () => {
    // The record date has passed: the cash is coming whether or not it is held.
    const forecast = project12Months(
      [],
      [accrual('GONE', '2026-08-25', '2026-09-10', 500)],
      [],
      'USD',
      [],
      TODAY,
    )
    expect(forecast.totalBase).toBe(500)
  })
})

describe('rounding residue is not forward income', () => {
  it('drops a declared accrual worth a cent', () => {
    // `Accrual.open` keeps the cent a restated Po/Re pair leaves behind, because
    // IBKR's own Ending Dividend Accruals counts it and the reconciliation has
    // to agree with the broker. The forecast is a different question: a real
    // statement produced "August: -$0.01", which is worse than saying nothing.
    const f = project12Months(
      [holding('JEPQ', 882)],
      [
        accrual('JEPQ', '2026-07-09', '2026-08-07', -0.01, { net: -0.01 }),
        accrual('JEPQ', '2026-08-13', '2026-09-04', 563.05, { net: 563.05 }),
      ],
      [],
      'USD',
      [],
      '2026-08-22',
      { net: true },
    )
    const items = f.months.flatMap((m) => m.items)
    expect(items).toHaveLength(1)
    expect(items[0]?.month).toBe('2026-09')
    expect(f.totalBase).toBeCloseTo(563.05, 2)
  })
})
