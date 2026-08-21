import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DividendProfile, Instrument, Quote } from '../domain/types'
import {
  PROVIDER_IDS,
  providerHealth,
  refreshDividendProfiles,
  refreshQuotes,
  resetProviderHealth,
} from './index'
import type { DividendProvider, PriceProvider, QuoteRequest } from './index'
import { fail, ok, recordFailure, recordSuccess } from './types'

function inst(key: string, patch: Partial<Instrument> = {}): Instrument {
  return {
    key,
    identitySource: 'conid',
    conid: key,
    isin: null,
    symbol: 'ABC',
    aliases: ['ABC'],
    name: 'Test',
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

function quote(key: string, price: number, currency = 'EUR', asOf = '2026-08-20T16:00:00'): Quote {
  return {
    instrumentKey: key,
    price,
    currency,
    previousClose: null,
    provenance: { source: 'stockanalysis', asOf },
  }
}

function pricesFrom(fn: (i: Instrument) => Quote | string | Error): PriceProvider {
  return {
    id: 'stockanalysis',
    async quote(i) {
      const out = fn(i)
      if (out instanceof Error) throw out
      return typeof out === 'string' ? fail(out) : ok(out)
    },
  }
}

const realFetch = globalThis.fetch

beforeEach(() => {
  resetProviderHealth()
  // Any accidental network access in this file is a bug, so make it loud.
  globalThis.fetch = vi.fn(async () => {
    throw new Error('no network in tests')
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('refreshQuotes fallback chain', () => {
  const statement = { closePrice: 40.5, currency: 'EUR', asOf: '2025-12-31' } as const

  it('lets a manual price beat a perfectly good live quote', async () => {
    const provider = pricesFrom(() => quote('a', 42))
    const [r] = await refreshQuotes(
      [{ instrument: inst('a'), override: { manualPrice: 99, manualPriceCurrency: 'EUR' }, statement }],
      { priceProvider: provider },
    )
    expect(r!.source).toBe('manual')
    expect(r!.quote?.price).toBe(99)
  })

  it('uses the live quote when it passes the gate', async () => {
    const [r] = await refreshQuotes([{ instrument: inst('a'), statement }], {
      priceProvider: pricesFrom(() => quote('a', 42.1)),
    })
    expect(r!.source).toBe('stockanalysis')
    expect(r!.quote?.price).toBe(42.1)
    expect(r!.warnings).toEqual([])
  })

  it('keeps the cached value and warns when the gate refuses a 100x jump', async () => {
    const previous = quote('a', 40.5, 'EUR', '2026-08-19T16:00:00')
    const [r] = await refreshQuotes(
      [{ instrument: inst('a'), previous, statement }],
      { priceProvider: pricesFrom(() => quote('a', 4050)) },
    )
    // The statement outranks the stale scrape, but neither is the poisoned value.
    expect(r!.quote?.price).toBe(40.5)
    expect(r!.source).toBe('statement')
    expect(r!.warnings[0]).toMatch(/rejected: quote: .*exceeds 20%/)
  })

  it('refuses a live quote whose currency contradicts the statement', async () => {
    const [r] = await refreshQuotes([{ instrument: inst('a'), statement }], {
      priceProvider: pricesFrom(() => quote('a', 42, 'USD')),
    })
    expect(r!.source).toBe('statement')
    expect(r!.warnings[0]).toMatch(/currency USD but expected EUR/)
  })

  it('falls back to the statement snapshot when the provider misses', async () => {
    const [r] = await refreshQuotes([{ instrument: inst('a'), statement }], {
      priceProvider: pricesFrom(() => 'AMS-ABC: provider status 404'),
    })
    expect(r!.source).toBe('statement')
    expect(r!.quote?.price).toBe(40.5)
    expect(r!.quote?.provenance.asOf).toBe('2025-12-31T00:00:00')
  })

  it('falls back to the last known quote when there is no statement', async () => {
    const previous = quote('a', 38.2)
    const [r] = await refreshQuotes([{ instrument: inst('a'), previous }], {
      priceProvider: pricesFrom(() => 'miss'),
    })
    expect(r!.source).toBe('stockanalysis')
    expect(r!.quote?.price).toBe(38.2)
  })

  it('returns a null quote with a warning rather than nothing at all', async () => {
    const [r] = await refreshQuotes([{ instrument: inst('a') }], {
      priceProvider: pricesFrom(() => 'miss'),
    })
    expect(r!.quote).toBeNull()
    expect(r!.source).toBeNull()
    expect(r!.warnings).toContain('no price available from any source')
  })

  it('survives a provider that throws, on one instrument only', async () => {
    const requests: QuoteRequest[] = [
      { instrument: inst('a'), statement },
      { instrument: inst('b'), statement },
      { instrument: inst('c'), statement },
    ]
    const results = await refreshQuotes(requests, {
      priceProvider: pricesFrom((i) => {
        if (i.key === 'b') throw new Error('boom')
        return quote(i.key, 41)
      }),
    })
    expect(results.map((r) => r.source)).toEqual(['stockanalysis', 'statement', 'stockanalysis'])
    expect(results[1]!.warnings[0]).toMatch(/threw: boom/)
  })

  it('makes no provider call at all when live data is disabled', async () => {
    const provider = pricesFrom(() => quote('a', 42))
    const spy = vi.spyOn(provider, 'quote')
    const [r] = await refreshQuotes([{ instrument: inst('a'), statement }], {
      priceProvider: provider,
      live: false,
    })
    expect(spy).not.toHaveBeenCalled()
    expect(r!.source).toBe('statement')
  })

  it('preserves request order under concurrency', async () => {
    const requests: QuoteRequest[] = Array.from({ length: 9 }, (_, i) => ({
      instrument: inst(`k${i}`),
    }))
    const results = await refreshQuotes(requests, {
      concurrency: 3,
      priceProvider: pricesFrom((i) => quote(i.key, 10)),
    })
    expect(results.map((r) => r.instrumentKey)).toEqual(requests.map((r) => r.instrument.key))
  })

  it('hands the statement close to the provider so it can calibrate pence', async () => {
    let seen: number | null | undefined
    const provider: PriceProvider = {
      id: 'stockanalysis',
      async quote(i, override) {
        seen = override?.statementClose
        return ok(quote(i.key, 42))
      },
    }
    await refreshQuotes([{ instrument: inst('a'), statement }], { priceProvider: provider })
    expect(seen).toBe(40.5)
  })
})

describe('refreshDividendProfiles', () => {
  function profileProvider(
    id: DividendProvider['id'],
    out: (i: Instrument) => DividendProfile | string,
  ): DividendProvider {
    return {
      id,
      async profile(i) {
        const r = out(i)
        return typeof r === 'string' ? fail(r) : ok(r)
      },
    }
  }

  const profile = (key: string): DividendProfile => ({
    instrumentKey: key,
    distributions: [],
    frequency: 4,
    ttmPerShare: 1.2,
    currency: 'GBP',
    isDistributing: true,
    cagr: null,
    provenance: { source: 'extraetf', asOf: '2026-08-21T00:00:00' },
  })

  it('prefers extraETF and never calls the fallback when it answers', async () => {
    const second = profileProvider('stockanalysis', (i) => profile(i.key))
    const spy = vi.spyOn(second, 'profile')
    const [r] = await refreshDividendProfiles([{ instrument: inst('a') }], {
      dividendProviders: [profileProvider('extraetf', (i) => profile(i.key)), second],
    })
    expect(r!.source).toBe('extraetf')
    expect(spy).not.toHaveBeenCalled()
  })

  it('falls through to stockanalysis for an instrument extraETF cannot address', async () => {
    const [r] = await refreshDividendProfiles([{ instrument: inst('a') }], {
      dividendProviders: [
        profileProvider('extraetf', () => 'ABC has no ISIN — extraETF is ISIN-addressed'),
        profileProvider('stockanalysis', (i) => profile(i.key)),
      ],
    })
    expect(r!.source).toBe('stockanalysis')
    expect(r!.warnings[0]).toMatch(/extraetf: ABC has no ISIN/)
  })

  it('reports both failures instead of throwing', async () => {
    const [r] = await refreshDividendProfiles([{ instrument: inst('a') }], {
      dividendProviders: [
        profileProvider('extraetf', () => 'down'),
        profileProvider('stockanalysis', () => 'down too'),
      ],
    })
    expect(r!.profile).toBeNull()
    expect(r!.warnings).toEqual(['extraetf: down', 'stockanalysis: down too'])
  })
})

describe('providerHealth', () => {
  it('lists every provider, unknown until it is called', () => {
    const health = providerHealth()
    expect(health.map((h) => h.id)).toEqual(PROVIDER_IDS)
    expect(health.every((h) => h.status === 'unknown')).toBe(true)
  })

  it('walks ok → degraded → down and back', () => {
    recordSuccess('stockanalysis')
    expect(providerHealth().find((h) => h.id === 'stockanalysis')?.status).toBe('ok')
    recordFailure('stockanalysis', 'http 503')
    expect(providerHealth().find((h) => h.id === 'stockanalysis')?.status).toBe('degraded')
    recordFailure('stockanalysis', 'http 503')
    recordFailure('stockanalysis', 'http 503')
    const down = providerHealth().find((h) => h.id === 'stockanalysis')
    expect(down?.status).toBe('down')
    expect(down?.lastError).toBe('http 503')
    expect(down?.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    recordSuccess('stockanalysis')
    expect(providerHealth().find((h) => h.id === 'stockanalysis')?.status).toBe('ok')
  })

  it('keeps providers independent — one down source is not an outage', () => {
    recordFailure('extraetf', 'cors')
    recordFailure('extraetf', 'cors')
    recordFailure('extraetf', 'cors')
    recordSuccess('frankfurter')
    const byId = new Map(providerHealth().map((h) => [h.id, h.status]))
    expect(byId.get('extraetf')).toBe('down')
    expect(byId.get('frankfurter')).toBe('ok')
    expect(byId.get('stockanalysis')).toBe('unknown')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('refreshQuotes disclosure regressions', () => {
  it('warns when an unknown venue forced a bare ticker, even if the quote passes', async () => {
    // `resolveSymbolCandidates` flags this `low` because a bare ticker is exactly
    // the form that returns the US JEPI for a European listing. The note used to be
    // computed and thrown away whenever a candidate existed.
    const [r] = await refreshQuotes(
      [
        {
          instrument: inst('a', { listingExchange: 'ENEXT.BE', symbol: 'JEPI', aliases: ['JEPI'] }),
          statement: { closePrice: 40.5, currency: 'EUR', asOf: '2025-12-31' },
        },
      ],
      { priceProvider: pricesFrom(() => quote('a', 42.1)) },
    )
    expect(r!.source).toBe('stockanalysis')
    expect(r!.warnings.some((w) => /^symbol: unknown listing exchange "ENEXT.BE"/.test(w))).toBe(true)
  })

  it('stays silent for a venue we can qualify', async () => {
    const [r] = await refreshQuotes(
      [{ instrument: inst('a'), statement: { closePrice: 40.5, currency: 'EUR', asOf: '2025-12-31' } }],
      { priceProvider: pricesFrom(() => quote('a', 42.1)) },
    )
    expect(r!.warnings).toEqual([])
  })
})
