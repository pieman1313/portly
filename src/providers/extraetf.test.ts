import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Instrument } from '../domain/types'
import {
  clearExtraEtfCache,
  createExtraEtfProvider,
  detailUrl,
  germanMonthIndex,
  mapDistributionFrequency,
  mapDistributionPolicy,
  parseDetail,
} from './extraetf'
import { resetProviderHealth } from './types'

const IUKD_ISIN = 'IE00B0M63060'

function inst(patch: Partial<Instrument> = {}): Instrument {
  return {
    key: `isin:${IUKD_ISIN}`,
    identitySource: 'isin',
    conid: '25601352',
    isin: IUKD_ISIN,
    symbol: 'IUKD',
    aliases: ['IUKD'],
    name: 'iShares UK Dividend UCITS ETF',
    assetCategory: 'Stocks',
    type: 'ETF',
    listingExchange: 'BVME.ETF',
    // Trades EUR in Milan. Pays GBP. That gap is why extraETF exists here.
    multiplier: 1,
    tradeCurrency: 'EUR',
    divCurrency: null,
    firstSeen: '2025-01-01',
    lastSeen: '2025-12-31',
    ...patch,
  }
}

/** A payment reported in its trading currency plus three fixed conversions. */
function row(exDate: string, payDate: string, gbp: number, eur: number, usd: number) {
  return {
    ex_date: exDate,
    pay_date: payDate,
    total_in_tc: gbp, // IUKD distributes GBP
    total_in_eur: eur,
    total_in_gbp: gbp,
    total_in_usd: usd,
  }
}

const IUKD_PAYLOAD = {
  isin: IUKD_ISIN,
  is_distributing: true,
  distribution_policy: 'Ausschüttend',
  distribution_frequency: [
    { id: 1, months: ['März', 'Juni', 'September', 'Dezember'], start_date: '2005-11-01', name: 'Vierteljährlich' },
  ],
  distribution_frequency_months: {
    '2025': [
      row('2025-03-20', '2025-04-15', 0.0402, 0.0475, 0.0512),
      row('2025-06-05', '2025-06-30', 0.2114, 0.2497, 0.2691),
      row('2025-09-18', '2025-10-15', 0.0611, 0.0722, 0.0778),
      row('2025-12-11', '2025-12-24', 0.1873, 0.2213, 0.2385),
    ],
    '2024': [row('2024-12-12', '2024-12-27', 0.1795, 0.212, 0.2285)],
  },
  distribution_cagr: { year_1: 4.2, year_3: 3.1, year_10: 1.8, from_creation: 2.4 },
  // Calendar-year, and deliberately wrong for TTM. We must not read it.
  sum_distribution: 99.99,
  yield_distribution: 42,
}

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

beforeEach(() => {
  clearExtraEtfCache()
  resetProviderHealth()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-10T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('German enums', () => {
  it('maps the distribution policy', () => {
    expect(mapDistributionPolicy('Ausschüttend')).toBe('distributing')
    expect(mapDistributionPolicy('Thesaurierend')).toBe('accumulating')
    // Same words with the umlaut transliterated, or shouted.
    expect(mapDistributionPolicy('AUSSCHÜTTEND')).toBe('distributing')
    expect(mapDistributionPolicy('Ausschuettend')).toBe('distributing')
    expect(mapDistributionPolicy('Distributing')).toBeNull()
  })

  it('maps the payment interval to payments per year', () => {
    expect(mapDistributionFrequency('Monatlich')).toBe(12)
    expect(mapDistributionFrequency('Vierteljährlich')).toBe(4)
    expect(mapDistributionFrequency('Vierteljaehrlich')).toBe(4)
    expect(mapDistributionFrequency('Quartalsweise')).toBe(4)
    expect(mapDistributionFrequency('Halbjährlich')).toBe(2)
    expect(mapDistributionFrequency('Jährlich')).toBe(1)
    expect(mapDistributionFrequency('Keine Ausschüttung')).toBe(0)
    // An unmapped label yields null so the caller infers from ex-dates instead.
    expect(mapDistributionFrequency('Unregelmäßig')).toBeNull()
  })

  it('maps German month names', () => {
    expect(germanMonthIndex('Januar')).toBe(1)
    expect(germanMonthIndex('März')).toBe(3)
    expect(germanMonthIndex('Maerz')).toBe(3)
    expect(germanMonthIndex('Dezember')).toBe(12)
    expect(germanMonthIndex('Smarch')).toBeNull()
  })
})

describe('parseDetail', () => {
  it('identifies the distribution currency from the column that matches total_in_tc', () => {
    const r = parseDetail(IUKD_PAYLOAD, IUKD_ISIN, '2026-01-10')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.currency).toBe('GBP')
      expect(r.value.distributions.every((d) => d.currency === 'GBP')).toBe(true)
      expect(r.value.distributions[0]!.amount).toBe(0.1795)
    }
  })

  it('sorts distributions ascending and keeps both ex and pay dates', () => {
    const r = parseDetail(IUKD_PAYLOAD, IUKD_ISIN, '2026-01-10')
    expect(r.ok && r.value.distributions.map((d) => d.exDate)).toEqual([
      '2024-12-12',
      '2025-03-20',
      '2025-06-05',
      '2025-09-18',
      '2025-12-11',
    ])
    expect(r.ok && r.value.distributions[4]!.payDate).toBe('2025-12-24')
  })

  it('drops the phantom rows an accumulating fund still returns', () => {
    const vuaa = {
      is_distributing: false,
      distribution_policy: 'Thesaurierend',
      distribution_frequency_months: {
        '2025': [row('2025-06-01', '2025-06-15', 0.5, 0.6, 0.65)],
        '2024': [row('2024-06-01', '2024-06-15', 0.4, 0.5, 0.55)],
      },
    }
    const r = parseDetail(vuaa, 'IE00BFMXXD54', '2026-01-10')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.isDistributing).toBe(false)
      expect(r.value.distributions).toEqual([])
    }
  })

  it('falls back to the German policy string when is_distributing is absent', () => {
    const { is_distributing: _drop, ...rest } = IUKD_PAYLOAD
    const r = parseDetail(rest, IUKD_ISIN, '2026-01-10')
    expect(r.ok && r.value.isDistributing).toBe(true)
  })

  it('refuses a payload with no gate at all rather than trust the rows', () => {
    const r = parseDetail({ distribution_frequency_months: { '2025': [] } }, IUKD_ISIN, '2026-01-10')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no is_distributing/)
  })

  it('rejects the empty-object HTTP 200 body', () => {
    expect(parseDetail({}, IUKD_ISIN, '2026-01-10').ok).toBe(false)
    expect(parseDetail(null, IUKD_ISIN, '2026-01-10').ok).toBe(false)
    expect(parseDetail([], IUKD_ISIN, '2026-01-10').ok).toBe(false)
  })

  it('takes the schedule in force today, not the first one ever recorded', () => {
    const changed = {
      ...IUKD_PAYLOAD,
      distribution_frequency: [
        { id: 1, months: ['März', 'Juni', 'September', 'Dezember'], start_date: '2005-11-01', name: 'Vierteljährlich' },
        { id: 2, months: [], start_date: '2024-01-01', name: 'Monatlich' },
        { id: 3, months: ['Januar', 'Februar'], start_date: '2030-01-01', name: 'Halbjährlich' },
      ],
    }
    // The 2030 entry has not started yet; the 2024 one is the live schedule.
    const r = parseDetail(changed, IUKD_ISIN, '2026-01-10')
    expect(r.ok && r.value.declaredFrequency).toBe(12)
  })

  it('counts the month list when the interval label is one we do not know', () => {
    const renamed = {
      ...IUKD_PAYLOAD,
      distribution_frequency: [
        { id: 1, months: ['März', 'Juni', 'September', 'Dezember'], start_date: '2005-11-01', name: 'Unregelmäßig' },
      ],
    }
    const r = parseDetail(renamed, IUKD_ISIN, '2026-01-10')
    expect(r.ok && r.value.declaredFrequency).toBe(4)
  })

  it('rekeys the CAGR block by horizon', () => {
    const r = parseDetail(IUKD_PAYLOAD, IUKD_ISIN, '2026-01-10')
    expect(r.ok && r.value.cagr).toEqual({ '1': 4.2, '3': 3.1, '10': 1.8, from_creation: 2.4 })
  })

  it('accepts the DRF-style results wrapper as well as the bare object', () => {
    const r = parseDetail({ count: 1, results: [IUKD_PAYLOAD] }, IUKD_ISIN, '2026-01-10')
    expect(r.ok && r.value.currency).toBe('GBP')
  })
})

describe('extraETF dividend provider', () => {
  it('computes TTM itself and ignores the calendar-year sum_distribution', async () => {
    mockBody(IUKD_PAYLOAD)
    const r = await createExtraEtfProvider().profile(inst())
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 2025's four payments only; the 2024-12-12 row is outside the window.
      expect(r.value.ttmPerShare).toBeCloseTo(0.5, 9)
      expect(r.value.ttmPerShare).not.toBe(99.99)
      expect(r.value.currency).toBe('GBP')
      expect(r.value.frequency).toBe(4)
      expect(r.value.cagr).toEqual({ '1': 4.2, '3': 3.1, '10': 1.8, from_creation: 2.4 })
      expect(r.value.provenance.source).toBe('extraetf')
    }
  })

  it('reports an accumulating fund as zero income, not as an error', async () => {
    mockBody({ is_distributing: false, distribution_frequency_months: {} })
    const r = await createExtraEtfProvider().profile(inst({ isin: 'IE00BFMXXD54' }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.isDistributing).toBe(false)
      expect(r.value.ttmPerShare).toBe(0)
    }
  })

  it('caches per ISIN — the payload is a fixed 173 KB with no field trimming', async () => {
    mockBody(IUKD_PAYLOAD)
    const provider = createExtraEtfProvider()
    const [a, b] = await Promise.all([
      provider.profile(inst()),
      provider.profile(inst({ key: 'other', symbol: 'IUKD.MI' })),
    ])
    expect(a.ok && b.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await provider.profile(inst())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failure, so a transient outage is retried', async () => {
    mockBody({}, 503)
    const provider = createExtraEtfProvider()
    expect((await provider.profile(inst())).ok).toBe(false)
    expect((await provider.profile(inst())).ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never puts an unvalidated ISIN into a URL', async () => {
    mockBody(IUKD_PAYLOAD)
    const r = await createExtraEtfProvider().profile(inst({ isin: '../../admin' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not a valid ISIN/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('declines instruments with no ISIN so the stock fallback can take them', async () => {
    mockBody(IUKD_PAYLOAD)
    const r = await createExtraEtfProvider().profile(inst({ isin: null }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no ISIN/)
  })

  it('sends no credentials and hits the www edge', async () => {
    mockBody(IUKD_PAYLOAD)
    await createExtraEtfProvider().profile(inst())
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(detailUrl(IUKD_ISIN))
    expect(init.credentials).toBe('omit')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('extraETF currency regressions', () => {
  /** IUKD's real 2025 schedule, but the December row is missing `total_in_tc`. */
  const PARTIAL_PAYLOAD = {
    isin: IUKD_ISIN,
    is_distributing: true,
    distribution_policy: 'Ausschüttend',
    distribution_frequency_months: {
      '2025': [
        row('2025-03-20', '2025-04-15', 0.0402, 0.0475, 0.0512),
        row('2025-06-05', '2025-06-30', 0.2114, 0.2497, 0.2691),
        row('2025-09-18', '2025-10-15', 0.0611, 0.0722, 0.0778),
        {
          ex_date: '2025-12-11',
          pay_date: '2025-12-24',
          // no total_in_tc — the currency of this row cannot be named on its own
          total_in_eur: 0.2213,
          total_in_gbp: 0.1873,
          total_in_usd: 0.2385,
        },
      ],
    },
  }

  it('does not let one unnameable row redenominate the whole history', () => {
    const r = parseDetail(PARTIAL_PAYLOAD, IUKD_ISIN, '2026-01-10')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Was EUR — the profile currency used to be the LAST row's.
    expect(r.value.currency).toBe('GBP')
    expect(r.value.distributions.map((d) => d.currency)).toEqual(['GBP', 'GBP', 'GBP', 'GBP'])
    // The row is re-expressed from its own `total_in_gbp`, not dropped or
    // mis-tagged with the EUR figure.
    expect(r.value.distributions[3]!.amount).toBeCloseTo(0.1873, 9)
  })

  it('keeps the full TTM instead of filtering the odd row out of it', async () => {
    mockBody(PARTIAL_PAYLOAD)
    const r = await createExtraEtfProvider().profile(inst())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.currency).toBe('GBP')
    // 0.0402 + 0.2114 + 0.0611 + 0.1873. Previously 0.2213 (the one EUR row).
    expect(r.value.ttmPerShare).toBeCloseTo(0.5, 9)
    expect(r.value.distributions).toHaveLength(4)
  })
})
