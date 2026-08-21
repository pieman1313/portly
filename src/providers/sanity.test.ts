import { describe, expect, it } from 'vitest'
import type { Quote } from '../domain/types'
import { applyPriceUnit, checkQuote, detectPriceUnit } from './sanity'

function quote(price: number, currency = 'EUR', asOf = '2026-08-20T16:00:00'): Quote {
  return {
    instrumentKey: 'isin:IE00B0M63060',
    price,
    currency,
    previousClose: null,
    provenance: { source: 'stockanalysis', asOf },
  }
}

describe('detectPriceUnit', () => {
  it('spots GBX by self-calibrating against the statement close', () => {
    // stockanalysis: {"p":1032.4} for LON-IUKD, no currency field at all.
    // The CSV's own Close Price for the LSE line is GBP 10.324.
    expect(detectPriceUnit(1032.4, 10.324)).toBe('minor')
  })

  it('tolerates a real price move while still calling it pence', () => {
    expect(detectPriceUnit(1032.4, 9.6)).toBe('minor') // ratio 107.5
    expect(detectPriceUnit(1032.4, 11.3)).toBe('minor') // ratio 91.4
  })

  it('calls a normal quote major', () => {
    expect(detectPriceUnit(50.67, 50.4)).toBe('major')
    expect(detectPriceUnit(12.054, 12.0)).toBe('major')
  })

  it('answers unknown rather than guessing when the two are different currencies', () => {
    // IUKD: GBX 1032.4 against the Milan EUR 12.054 close is a ratio of 85.6 —
    // near neither 1 nor 100. Guessing here is exactly the 100x bug.
    expect(detectPriceUnit(1032.4, 12.054)).toBe('unknown')
  })

  it('answers unknown on missing or nonsensical inputs', () => {
    expect(detectPriceUnit(10, null)).toBe('unknown')
    expect(detectPriceUnit(10, undefined)).toBe('unknown')
    expect(detectPriceUnit(10, 0)).toBe('unknown')
    expect(detectPriceUnit(0, 10)).toBe('unknown')
    expect(detectPriceUnit(Number.NaN, 10)).toBe('unknown')
  })
})

describe('applyPriceUnit', () => {
  it('divides only minor units', () => {
    expect(applyPriceUnit(1032.4, 'minor')).toBeCloseTo(10.324, 9)
    expect(applyPriceUnit(1032.4, 'major')).toBe(1032.4)
    expect(applyPriceUnit(1032.4, 'unknown')).toBe(1032.4)
  })
})

describe('checkQuote', () => {
  const expected = { currency: 'EUR' as const }

  it('accepts a normal move', () => {
    const r = checkQuote(quote(12.4), quote(12.0, 'EUR', '2026-08-19T16:00:00'), expected)
    expect(r.ok).toBe(true)
  })

  it('rejects a 100x jump against the cached price', () => {
    const r = checkQuote(quote(1032.4), quote(10.324, 'EUR', '2026-08-19T16:00:00'), expected)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/exceeds 20%/)
  })

  it('rejects a 1/100 collapse just as hard', () => {
    const r = checkQuote(quote(10.324), quote(1032.4, 'EUR', '2026-08-19T16:00:00'), expected)
    expect(r.ok).toBe(false)
  })

  it('rejects a currency mismatch against the statement', () => {
    const r = checkQuote(quote(12.4, 'USD'), null, { currency: 'EUR' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/currency USD but expected EUR/)
  })

  it('rejects a currency change against the cached quote', () => {
    const r = checkQuote(quote(12.4, 'GBP'), quote(12.3, 'GBP'), { currency: null })
    expect(r.ok).toBe(true)
    const swapped = checkQuote(quote(12.4, 'USD'), quote(12.3, 'GBP'), { currency: null })
    expect(swapped.ok).toBe(false)
  })

  it('rejects non-positive and non-finite prices', () => {
    expect(checkQuote(quote(0), null, expected).ok).toBe(false)
    expect(checkQuote(quote(-1), null, expected).ok).toBe(false)
    expect(checkQuote(quote(Number.NaN), null, expected).ok).toBe(false)
    expect(checkQuote(quote(Number.POSITIVE_INFINITY), null, expected).ok).toBe(false)
  })

  it('rejects a response older than what we already hold', () => {
    const prev = quote(12.0, 'EUR', '2026-08-20T16:00:00')
    const stale = quote(12.1, 'EUR', '2026-08-18T16:00:00')
    const r = checkQuote(stale, prev, expected)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/older than cached/)
  })

  it('accepts an identical timestamp — a repeat poll is not a regression', () => {
    const prev = quote(12.0, 'EUR', '2026-08-20T16:00:00')
    expect(checkQuote(quote(12.0, 'EUR', '2026-08-20T16:00:00'), prev, expected).ok).toBe(true)
  })

  it('rejects a malformed quote object', () => {
    expect(checkQuote({} as unknown as Quote, null, expected).ok).toBe(false)
    const noProvenance = { ...quote(12), provenance: undefined } as unknown as Quote
    expect(checkQuote(noProvenance, null, expected).ok).toBe(false)
  })

  it('catches the 100x on the FIRST fetch, using the statement close as reference', () => {
    const r = checkQuote(quote(1032.4), null, { currency: 'EUR', closePrice: 10.324 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/away from statement close/)
  })

  it('still allows a stale statement close to differ substantially', () => {
    // Months-old close, or a cross-listed line quoted on another venue.
    expect(checkQuote(quote(12.4), null, { currency: 'EUR', closePrice: 10.0 }).ok).toBe(true)
  })

  it('prefers the cached price over the statement close when both exist', () => {
    const prev = quote(1000, 'EUR', '2026-08-19T16:00:00')
    // 10x off the statement close but flat against the cache: accepted.
    expect(checkQuote(quote(1005), prev, { currency: 'EUR', closePrice: 100 }).ok).toBe(true)
  })
})
