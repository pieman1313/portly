import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderDistribution } from '../domain/types'
import {
  asIsoDate,
  asNumber,
  dominantCurrency,
  fetchJson,
  frequencyFromExDates,
  isSafeKey,
  medianGapDays,
  toIsoDateTime,
  ttmPerShare,
} from './types'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('asNumber', () => {
  it('accepts the thousands separators these payloads and the CSV both carry', () => {
    expect(asNumber('3,334.3400')).toBe(3334.34)
    expect(asNumber(144.6797)).toBe(144.6797)
    expect(asNumber('-1,000')).toBe(-1000)
  })

  it('maps the empty-ish tokens to null instead of zero', () => {
    for (const v of ['', ' ', '-', '--', null, undefined, {}, Number.NaN, 'abc']) {
      expect(asNumber(v)).toBeNull()
    }
  })
})

describe('asIsoDate', () => {
  it('accepts every date shape these APIs have been seen to emit', () => {
    expect(asIsoDate('2025-12-24')).toBe('2025-12-24')
    expect(asIsoDate('2025-12-24T16:00:00Z')).toBe('2025-12-24')
    expect(asIsoDate('6/5/2025')).toBe('2025-06-05')
    expect(asIsoDate(1766534400)).toBe('2025-12-24')
    expect(asIsoDate(1766534400000)).toBe('2025-12-24')
    expect(asIsoDate('never')).toBeNull()
    expect(asIsoDate('')).toBeNull()
  })
})

describe('isSafeKey', () => {
  it('blocks the keys that would rewrite a prototype', () => {
    expect(isSafeKey('USD')).toBe(true)
    expect(isSafeKey('__proto__')).toBe(false)
    expect(isSafeKey('constructor')).toBe(false)
    expect(isSafeKey('prototype')).toBe(false)
  })
})

describe('frequency detection', () => {
  it('takes the median gap, so one shifted payment does not move the answer', () => {
    // Gaps of 90, 91, 92 days → 91, and an outlier fourth gap would not shift it.
    expect(medianGapDays(['2025-01-01', '2025-04-01', '2025-07-01', '2025-10-01'])).toBe(91)
    expect(
      medianGapDays(['2025-01-01', '2025-04-01', '2025-07-01', '2025-10-01', '2027-10-01']),
    ).toBe(91.5)
    expect(medianGapDays(['2025-01-01'])).toBeNull()
  })

  it('snaps to a schedule a fund could actually run', () => {
    // 28-day gaps are 13.04/yr arithmetically. Nobody pays 13 times a year.
    expect(frequencyFromExDates(['2025-01-05', '2025-02-02', '2025-03-02', '2025-03-30'])).toBe(12)
    expect(frequencyFromExDates(['2025-01-01', '2025-04-01', '2025-07-01', '2025-10-01'])).toBe(4)
    expect(frequencyFromExDates(['2024-06-01', '2025-06-01'])).toBe(1)
    expect(frequencyFromExDates(['2025-06-01'])).toBeNull()
  })
})

describe('ttmPerShare', () => {
  const dists: ProviderDistribution[] = [
    { exDate: '2024-12-12', payDate: null, amount: 0.18, currency: 'GBP', declared: true },
    { exDate: '2025-03-20', payDate: null, amount: 0.04, currency: 'GBP', declared: true },
    { exDate: '2025-06-05', payDate: null, amount: 0.21, currency: 'GBP', declared: true },
    { exDate: '2025-06-05', payDate: null, amount: 0.25, currency: 'EUR', declared: true },
    { exDate: '2026-06-05', payDate: null, amount: 9.99, currency: 'GBP', declared: true },
  ]

  it('buckets on ex-date and never mixes currencies', () => {
    expect(ttmPerShare(dists, '2026-01-10', 'GBP')).toBeCloseTo(0.25, 9)
  })

  it('excludes anything dated after the as-of', () => {
    expect(ttmPerShare(dists, '2025-04-01', 'GBP')).toBeCloseTo(0.22, 9)
  })

  it('returns null, not zero, when the window is empty', () => {
    expect(ttmPerShare(dists, '2020-01-01', 'GBP')).toBeNull()
  })
})

describe('toIsoDateTime', () => {
  it('emits second-precision UTC with no zone suffix', () => {
    expect(toIsoDateTime(new Date('2026-08-21T12:34:56.789Z'))).toBe('2026-08-21T12:34:56')
  })
})

describe('fetchJson', () => {
  it('sends credentials: omit, a timeout signal and no headers', async () => {
    const spy = vi.fn(async () => ({ status: 200, ok: true, text: async () => '{"a":1}' }) as unknown as Response)
    globalThis.fetch = spy as unknown as typeof fetch
    const r = await fetchJson('https://example.test/x')
    expect(r.ok && r.value).toEqual({ a: 1 })
    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.credentials).toBe('omit')
    expect(init.mode).toBe('cors')
    expect(init.headers).toBeUndefined()
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('turns every transport problem into a Result, never a throw', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const r = await fetchJson('https://example.test/x')
    expect(r).toEqual({ ok: false, reason: 'network: Failed to fetch' })
  })

  it('reports a non-2xx status without reading it as data', async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 503, ok: false, text: async () => 'oops' }) as unknown as Response)
    expect(await fetchJson('https://example.test/x')).toEqual({ ok: false, reason: 'http 503' })
  })

  it('reports an HTML error page served as 200', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ status: 200, ok: true, text: async () => '<html>blocked</html>' }) as unknown as Response,
    )
    expect(await fetchJson('https://example.test/x')).toEqual({ ok: false, reason: 'body is not JSON' })
  })

  it('refuses a body far larger than any of these payloads', async () => {
    const huge = `{"pad":"${'x'.repeat(4_000_001)}"}`
    globalThis.fetch = vi.fn(async () => ({ status: 200, ok: true, text: async () => huge }) as unknown as Response)
    const r = await fetchJson('https://example.test/x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/body too large/)
  })

  it('aborts on the caller signal as well as the timeout', async () => {
    const controller = new AbortController()
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }) as unknown as typeof fetch
    const pending = fetchJson('https://example.test/x', { signal: controller.signal })
    controller.abort()
    const r = await pending
    expect(r.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('asIsoDate regressions', () => {
  it('keeps the calendar day of a month-name date in a timezone east of UTC', () => {
    // `Date.parse` reads these in the HOST zone, so formatting the result back
    // through `toISOString()` returned 2025-08-20 for every user in Europe/Asia.
    expect(asIsoDate('Aug 21, 2025')).toBe('2025-08-21')
    expect(asIsoDate('21 Aug 2025')).toBe('2025-08-21')
    expect(asIsoDate('August 21, 2025')).toBe('2025-08-21')
    // New Year's Day is the expensive one: a shift moves it into the prior year.
    expect(asIsoDate('Jan 1, 2026')).toBe('2026-01-01')
    expect(asIsoDate('2026/01/01')).toBe('2026-01-01')
  })

  it('degrades to null instead of throwing on an out-of-range number', () => {
    expect(() => asIsoDate(1e300)).not.toThrow()
    expect(asIsoDate(1e300)).toBeNull()
    expect(asIsoDate(-1e300)).toBeNull()
  })
})

describe('frequency detection regressions', () => {
  it('ignores duplicate ex-dates rather than letting 0-day gaps sink the median', () => {
    // A special dividend posted on the same ex-date as the ordinary one, twice.
    expect(medianGapDays(['2025-03-01', '2025-03-01', '2025-09-01', '2025-09-01'])).toBe(184)
    expect(frequencyFromExDates(['2025-03-01', '2025-03-01', '2025-09-01', '2025-09-01'])).toBe(2)
    expect(
      frequencyFromExDates([
        '2025-01-01', '2025-01-01',
        '2025-04-01', '2025-04-01',
        '2025-07-01', '2025-07-01',
        '2025-10-01', '2025-10-01',
      ]),
    ).toBe(4)
  })
})

describe('dominantCurrency', () => {
  const d = (exDate: string, currency: string): ProviderDistribution => ({
    exDate,
    payDate: null,
    amount: 1,
    currency,
    declared: true,
  })

  it('picks the modal currency, not whichever end of the array you grab', () => {
    const history = [d('2015-03-11', 'USD'), d('2025-09-11', 'GBP'), d('2025-12-11', 'GBP')]
    expect(dominantCurrency(history)).toBe('GBP')
    // ... and is not fooled by a single unidentified trailing row either.
    expect(dominantCurrency([...history, d('2026-01-05', 'EUR')])).toBe('GBP')
  })

  it('breaks a tie on the most recent payment and yields null for nothing usable', () => {
    expect(dominantCurrency([d('2025-01-01', 'USD'), d('2025-07-01', 'GBP')])).toBe('GBP')
    expect(dominantCurrency([])).toBeNull()
  })
})
