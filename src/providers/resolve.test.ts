import { describe, expect, it } from 'vitest'
import type { Instrument } from '../domain/types'
import {
  expectedQuoteCurrency,
  mapListingExchange,
  resolveProviderSymbol,
  resolveSymbolCandidates,
  stripDisambiguator,
  venueCurrency,
} from './resolve'

function inst(patch: Partial<Instrument> = {}): Instrument {
  return {
    key: 'conid:1',
    identitySource: 'conid',
    conid: '1',
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

describe('mapListingExchange', () => {
  it('maps every IBKR venue the statements actually use', () => {
    expect(mapListingExchange('LSEETF')).toEqual({ kind: 'prefixed', prefix: 'LON' })
    expect(mapListingExchange('LSE')).toEqual({ kind: 'prefixed', prefix: 'LON' })
    expect(mapListingExchange('AEB')).toEqual({ kind: 'prefixed', prefix: 'AMS' })
    expect(mapListingExchange('BVME.ETF')).toEqual({ kind: 'prefixed', prefix: 'MIL' })
    expect(mapListingExchange('BVME')).toEqual({ kind: 'prefixed', prefix: 'MIL' })
    expect(mapListingExchange('IBIS')).toEqual({ kind: 'prefixed', prefix: 'ETR' })
    expect(mapListingExchange('IBIS2')).toEqual({ kind: 'prefixed', prefix: 'ETR' })
    expect(mapListingExchange('XETRA')).toEqual({ kind: 'prefixed', prefix: 'ETR' })
    expect(mapListingExchange('SBF')).toEqual({ kind: 'prefixed', prefix: 'PAR' })
    expect(mapListingExchange('SEHK')).toEqual({ kind: 'prefixed', prefix: 'HKG' })
    expect(mapListingExchange('TSE')).toEqual({ kind: 'prefixed', prefix: 'TSX' })
  })

  it('treats US venues as bare-ticker venues, not as unknown', () => {
    for (const v of ['NASDAQ', 'NYSE', 'ARCA', 'BATS']) {
      expect(mapListingExchange(v)).toEqual({ kind: 'us' })
    }
  })

  it('is case- and whitespace-insensitive and never reads the prototype chain', () => {
    expect(mapListingExchange(' aeb ')).toEqual({ kind: 'prefixed', prefix: 'AMS' })
    expect(mapListingExchange('__proto__')).toEqual({ kind: 'unknown' })
    expect(mapListingExchange('constructor')).toEqual({ kind: 'unknown' })
    expect(mapListingExchange(null)).toEqual({ kind: 'unknown' })
  })
})

describe('venueCurrency', () => {
  it('refuses to guess on LSE, which lists GBP, GBX, USD and EUR side by side', () => {
    expect(venueCurrency({ kind: 'prefixed', prefix: 'LON' })).toBeNull()
    expect(venueCurrency({ kind: 'prefixed', prefix: 'AMS' })).toBe('EUR')
    expect(venueCurrency({ kind: 'us' })).toBe('USD')
    expect(venueCurrency({ kind: 'unknown' })).toBeNull()
  })
})

describe('stripDisambiguator', () => {
  it('drops a single trailing lowercase reissue letter', () => {
    expect(stripDisambiguator('VDIVd')).toBe('VDIV')
    expect(stripDisambiguator('TDIV')).toBeNull()
    expect(stripDisambiguator('A')).toBeNull()
    expect(stripDisambiguator('VDIVdd')).toBeNull()
  })
})

describe('resolveProviderSymbol', () => {
  it('tries every alias, so the renamed VDIVd falls back to TDIV', () => {
    // conid 234004667: `AMS-VDIVD` 404s, `AMS-TDIV` 200s. The alias list is the
    // only thing that bridges them.
    const vaneck = inst({
      symbol: 'VDIVd',
      aliases: ['VDIVd', 'TDIV'],
      listingExchange: 'AEB',
      isin: 'NL0011683594',
      conid: '234004667',
    })
    expect(resolveProviderSymbol(vaneck)).toEqual(['AMS-VDIVD', 'AMS-TDIV', 'AMS-VDIV'])
  })

  it('puts broker-reported tickers before the stripped guess', () => {
    const candidates = resolveProviderSymbol(
      inst({ symbol: 'VDIVd', aliases: ['VDIVd', 'TDIV'] }),
    )
    expect(candidates.indexOf('AMS-TDIV')).toBeLessThan(candidates.indexOf('AMS-VDIV'))
  })

  it('never emits a bare ticker for a non-US listing (the JEPI/JEPI.L trap)', () => {
    // Both listings are USD, so only the venue qualifier separates the $57.72 US
    // fund from the $24.95 Irish UCITS.
    const jepi = inst({
      symbol: 'JEPI',
      aliases: ['JEPI'],
      listingExchange: 'LSEETF',
      tradeCurrency: 'USD',
    })
    const candidates = resolveProviderSymbol(jepi)
    expect(candidates).toEqual(['LON-JEPI'])
    expect(candidates).not.toContain('JEPI')
  })

  it('emits the bare ticker for a genuine US listing', () => {
    expect(
      resolveProviderSymbol(
        inst({ symbol: 'AAPL', aliases: ['AAPL'], listingExchange: 'NASDAQ', tradeCurrency: 'USD' }),
      ),
    ).toEqual(['AAPL'])
  })

  it('flags low confidence and offers only the bare ticker on an unknown venue', () => {
    const r = resolveSymbolCandidates(
      inst({ symbol: 'WEIRD', aliases: ['WEIRD'], listingExchange: 'MOEX' }),
    )
    expect(r.candidates).toEqual(['WEIRD'])
    expect(r.confidence).toBe('low')
    expect(r.note).toMatch(/unknown listing exchange/)
  })

  it('lets an explicit override short-circuit everything', () => {
    const r = resolveSymbolCandidates(inst({ symbol: 'VDIVd', aliases: ['VDIVd', 'TDIV'] }), {
      providerSymbol: 'lon-jepi',
    })
    expect(r.candidates).toEqual(['LON-JEPI'])
    expect(r.confidence).toBe('high')
  })

  it('reports a malformed override instead of silently auto-resolving past it', () => {
    const r = resolveSymbolCandidates(inst(), { providerSymbol: '../../etc/passwd' })
    expect(r.candidates).toEqual([])
    expect(r.note).toMatch(/not a valid symbol/)
  })

  it('rejects tickers that cannot safely reach a URL path', () => {
    expect(resolveProviderSymbol(inst({ symbol: 'A/B', aliases: ['A/B'] }))).toEqual([])
    expect(resolveProviderSymbol(inst({ symbol: 'AB?x=1', aliases: ['AB?x=1'] }))).toEqual([])
  })

  it('normalises IBKR space-separated share classes to the provider dot form', () => {
    expect(
      resolveProviderSymbol(
        inst({ symbol: 'BRK B', aliases: ['BRK B'], listingExchange: 'NYSE' }),
      ),
    ).toEqual(['BRK.B'])
  })

  it('returns nothing for forex and for excluded instruments', () => {
    expect(
      resolveProviderSymbol(inst({ symbol: 'EUR.USD', assetCategory: 'Forex' })),
    ).toEqual([])
    expect(resolveProviderSymbol(inst(), { excluded: true })).toEqual([])
  })

  it('deduplicates repeated aliases, case-insensitively', () => {
    expect(
      resolveProviderSymbol(inst({ symbol: 'TDIV', aliases: ['tdiv', 'TDIV', 'TDIV'] })),
    ).toEqual(['AMS-TDIV'])
  })
})

describe('expectedQuoteCurrency', () => {
  it('prefers the statement over any venue default', () => {
    expect(expectedQuoteCurrency(inst({ tradeCurrency: 'USD', listingExchange: 'AEB' }))).toBe('USD')
  })

  it('falls back to the venue only when the statement never said', () => {
    expect(expectedQuoteCurrency(inst({ tradeCurrency: null, listingExchange: 'AEB' }))).toBe('EUR')
    expect(expectedQuoteCurrency(inst({ tradeCurrency: null, listingExchange: 'LSEETF' }))).toBeNull()
  })
})
