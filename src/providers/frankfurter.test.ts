import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchLatestRates,
  fetchRatesOn,
  fetchRatesRange,
  parseRangeBody,
  parseSnapshotBody,
  toFxRates,
} from './frankfurter'
import { providerHealthSnapshot, resetProviderHealth } from './types'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const realFetch = globalThis.fetch
let fetchMock: ReturnType<typeof vi.fn>

function mockBody(body: unknown, status = 200): void {
  fetchMock = vi.fn(async () => jsonResponse(body, status))
  globalThis.fetch = fetchMock as unknown as typeof fetch
}

function lastUrl(): string {
  return String((fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string])[0])
}

beforeEach(() => resetProviderHealth())
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('parseSnapshotBody', () => {
  it('reads the echoed date, which is the business day the ECB actually published', () => {
    const r = parseSnapshotBody({ amount: 1, base: 'EUR', date: '2025-12-24', rates: { USD: 1.1712, GBP: 0.8721 } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.date).toBe('2025-12-24')
      expect(r.value.rates['USD']).toBe(1.1712)
      // The base is implicit upstream and explicit here.
      expect(r.value.rates['EUR']).toBe(1)
    }
  })

  it('rejects the `{}` body served with HTTP 200', () => {
    expect(parseSnapshotBody({}).ok).toBe(false)
    expect(parseSnapshotBody({ base: 'EUR', date: '2025-12-24', rates: {} }).ok).toBe(false)
    expect(parseSnapshotBody({ base: 'EUR', rates: { USD: 1.1 } }).ok).toBe(false)
    expect(parseSnapshotBody({ date: '2025-12-24', rates: { USD: 1.1 } }).ok).toBe(false)
    expect(parseSnapshotBody(null).ok).toBe(false)
  })

  it('drops rates that are not positive finite numbers', () => {
    const r = parseSnapshotBody({
      base: 'EUR',
      date: '2025-12-24',
      rates: { USD: 1.17, GBP: 0, JPY: 'n/a', CHF: -1, XX: 1.2 },
    })
    expect(r.ok && Object.keys(r.value.rates).sort()).toEqual(['EUR', 'USD'])
  })

  it('normalises away an `amount` we never asked for', () => {
    const r = parseSnapshotBody({ amount: 10, base: 'EUR', date: '2025-12-24', rates: { USD: 11.712 } })
    expect(r.ok && r.value.rates['USD']).toBeCloseTo(1.1712, 9)
  })

  it('leaves the base self-rate at exactly 1 when an `amount` is scaled out', () => {
    // The self-rate is synthesised by us and was never multiplied by `amount`.
    // Dividing it too shipped EUR|EUR = 0.1 — a silent 10x on every base amount.
    const r = parseSnapshotBody({ amount: 10, base: 'EUR', date: '2025-12-24', rates: { USD: 11.712 } })
    expect(r.ok && r.value.rates['EUR']).toBe(1)
  })

  it('ignores a `__proto__` key in the rates map', () => {
    const body = JSON.parse('{"base":"EUR","date":"2025-12-24","rates":{"USD":1.17,"__proto__":{"polluted":1}}}')
    const r = parseSnapshotBody(body)
    expect(r.ok).toBe(true)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe('parseRangeBody', () => {
  it('keys each day by the date the ECB published it', () => {
    const r = parseRangeBody({
      base: 'EUR',
      start_date: '2025-12-22',
      end_date: '2025-12-27',
      rates: { '2025-12-22': { USD: 1.17 }, '2025-12-23': { USD: 1.171 }, '2025-12-24': { USD: 1.1712 } },
    })
    expect(r.ok && Object.keys(r.value.days)).toEqual(['2025-12-22', '2025-12-23', '2025-12-24'])
  })

  it('rejects an empty range rather than reporting zero rates as success', () => {
    expect(parseRangeBody({ base: 'EUR', rates: {} }).ok).toBe(false)
    expect(parseRangeBody({ base: 'EUR' }).ok).toBe(false)
  })
})

describe('toFxRates', () => {
  it('builds the composite key the store expects', () => {
    expect(toFxRates('EUR', '2025-12-24', { USD: 1.1712 })).toEqual([
      { id: 'EUR|USD|2025-12-24', base: 'EUR', quote: 'USD', date: '2025-12-24', rate: 1.1712 },
    ])
  })
})

describe('requests', () => {
  it('asks for the requested day and returns the day it was snapped to', async () => {
    // Christmas Day is a TARGET holiday; the ECB last published on the 24th.
    mockBody({ amount: 1, base: 'EUR', date: '2025-12-24', rates: { USD: 1.1712 } })
    const r = await fetchRatesOn('2025-12-25', 'EUR', ['USD'])
    expect(lastUrl()).toBe('https://api.frankfurter.dev/v1/2025-12-25?base=EUR&symbols=USD')
    expect(r.ok && r.value.date).toBe('2025-12-24')
  })

  it('fetches a whole period in one request and flattens it', async () => {
    mockBody({
      base: 'EUR',
      rates: { '2025-12-22': { USD: 1.17, GBP: 0.87 }, '2025-12-24': { USD: 1.1712, GBP: 0.8721 } },
    })
    const r = await fetchRatesRange('2025-12-20', '2025-12-27', 'EUR', ['USD', 'GBP'])
    expect(lastUrl()).toBe('https://api.frankfurter.dev/v1/2025-12-20..2025-12-27?base=EUR&symbols=USD%2CGBP')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(true)
    // 2 days x (USD, GBP, EUR self-rate)
    if (r.ok) {
      expect(r.value).toHaveLength(6)
      expect(r.value.find((x) => x.id === 'EUR|USD|2025-12-24')?.rate).toBe(1.1712)
      // The weekend of the 20th/21st simply is not there — no invented rows.
      expect(r.value.some((x) => x.date === '2025-12-20')).toBe(false)
    }
  })

  it('drops the base from `symbols` instead of asking for a self-rate', async () => {
    mockBody({ base: 'USD', date: '2026-08-20', rates: { EUR: 0.854 } })
    await fetchLatestRates('USD', ['USD', 'EUR'])
    expect(lastUrl()).toBe('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR')
  })

  it('validates every input before it reaches the URL', async () => {
    mockBody({ base: 'EUR', date: '2026-08-20', rates: { USD: 1.1 } })
    expect((await fetchLatestRates('EU R', ['USD'])).ok).toBe(false)
    expect((await fetchLatestRates('EUR', ['../../x'])).ok).toBe(false)
    expect((await fetchRatesOn('2025-13-99x', 'EUR', ['USD'])).ok).toBe(false)
    expect((await fetchRatesRange('2025-12-27', '2025-12-20', 'EUR', ['USD'])).ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never sends credentials', async () => {
    mockBody({ base: 'EUR', date: '2026-08-20', rates: { USD: 1.1 } })
    await fetchLatestRates('EUR', ['USD'])
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    expect(init.credentials).toBe('omit')
  })

  it('records a transport failure against the provider, not a parse failure', async () => {
    mockBody({ error: 'not found' }, 404)
    const r = await fetchLatestRates('EUR', ['USD'])
    expect(r.ok).toBe(false)
    expect(providerHealthSnapshot().find((h) => h.id === 'frankfurter')?.failures).toBe(1)
  })

  it('counts a well-formed but useless body as reachable-but-unparseable', async () => {
    mockBody({})
    const r = await fetchLatestRates('EUR', ['USD'])
    expect(r.ok).toBe(false)
    const health = providerHealthSnapshot().find((h) => h.id === 'frankfurter')
    expect(health?.successes).toBe(1)
  })
})
