import { describe, expect, it } from 'vitest'
import { OTHER_COLOR, OTHER_KEY, SERIES, foldStack, seriesColor } from './charts'

/**
 * The fold is where the palette's rules are actually enforced, so it is tested
 * on its own rather than through a chart nobody can measure in jsdom.
 */

const label = (key: string) => key.toUpperCase()

describe('foldStack', () => {
  it('gives each entity a hue in contribution order', () => {
    const { series, rows } = foldStack(
      [{ a: 1, b: 10 }, { b: 5 }],
      label,
    )
    expect(series.map((s) => s.name)).toEqual(['B', 'A'])
    expect(series.map((s) => s.color)).toEqual([SERIES[0], SERIES[1]])
    // Positional data keys, because recharts reads a string dataKey as a
    // property PATH and an instrument keyed 'BRK.B|NYSE' would plot nothing.
    expect(series.map((s) => s.key)).toEqual(['s0', 's1'])
    expect(rows).toEqual([{ s0: 10, s1: 1 }, { s0: 5, s1: 0 }])
  })

  it('resolves a dotted entity key that recharts could not', () => {
    const { series, rows } = foldStack([{ 'BRK.B|NYSE': 42 }], label)
    expect(series[0]?.key).toBe('s0')
    expect(rows[0]).toEqual({ s0: 42 })
  })

  it('keeps a hue with the entity when a neighbour drops out', () => {
    const all = foldStack([{ a: 1, b: 10, c: 5 }], label)
    const filtered = foldStack([{ b: 10, c: 5 }], label)
    const hueOf = (s: { series: { name: string; color: string }[] }, name: string) =>
      s.series.find((x) => x.name === name)?.color
    expect(hueOf(filtered, 'B')).toBe(hueOf(all, 'B'))
    expect(hueOf(filtered, 'C')).toBe(hueOf(all, 'C'))
  })

  it('folds the ninth entity and everything after it into one grey Other', () => {
    const breakdown: Record<string, number> = {}
    for (let i = 0; i < 11; i++) breakdown[`k${String(i).padStart(2, '0')}`] = 100 - i
    const { series, rows, shown, folded } = foldStack([breakdown], label)

    expect(shown).toHaveLength(8)
    expect(folded).toEqual(['k08', 'k09', 'k10'])
    // Eight hues plus the neutral. No ninth hue is invented.
    expect(series).toHaveLength(9)
    expect(new Set(series.slice(0, 8).map((s) => s.color)).size).toBe(8)
    expect(series[8]).toEqual({ key: OTHER_KEY, name: 'Other (3)', color: OTHER_COLOR })
    expect(rows[0]?.[OTHER_KEY]).toBe(92 + 91 + 90)
  })

  it('honours a caller-supplied order and still draws what it omits', () => {
    const { series, shown } = foldStack([{ a: 1, b: 10, z: 3 }], label, {
      order: ['a', 'b'],
    })
    // Ranked as the view model ranked it, not by this window's totals...
    expect(shown).toEqual(['a', 'b', 'z'])
    expect(series[0]?.color).toBe(seriesColor('a', shown))
    // ...but a key the order never heard of is appended, never dropped.
    expect(series.map((s) => s.name)).toEqual(['A', 'B', 'Z'])
  })

  it('drops an ordered key that contributed nothing in this window', () => {
    // What lets the Overview card colour from the whole-history order without
    // handing a hue and a legend row to a holding that has not paid in years.
    const { series, shown, rows } = foldStack([{ b: 10, c: 5 }], label, {
      order: ['a', 'b', 'c'],
    })
    expect(shown).toEqual(['b', 'c'])
    expect(series.map((s) => s.name)).toEqual(['B', 'C'])
    expect(rows[0]).toEqual({ s0: 10, s1: 5 })
  })

  it('never cycles the palette, however many slots the caller asks for', () => {
    const breakdown: Record<string, number> = {}
    for (let i = 0; i < 12; i++) breakdown[`k${String(i).padStart(2, '0')}`] = 100 - i
    const { series, shown } = foldStack([breakdown], label, { max: 12 })
    expect(shown).toHaveLength(SERIES.length)
    expect(new Set(series.slice(0, SERIES.length).map((s) => s.color)).size).toBe(SERIES.length)
    expect(series[SERIES.length]).toEqual({
      key: OTHER_KEY,
      name: 'Other (4)',
      color: OTHER_COLOR,
    })
  })

  it('keeps every row summing to the bucket it came from', () => {
    // The stacked bar must equal the ungrouped total, folded remainder and all.
    const breakdowns: Record<string, number>[] = [
      { a: 4, b: 3, c: 2, d: 1, e: 0.5 },
      { c: 7 },
      {},
    ]
    const { rows } = foldStack(breakdowns, label, { max: 2 })
    breakdowns.forEach((b, i) => {
      const bar = Object.values(rows[i] ?? {}).reduce((t, v) => t + v, 0)
      expect(bar).toBeCloseTo(
        Object.values(b).reduce((t, v) => t + v, 0),
        9,
      )
    })
  })

  it('respects a lower cap for a small card', () => {
    const { shown, folded } = foldStack([{ a: 4, b: 3, c: 2, d: 1 }], label, { max: 2 })
    expect(shown).toEqual(['a', 'b'])
    expect(folded).toEqual(['c', 'd'])
  })

  it('emits one empty row per bucket when nothing was attributable', () => {
    const { series, rows } = foldStack([{}, {}], label)
    expect(series).toEqual([])
    expect(rows).toEqual([{}, {}])
  })
})
