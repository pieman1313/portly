import { describe, expect, it } from 'vitest'
import type { FxRate } from '../domain/types'
import {
  addDays,
  addMonths,
  convert,
  convertWithRate,
  daysBetween,
  firstOfMonth,
  fromEpochDay,
  indexRates,
  isValidISODate,
  lookupRate,
  monthKey,
  monthOfYear,
  monthsBetween,
  quarterKey,
  toEpochDay,
  yearKey,
} from './fx'

const rate = (base: string, quote: string, date: string, r: number): FxRate => ({
  id: `${base}|${quote}|${date}`,
  base,
  quote,
  date,
  rate: r,
})

// Friday 2025-06-13 and Monday 2025-06-16 exist; the weekend does not, exactly
// as Frankfurter publishes it.
const RATES: FxRate[] = [
  rate('EUR', 'USD', '2025-06-12', 1.1),
  rate('EUR', 'USD', '2025-06-13', 1.15),
  rate('EUR', 'USD', '2025-06-16', 1.2),
  rate('EUR', 'GBP', '2025-06-13', 0.85),
  rate('EUR', 'GBP', '2025-06-16', 0.86),
]

describe('convert', () => {
  it('is the identity for the same currency, with no rate table at all', () => {
    expect(convert(123.45, 'USD', 'USD', '2025-06-14', [])).toBe(123.45)
  })

  it('uses the direct rate when the exact day is published', () => {
    expect(convert(100, 'EUR', 'USD', '2025-06-13', RATES)).toBeCloseTo(115, 10)
  })

  it('falls back to the nearest PRIOR business day over a weekend', () => {
    // Saturday: ECB published nothing, so Friday's rate stands.
    const hit = convertWithRate(100, 'EUR', 'USD', '2025-06-14', RATES)
    expect(hit?.amount).toBeCloseTo(115, 10)
    expect(hit?.rateDate).toBe('2025-06-13')
  })

  it('never reaches FORWARD to a later rate', () => {
    expect(convert(100, 'EUR', 'USD', '2025-06-11', RATES)).toBeNull()
  })

  it('inverts a pair published in only one direction', () => {
    expect(convert(115, 'USD', 'EUR', '2025-06-13', RATES)).toBeCloseTo(100, 10)
  })

  it('crosses through EUR when the direct pair is missing', () => {
    // An ECB-sourced table has no GBP|USD leg at all.
    const hit = lookupRate('GBP', 'USD', '2025-06-13', RATES)
    expect(hit?.via).toBe('EUR')
    expect(hit?.rate).toBeCloseTo(1.15 / 0.85, 10)
  })

  it('reports the staler of the two legs as the effective date', () => {
    const sparse = [...RATES, rate('EUR', 'CHF', '2025-06-10', 0.95)]
    const hit = lookupRate('CHF', 'USD', '2025-06-13', sparse)
    expect(hit?.date).toBe('2025-06-10')
  })

  it('returns null rather than guessing when the rate is too stale', () => {
    expect(convert(100, 'EUR', 'USD', '2025-08-01', RATES)).toBeNull()
    expect(convert(100, 'EUR', 'USD', '2025-08-01', RATES, { maxStaleDays: 400 })).toBeCloseTo(120, 10)
  })

  it('returns null for a currency it has never seen', () => {
    expect(convert(100, 'JPY', 'USD', '2025-06-13', RATES)).toBeNull()
  })

  it('ignores non-positive rates when indexing', () => {
    const index = indexRates([rate('EUR', 'SEK', '2025-06-13', 0)])
    expect(index.pairs.size).toBe(0)
  })
})

describe('calendar', () => {
  it('never overflows a month-end', () => {
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2025-12-15', 1)).toBe('2026-01-15')
    expect(addMonths('2025-03-15', -3)).toBe('2024-12-15')
  })

  it('measures days and months', () => {
    expect(daysBetween('2025-01-01', '2025-12-31')).toBe(364)
    expect(daysBetween('2025-06-16', '2025-06-13')).toBe(-3)
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01')
    expect(monthsBetween('2025-12-20', '2026-01-05')).toBe(1)
  })

  it('keys periods', () => {
    expect(monthKey('2025-06-13T10:00:00')).toBe('2025-06')
    expect(quarterKey('2025-06-13')).toBe('2025-Q2')
    expect(quarterKey('2025-10-01')).toBe('2025-Q4')
    expect(yearKey('2025-06-13')).toBe('2025')
    expect(firstOfMonth('2025-06-13')).toBe('2025-06-01')
    expect(monthOfYear('2025-06-13')).toBe(6)
  })
})

describe('unparseable dates degrade instead of throwing', () => {
  it('does not turn a blank date into 1899', () => {
    // Number('') is 0, so the old parse made '' a real day in November 1899
    // that then sorted and bucketed alongside genuine dates.
    expect(isValidISODate('')).toBe(false)
    expect(isValidISODate('N/A')).toBe(false)
    expect(isValidISODate('2025-06-13T10:00:00')).toBe(true)
    expect(Number.isNaN(toEpochDay(''))).toBe(true)
    expect(Number.isNaN(toEpochDay('N/A'))).toBe(true)
  })

  it('returns an empty date rather than raising RangeError', () => {
    expect(() => addDays('N/A', 1)).not.toThrow()
    expect(addDays('N/A', 1)).toBe('')
    expect(addDays('2025-01-01', NaN)).toBe('')
    expect(fromEpochDay(NaN)).toBe('')
    expect(addMonths('', 1)).toBe('')
    expect(addMonths('0NaN-NaN-NaN', 1)).toBe('')
    // And the empty result does not parse back into a plausible day.
    expect(Number.isNaN(toEpochDay(addMonths('N/A', 1)))).toBe(true)
  })
})
