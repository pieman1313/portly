import { describe, expect, it } from 'vitest'
import { isZero, pct, ratio, round, roundDisplay, sum, sumBy, sumDefined } from './money'

describe('round', () => {
  it('rounds half away from zero, symmetrically', () => {
    expect(round(1.005, 2)).toBe(1.01)
    expect(round(-1.005, 2)).toBe(-1.01)
    expect(round(0.5, 0)).toBe(1)
    expect(round(-0.5, 0)).toBe(-1)
  })

  it('survives the binary-float cases that lose a cent', () => {
    // 2.675 * 100 is 267.49999999999997 — naive rounding gives 2.67.
    expect(round(2.675, 2)).toBe(2.68)
    expect(round(1.00499999999, 2)).toBe(1)
    expect(round(3334.34005, 4)).toBe(3334.3401)
  })

  it('never returns -0, which renders as "-0" in the UI', () => {
    expect(Object.is(round(-0.0001, 2), 0)).toBe(true)
    expect(Object.is(roundDisplay(-0), 0)).toBe(true)
  })

  it('keeps 9dp quantities and passes non-finite through', () => {
    expect(round(144.679712345678, 9)).toBe(144.679712346)
    expect(Number.isNaN(round(NaN, 2))).toBe(true)
  })
})

describe('sum', () => {
  it('adds a decimal series exactly', () => {
    const tenth = Array.from({ length: 10 }, () => 0.1)
    expect(sum(tenth)).toBe(1)
    expect(tenth.reduce((a, b) => a + b, 0)).not.toBe(1)
  })

  it('compensates when the running total dwarfs the addend', () => {
    // Naive left-to-right addition returns 0 here: the 1 vanishes into 1e16.
    expect(sum([1e16, 1, -1e16])).toBe(1)
    expect([1e16, 1, -1e16].reduce((a, b) => a + b, 0)).toBe(0)
  })

  it('propagates NaN rather than hiding a broken price', () => {
    expect(Number.isNaN(sum([1, NaN, 2]))).toBe(true)
  })

  it('sumBy and sumDefined cover the column cases', () => {
    expect(sumBy([{ v: 1.1 }, { v: 2.2 }], (x) => x.v)).toBeCloseTo(3.3, 12)
    expect(sumDefined([1, null, 2, undefined])).toBe(3)
  })
})

describe('ratio and pct', () => {
  it('returns null instead of Infinity or NaN when the base is empty', () => {
    expect(ratio(5, 0)).toBeNull()
    expect(pct(5, 0)).toBeNull()
    expect(pct(0, 0)).toBeNull()
    expect(pct(NaN, 10)).toBeNull()
  })

  it('scales to 0..100', () => {
    expect(pct(25, 200)).toBe(12.5)
    expect(ratio(25, 200)).toBe(0.125)
  })
})

describe('isZero', () => {
  it('treats share dust as a closed position', () => {
    expect(isZero(1e-12)).toBe(true)
    expect(isZero(-1e-12)).toBe(true)
    expect(isZero(0.0001)).toBe(false)
    expect(isZero(0.0001, 0.001)).toBe(true)
  })
})
