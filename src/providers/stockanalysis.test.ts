import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Instrument } from '../domain/types'
import {
  createStockanalysisDividendProvider,
  createStockanalysisPriceProvider,
  dividendUrl,
  parseDividendBody,
  parseQuoteBody,
  quoteUrl,
} from './stockanalysis'
import { providerHealthSnapshot, resetProviderHealth } from './types'

function inst(patch: Partial<Instrument> = {}): Instrument {
  return {
    key: 'conid:234004667',
    identitySource: 'conid',
    conid: '234004667',
    isin: 'NL0011683594',
    symbol: 'VDIVd',
    aliases: ['VDIVd', 'TDIV'],
    name: 'VANECK DEV MKT DVD LEADERS',
    assetCategory: 'Stocks',
    type: 'ETF',
    listingExchange: 'AEB',
    multiplier: 1,
    tradeCurrency: 'EUR',
    divCurrency: null,
    firstSeen: '2025-01-01',
    lastSeen: '2025-12-31',
    ...patch,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const calls: { url: string; init: RequestInit }[] = []

function mockRoutes(routes: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    if (!(url in routes)) throw new Error(`unmocked ${url}`)
    return jsonResponse(routes[url])
  }) as unknown as typeof fetch
}

const realFetch = globalThis.fetch

beforeEach(() => {
  calls.length = 0
  resetProviderHealth()
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('parseQuoteBody', () => {
  const now = new Date('2026-08-21T12:00:00Z')

  it('reads price and previous close', () => {
    const r = parseQuoteBody({ status: 200, data: { p: 55.38, cl: 55.02, ex: 'AMS' } }, 'AMS-TDIV', now)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.price).toBe(55.38)
      expect(r.value.previousClose).toBe(55.02)
      expect(r.value.exchange).toBe('AMS')
      expect(r.value.currency).toBeNull()
    }
  })

  it('treats an in-band 404 as a miss, not as data', () => {
    // The HTTP status was 200. Trusting it is how this API corrupts a portfolio.
    const r = parseQuoteBody({ status: 404 }, 'AMS-VDIVD', now)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/provider status 404/)
  })

  it('rejects an empty body, a missing status and a missing price', () => {
    expect(parseQuoteBody({}, 'X', now).ok).toBe(false)
    expect(parseQuoteBody({ data: { p: 1 } }, 'X', now).ok).toBe(false)
    expect(parseQuoteBody({ status: 200, data: {} }, 'X', now).ok).toBe(false)
    expect(parseQuoteBody({ status: 200 }, 'X', now).ok).toBe(false)
    expect(parseQuoteBody({ status: 200, data: { p: 0 } }, 'X', now).ok).toBe(false)
    expect(parseQuoteBody(null, 'X', now).ok).toBe(false)
    expect(parseQuoteBody('{"status":200}', 'X', now).ok).toBe(false)
  })

  it('falls back to the wall clock when the human timestamp is unusable', () => {
    const r = parseQuoteBody({ status: 200, data: { p: 10, u: 'Market Closed' } }, 'X', now)
    expect(r.ok && r.value.asOf).toBe('2026-08-21T12:00:00')
  })

  it('refuses a timestamp from the future — that is a parse error, not news', () => {
    const r = parseQuoteBody({ status: 200, data: { p: 10, u: '2099-01-01T00:00:00Z' } }, 'X', now)
    expect(r.ok && r.value.asOf).toBe('2026-08-21T12:00:00')
  })
})

describe('stockanalysis price provider', () => {
  it('falls through a 404 alias to the one that resolves (VDIVd → TDIV)', async () => {
    mockRoutes({
      [quoteUrl('AMS-VDIVD')]: { status: 404 },
      [quoteUrl('AMS-TDIV')]: { status: 200, data: { p: 55.38, cl: 55.02 } },
    })
    const r = await createStockanalysisPriceProvider().quote(inst())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.price).toBe(55.38)
      expect(r.value.currency).toBe('EUR')
      expect(r.value.provenance.source).toBe('stockanalysis')
    }
    expect(calls.map((c) => c.url)).toEqual([quoteUrl('AMS-VDIVD'), quoteUrl('AMS-TDIV')])
  })

  it('never sends credentials — these hosts pair ACAO:* with allow-credentials:true', async () => {
    mockRoutes({ [quoteUrl('AMS-VDIVD')]: { status: 200, data: { p: 55.38 } } })
    await createStockanalysisPriceProvider().quote(inst())
    expect(calls[0]!.init.credentials).toBe('omit')
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
    // No custom headers: a non-safelisted one would force a preflight.
    expect(calls[0]!.init.headers).toBeUndefined()
  })

  it('divides by 100 when the statement close says the provider is quoting pence', async () => {
    mockRoutes({ [quoteUrl('LON-IUKD')]: { status: 200, data: { p: 1032.4, cl: 1028.4 } } })
    const iukd = inst({
      symbol: 'IUKD',
      aliases: ['IUKD'],
      listingExchange: 'LSEETF',
      tradeCurrency: 'GBP',
    })
    const r = await createStockanalysisPriceProvider().quote(iukd, { statementClose: 10.324 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.price).toBeCloseTo(10.324, 6)
      expect(r.value.previousClose).toBeCloseTo(10.284, 6)
    }
  })

  it('lets an explicit priceUnit override beat the calibration', async () => {
    mockRoutes({ [quoteUrl('LON-IUKD')]: { status: 200, data: { p: 1032.4 } } })
    const iukd = inst({ symbol: 'IUKD', aliases: ['IUKD'], listingExchange: 'LSEETF', tradeCurrency: 'GBP' })
    const r = await createStockanalysisPriceProvider().quote(iukd, {
      priceUnit: 'minor',
      statementClose: null,
    })
    expect(r.ok && r.value.price).toBeCloseTo(10.324, 6)
  })

  it('fails rather than guess a currency for an LSE line we have never held', async () => {
    mockRoutes({ [quoteUrl('LON-XXXX')]: { status: 200, data: { p: 10 } } })
    const r = await createStockanalysisPriceProvider().quote(
      inst({ symbol: 'XXXX', aliases: ['XXXX'], listingExchange: 'LSEETF', tradeCurrency: null }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown trade currency/)
    expect(calls).toHaveLength(0)
  })

  it('reports every miss when no candidate resolves', async () => {
    mockRoutes({
      [quoteUrl('AMS-VDIVD')]: { status: 404 },
      [quoteUrl('AMS-TDIV')]: { status: 404 },
      [quoteUrl('AMS-VDIV')]: { status: 404 },
    })
    const r = await createStockanalysisPriceProvider().quote(inst())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.split(';')).toHaveLength(3)
  })

  it('returns a typed failure instead of throwing when the network dies', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const r = await createStockanalysisPriceProvider().quote(inst())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/network: Failed to fetch/)
    expect(providerHealthSnapshot().find((h) => h.id === 'stockanalysis')?.status).toBe('down')
  })

  it('counts an in-band 404 as the provider being healthy, not down', async () => {
    mockRoutes({
      [quoteUrl('AMS-VDIVD')]: { status: 404 },
      [quoteUrl('AMS-TDIV')]: { status: 200, data: { p: 55.38 } },
    })
    await createStockanalysisPriceProvider().quote(inst())
    const health = providerHealthSnapshot().find((h) => h.id === 'stockanalysis')
    expect(health?.status).toBe('ok')
    expect(health?.failures).toBe(0)
  })

  it('rejects a non-JSON body', async () => {
    globalThis.fetch = vi.fn(async () =>
      ({ status: 200, ok: true, text: async () => '<!doctype html>' }) as unknown as Response,
    ) as unknown as typeof fetch
    const r = await createStockanalysisPriceProvider().quote(inst())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not JSON/)
  })
})

describe('parseDividendBody', () => {
  it('reads the row array under any of the spellings seen in the wild', () => {
    for (const key of ['list', 'data', 'dividends', 'dividendData']) {
      const r = parseDividendBody(
        { status: 200, data: { [key]: [{ exDate: '2025-06-11', payDate: '2025-06-20', amount: 0.81 }] } },
        'EUR',
      )
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value).toHaveLength(1)
    }
  })

  it('fails on a shape it does not recognise instead of returning "pays nothing"', () => {
    const r = parseDividendBody({ status: 200, data: { somethingNew: [] } }, 'EUR')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no recognisable row array/)
  })

  it('treats an in-band error status as a failure', () => {
    expect(parseDividendBody({ status: 404 }, 'EUR').ok).toBe(false)
    expect(parseDividendBody({ Information: 'rate limited' }, 'EUR').ok).toBe(false)
  })

  it('sorts ascending by ex-date and drops unusable rows', () => {
    const r = parseDividendBody(
      {
        status: 200,
        data: {
          list: [
            { exDate: '2025-09-11', amount: 0.2 },
            { exDate: 'not a date', amount: 0.2 },
            { exDate: '2025-06-11', amount: 0 },
            { exDate: '2025-03-11', amount: 0.4, currency: 'gbp' },
          ],
        },
      },
      'EUR',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.map((d) => d.exDate)).toEqual(['2025-03-11', '2025-09-11'])
      expect(r.value[0]!.currency).toBe('GBP')
      expect(r.value[1]!.currency).toBe('EUR')
    }
  })
})

describe('stockanalysis dividend provider', () => {
  it('builds a profile with a median-gap frequency and a computed TTM', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'))
    mockRoutes({
      [dividendUrl('AAPL', 's')]: {
        status: 200,
        data: {
          list: [
            { exDate: '2025-02-10', amount: 0.25 },
            { exDate: '2025-05-12', amount: 0.25 },
            { exDate: '2025-08-11', amount: 0.26 },
            { exDate: '2025-11-10', amount: 0.26 },
          ],
        },
      },
    })
    const r = await createStockanalysisDividendProvider().profile(
      inst({ symbol: 'AAPL', aliases: ['AAPL'], listingExchange: 'NASDAQ', tradeCurrency: 'USD' }),
    )
    vi.useRealTimers()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.frequency).toBe(4)
      expect(r.value.ttmPerShare).toBeCloseTo(1.02, 9)
      expect(r.value.currency).toBe('USD')
      expect(r.value.isDistributing).toBe(true)
      expect(r.value.provenance.source).toBe('stockanalysis')
    }
  })

  it('reports a fund with no rows as non-distributing rather than failing', async () => {
    mockRoutes({ [dividendUrl('LON-VUAA')]: { status: 200, data: { list: [] } } })
    const r = await createStockanalysisDividendProvider().profile(
      inst({ symbol: 'VUAA', aliases: ['VUAA'], listingExchange: 'LSEETF', tradeCurrency: 'USD' }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.isDistributing).toBe(false)
      expect(r.value.distributions).toEqual([])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('stockanalysis dividend regressions', () => {
  it('keeps the calendar day of a month-name ex-date', () => {
    // `{"dt":"Aug 21, 2025"}` used to land on 2025-08-20 east of UTC, which is
    // enough to push a payment out of the trailing-12-month window.
    const r = parseDividendBody(
      { status: 200, data: { list: [{ dt: 'Aug 21, 2025', pay: 'Sep 1, 2025', amount: 0.5 }] } },
      'USD',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value[0]!.exDate).toBe('2025-08-21')
      expect(r.value[0]!.payDate).toBe('2025-09-01')
    }
  })

  it('does not throw when a row carries an out-of-range numeric date', () => {
    const r = parseDividendBody({ status: 200, data: { list: [{ dt: 1e300, amount: 1 }] } }, 'USD')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual([])
  })

  it('reports the currency the fund pays in now, not the one it paid in a decade ago', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'))
    mockRoutes({
      [dividendUrl('LON-VUKE')]: {
        status: 200,
        data: {
          list: [
            // One legacy row in another currency used to win, because the array is
            // sorted ex-date ASCENDING and the profile took `distributions[0]`.
            { exDate: '2015-03-11', amount: 5.0, currency: 'USD' },
            { exDate: '2025-09-11', amount: 0.2, currency: 'GBP' },
            { exDate: '2025-12-11', amount: 0.21, currency: 'GBP' },
          ],
        },
      },
    })
    const r = await createStockanalysisDividendProvider().profile(
      inst({ symbol: 'VUKE', aliases: ['VUKE'], listingExchange: 'LSE', tradeCurrency: 'GBP' }),
    )
    vi.useRealTimers()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.currency).toBe('GBP')
      expect(r.value.ttmPerShare).toBeCloseTo(0.41, 9)
    }
  })
})
