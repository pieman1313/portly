import { describe, expect, it } from 'vitest'
import type { CashEvent, FxRate } from '../domain/types'
import {
  annualize,
  externalFlows,
  isExternalFlow,
  maxDrawdown,
  modifiedDietz,
  portfolioFlows,
  twr,
  xirr,
  xnpv,
} from './returns'

describe('xirr', () => {
  it('solves the textbook case with the documented sign convention', () => {
    // 1000 in (negative), 1100 out (positive), one year apart.
    const r = xirr([
      { date: '2025-01-01', amount: -1000 },
      { date: '2026-01-01', amount: 1100 },
    ])
    expect(r).not.toBeNull()
    expect(r as number).toBeCloseTo(0.1, 6)
  })

  it('drives the NPV of the solved rate to zero', () => {
    const flows = [
      { date: '2024-01-01', amount: -10000 },
      { date: '2024-07-01', amount: -5000 },
      { date: '2025-03-15', amount: 2000 },
      { date: '2026-01-01', amount: 14500 },
    ]
    const r = xirr(flows)
    expect(r).not.toBeNull()
    expect(xnpv(r as number, flows)).toBeCloseTo(0, 6)
  })

  it('cannot detect a flipped sign convention — hence portfolioFlows', () => {
    const correct = xirr([
      { date: '2025-01-01', amount: -1000 },
      { date: '2026-01-01', amount: 1100 },
    ])
    const inverted = xirr([
      { date: '2025-01-01', amount: 1000 },
      { date: '2026-01-01', amount: -1100 },
    ])
    expect(correct as number).toBeCloseTo(0.1, 6)
    // Same magnitude, opposite meaning — which is why portfolioFlows exists.
    expect(inverted as number).toBeCloseTo(0.1, 6)
  })

  it('returns null under 90 days rather than annualizing noise', () => {
    // +2% over three days annualizes to roughly +1000%.
    expect(
      xirr([
        { date: '2025-01-01', amount: -1000 },
        { date: '2025-01-04', amount: 1020 },
      ]),
    ).toBeNull()
  })

  it('returns null when it cannot answer instead of throwing', () => {
    expect(xirr([])).toBeNull()
    expect(xirr([{ date: '2025-01-01', amount: -1000 }])).toBeNull()
    // All money in, nothing ever came back: no rate exists.
    expect(
      xirr([
        { date: '2025-01-01', amount: -1000 },
        { date: '2026-01-01', amount: -1000 },
      ]),
    ).toBeNull()
  })

  it('handles a total loss without leaving the bracket', () => {
    const r = xirr([
      { date: '2025-01-01', amount: -1000 },
      { date: '2026-01-01', amount: 1 },
    ])
    expect(r).not.toBeNull()
    expect(r as number).toBeLessThan(-0.99)
    expect(r as number).toBeGreaterThanOrEqual(-0.9999)
  })

  it('needs the opening and closing values, and portfolioFlows supplies them', () => {
    const flows = portfolioFlows({
      start: '2025-01-01',
      end: '2025-12-31',
      valueStart: 10000,
      valueEnd: 13000,
      contributions: [{ date: '2025-06-30', amount: 2000 }],
    })
    expect(flows[0]).toEqual({ date: '2025-01-01', amount: -10000 })
    expect(flows[1]).toEqual({ date: '2025-06-30', amount: -2000 })
    expect(flows[2]).toEqual({ date: '2025-12-31', amount: 13000 })
    const r = xirr(flows)
    expect(r).not.toBeNull()
    // 3000 gained on ~11000 average capital, so meaningfully more than 3000/12000.
    expect(r as number).toBeGreaterThan(0.08)
    expect(r as number).toBeLessThan(0.12)
  })
})

describe('modifiedDietz', () => {
  it('weights a flow by the fraction of the period it was invested', () => {
    // Half-period contribution: r = (11500 - 10000 - 1000) / (10000 + 500)
    const r = modifiedDietz(10000, 11500, [{ date: '2025-07-02', amount: 1000 }], 365, '2025-01-01')
    expect(r).not.toBeNull()
    expect(r as number).toBeCloseTo(500 / 10500, 3)
  })

  it('falls back to Simple Dietz when no start date is given', () => {
    const r = modifiedDietz(10000, 11500, [{ date: '2025-07-02', amount: 1000 }], 365)
    expect(r as number).toBeCloseTo(500 / 10500, 9)
  })

  it('returns null on an empty denominator instead of Infinity', () => {
    expect(modifiedDietz(0, 100, [], 365)).toBeNull()
    expect(modifiedDietz(100, 200, [], 0)).toBeNull()
  })
})

describe('annualize', () => {
  it('refuses to annualize under a year', () => {
    expect(annualize(0.04, 21)).toBeNull()
    expect(annualize(0.21, 730) as number).toBeCloseTo(Math.pow(1.21, 0.5) - 1, 9)
  })
})

describe('twr', () => {
  it('is unmoved by a buy, because cash is inside the portfolio', () => {
    // Day 1 spends 1000 of cash on stock. Total value is unchanged.
    const result = twr(
      [
        { date: '2025-01-01', value: 1000 },
        { date: '2025-01-02', value: 1000 },
        { date: '2025-01-03', value: 1100 },
      ],
      [],
    )
    expect(result.cumulative as number).toBeCloseTo(0.1, 12)
  })

  it('is unmoved by a deposit (start of day) or a withdrawal (end of day)', () => {
    const deposit = twr(
      [
        { date: '2025-01-01', value: 1000 },
        { date: '2025-01-02', value: 2000 },
      ],
      [{ date: '2025-01-02', amount: 1000 }],
    )
    expect(deposit.cumulative as number).toBeCloseTo(0, 12)

    const withdrawal = twr(
      [
        { date: '2025-01-01', value: 1000 },
        { date: '2025-01-02', value: 500 },
      ],
      [{ date: '2025-01-02', amount: -500 }],
    )
    expect(withdrawal.cumulative as number).toBeCloseTo(0, 12)
  })

  it('chains daily returns multiplicatively', () => {
    const result = twr([
      { date: '2025-01-01', value: 100 },
      { date: '2025-01-02', value: 110 },
      { date: '2025-01-03', value: 99 },
    ])
    expect(result.cumulative as number).toBeCloseTo(-0.01, 12)
    expect(result.index[2]?.index).toBeCloseTo(99, 12)
  })

  it('does not annualize under a year', () => {
    const short = twr([
      { date: '2025-01-01', value: 100 },
      { date: '2025-06-01', value: 120 },
    ])
    expect(short.annualized).toBeNull()
    const long = twr([
      { date: '2024-01-01', value: 100 },
      { date: '2026-01-01', value: 121 },
    ])
    expect(long.annualized as number).toBeCloseTo(Math.pow(1.21, 365 / 731) - 1, 9)
  })

  it('skips a zero-base day and restarts the chain', () => {
    const result = twr(
      [
        { date: '2025-01-01', value: 100 },
        { date: '2025-01-02', value: 0 },
        { date: '2025-01-03', value: 500 },
        { date: '2025-01-04', value: 550 },
      ],
      [
        { date: '2025-01-02', amount: -100 },
        { date: '2025-01-03', amount: 500 },
      ],
    )
    expect(result.restarts).toEqual([])
    expect(Number.isFinite(result.cumulative as number)).toBe(true)

    // Now the same emptying with no flows recorded: the denominator is zero.
    const broken = twr([
      { date: '2025-01-01', value: 100 },
      { date: '2025-01-02', value: 0 },
      { date: '2025-01-03', value: 500 },
    ])
    expect(broken.restarts).toEqual(['2025-01-03'])
    expect(Number.isFinite(broken.cumulative as number)).toBe(true)
  })
})

describe('maxDrawdown', () => {
  const index = [
    { date: '2025-01-01', index: 100 },
    { date: '2025-02-01', index: 120 },
    { date: '2025-03-01', index: 90 },
    { date: '2025-04-01', index: 110 },
    { date: '2025-05-01', index: 125 },
    { date: '2025-06-01', index: 115 },
  ]

  it('measures depth from the running peak', () => {
    const dd = maxDrawdown(index)
    expect(dd.depth).toBeCloseTo(90 / 120 - 1, 12)
    expect(dd.worst?.peakDate).toBe('2025-02-01')
    expect(dd.worst?.troughDate).toBe('2025-03-01')
  })

  it('measures duration peak-to-RECOVERY, not peak-to-trough', () => {
    const dd = maxDrawdown(index)
    expect(dd.worst?.recoveryDate).toBe('2025-05-01')
    // 2025-02-01 to 2025-05-01, not 2025-02-01 to 2025-03-01.
    expect(dd.worst?.durationDays).toBe(89)
  })

  it('leaves an unrecovered drawdown open', () => {
    const dd = maxDrawdown(index)
    const ongoing = dd.episodes.find((e) => e.ongoing)
    expect(ongoing?.peakDate).toBe('2025-05-01')
    expect(ongoing?.recoveryDate).toBeNull()
    expect(ongoing?.durationDays).toBeNull()
  })

  it('does not call a withdrawal a drawdown', () => {
    // Portfolio value halves because half of it was withdrawn; the TWR index
    // is flat, so there is no drawdown at all.
    const values = [
      { date: '2025-01-01', value: 1000 },
      { date: '2025-01-02', value: 500 },
      { date: '2025-01-03', value: 500 },
    ]
    const chain = twr(values, [{ date: '2025-01-02', amount: -500 }])
    expect(maxDrawdown(chain.index).depth).toBeCloseTo(0, 12)
    // The same series read as raw value would report a 50% drawdown.
    expect(maxDrawdown(values.map((v) => ({ date: v.date, index: v.value }))).depth).toBeCloseTo(-0.5, 12)
  })
})

describe('the portfolio boundary', () => {
  it('counts only deposits and withdrawals as external', () => {
    expect(isExternalFlow('DEPOSIT')).toBe(true)
    expect(isExternalFlow('WITHDRAWAL')).toBe(true)
    for (const kind of ['INTEREST', 'FEE', 'TAX', 'FX', 'OTHER'] as const) {
      expect(isExternalFlow(kind)).toBe(false)
    }
  })

  it('converts every flow at the rate on its own date', () => {
    const rates: FxRate[] = [
      { id: 'EUR|USD|2025-01-15', base: 'EUR', quote: 'USD', date: '2025-01-15', rate: 1.0 },
      { id: 'EUR|USD|2025-07-15', base: 'EUR', quote: 'USD', date: '2025-07-15', rate: 1.2 },
    ]
    const events: CashEvent[] = [
      cash('DEPOSIT', '2025-01-15', 1000, 'EUR'),
      cash('DEPOSIT', '2025-07-15', 1000, 'EUR'),
      cash('INTEREST', '2025-07-15', 12.34, 'EUR'),
      cash('DEPOSIT', '2024-01-01', 500, 'EUR'),
    ]
    const { flows, missingFx } = externalFlows(events, 'USD', rates)
    expect(flows).toHaveLength(2)
    expect(flows[0]?.amount).toBeCloseTo(1000, 9)
    // Same 1000 EUR, different day, genuinely different USD.
    expect(flows[1]?.amount).toBeCloseTo(1200, 9)
    expect(missingFx).toHaveLength(1)
  })
})

function cash(
  kind: CashEvent['kind'],
  date: string,
  amount: number,
  currency: string,
): CashEvent {
  return {
    id: `${kind}-${date}`,
    fileIds: ['f1'],
    sourceRowIds: ['f1:1'],
    kind,
    date,
    amount,
    currency,
    description: kind,
    supersededAt: null,
  }
}

describe('flows that do not land on a valuation date', () => {
  it('does not read a weekend deposit as a 100% gain', () => {
    // Friday 10k, deposit 10k over the weekend, Monday 20k. Nothing was earned.
    const result = twr(
      [
        { date: '2024-01-05', value: 10000 },
        { date: '2024-01-08', value: 20000 },
      ],
      [{ date: '2024-01-06', amount: 10000 }],
    )
    expect(result.cumulative).toBeCloseTo(0, 12)
  })

  it('does not read an off-calendar withdrawal as a collapse', () => {
    const result = twr(
      [
        { date: '2024-01-05', value: 20000 },
        { date: '2024-01-08', value: 10000 },
      ],
      [{ date: '2024-01-07', amount: -10000 }],
    )
    expect(result.cumulative).toBeCloseTo(0, 12)
  })

  it('ignores a flow after the last valuation, as before', () => {
    const result = twr(
      [
        { date: '2024-01-05', value: 10000 },
        { date: '2024-01-08', value: 10000 },
      ],
      [{ date: '2024-02-01', amount: 5000 }],
    )
    expect(result.cumulative).toBeCloseTo(0, 12)
  })
})

describe('non-finite inputs', () => {
  it('annualize says unavailable instead of returning NaN', () => {
    // NaN < 365 is false, so an unmeasurable period used to slip through.
    expect(annualize(0.1, NaN)).toBeNull()
    expect(annualize(0.1, Infinity)).toBeNull()
    expect(annualize(NaN, 400)).toBeNull()
  })

  it('modifiedDietz says unavailable when the start date will not parse', () => {
    expect(modifiedDietz(1000, 1200, [{ date: '2024-06-01', amount: 100 }], 365, 'N/A')).toBeNull()
  })
})
