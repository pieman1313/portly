/**
 * Provider orchestration — the only module the rest of the app imports.
 *
 * Everything here exists to make one guarantee: a dead provider degrades one
 * number, never the render. Requests are settled, never awaited as a group; each
 * instrument walks its own fallback chain; and a value that fails the sanity gate
 * is dropped in favour of the previous one with a warning attached, never written.
 *
 * Fallback chain per instrument: manual → live → statement snapshot → last known.
 * Statement outranks last-known deliberately: the CSV close price is broker truth,
 * a cached scrape is not. Staleness is then a provenance badge, not a silent lie.
 */

import type {
  Currency,
  DividendProfile,
  ISODate,
  Instrument,
  ProviderId,
  Quote,
} from '../domain/types'
import { createExtraEtfProvider } from './extraetf'
import { resolveSymbolCandidates } from './resolve'
import { checkQuote } from './sanity'
import {
  createStockanalysisDividendProvider,
  createStockanalysisPriceProvider,
} from './stockanalysis'
import { isFiniteNumber, providerHealthSnapshot, toIsoDateTime } from './types'
import type {
  DividendProvider,
  FetchOptions,
  PriceProvider,
  ProviderHealthEntry,
  ProviderOverride,
} from './types'

export type { Result, PriceProvider, DividendProvider, ProviderOverride, FetchOptions, ProviderHealthEntry, HealthStatus } from './types'
export type { SymbolResolution, SymbolConfidence, VenueMapping } from './resolve'
export type { PriceUnit, QuoteExpectation } from './sanity'
export type { FxSnapshot } from './frankfurter'

export { resolveProviderSymbol, resolveSymbolCandidates, mapListingExchange } from './resolve'
export {
  checkQuote,
  detectPriceUnit,
  applyPriceUnit,
  MAX_MOVE,
  MAX_DRIFT_FROM_STATEMENT,
  MINOR_UNIT_BAND,
} from './sanity'
export { fetchLatestRates, fetchRatesOn, fetchRatesRange, toFxRates } from './frankfurter'
export { clearExtraEtfCache } from './extraetf'
export { resetProviderHealth } from './types'

/** The whole roster, for the Settings panel. Order is display order. */
export const PROVIDER_IDS: ProviderId[] = [
  'stockanalysis',
  'extraetf',
  'frankfurter',
  'manual',
  'statement',
]

/** Per-provider ok/degraded/down plus last error and last success. */
export function providerHealth(): ProviderHealthEntry[] {
  const seen = new Map(providerHealthSnapshot().map((e) => [e.id, e]))
  return PROVIDER_IDS.map(
    (id) =>
      seen.get(id) ?? {
        id,
        status: 'unknown' as const,
        lastError: null,
        lastErrorAt: null,
        lastSuccessAt: null,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
      },
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTES
// ─────────────────────────────────────────────────────────────────────────────

/** The broker's own last close for this instrument, from Open Positions. */
export interface StatementQuote {
  closePrice: number
  currency: Currency
  asOf: ISODate
}

export interface QuoteRequest {
  instrument: Instrument
  override?: ProviderOverride | null
  /** Last good quote already in IndexedDB. */
  previous?: Quote | null
  statement?: StatementQuote | null
}

export interface QuoteResult {
  instrumentKey: string
  quote: Quote | null
  /** Which link of the chain produced `quote`. Null when nothing did. */
  source: ProviderId | null
  /** Non-fatal, user-visible: the gate refused a value, or every provider missed. */
  warnings: string[]
}

export interface RefreshOptions extends FetchOptions {
  priceProvider?: PriceProvider
  dividendProviders?: DividendProvider[]
  /** Off means CSV-only. The app is fully functional in that mode. */
  live?: boolean
  /** These endpoints have no batch form; keep the fan-out polite. */
  concurrency?: number
  now?: Date
}

async function runPooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out = new Array<PromiseSettledResult<R>>(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length || 1))
  const workers: Promise<void>[] = []
  for (let w = 0; w < width; w += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const i = cursor
          cursor += 1
          if (i >= items.length) return
          try {
            out[i] = { status: 'fulfilled', value: await fn(items[i]!) }
          } catch (e) {
            out[i] = { status: 'rejected', reason: e }
          }
        }
      })(),
    )
  }
  await Promise.allSettled(workers)
  return out
}

function statementQuote(req: QuoteRequest, s: StatementQuote): Quote {
  return {
    instrumentKey: req.instrument.key,
    price: s.closePrice,
    currency: s.currency,
    previousClose: null,
    provenance: { source: 'statement', asOf: `${s.asOf}T00:00:00` },
  }
}

async function quoteOne(
  provider: PriceProvider,
  req: QuoteRequest,
  live: boolean,
  now: Date,
): Promise<QuoteResult> {
  const inst = req.instrument
  const warnings: string[] = []
  const override = req.override ?? null

  // 1. Manual. Always wins, sticky until cleared, no network.
  const manual = override?.manualPrice
  if (isFiniteNumber(manual) && manual > 0) {
    const currency = override?.manualPriceCurrency ?? req.statement?.currency ?? inst.tradeCurrency
    if (currency) {
      return {
        instrumentKey: inst.key,
        quote: {
          instrumentKey: inst.key,
          price: manual,
          currency,
          previousClose: null,
          provenance: { source: 'manual', asOf: toIsoDateTime(now) },
        },
        source: 'manual',
        warnings,
      }
    }
    warnings.push('manual price ignored: no currency set for it')
  }

  // 2. Live.
  if (live && override?.excluded !== true) {
    // `confidence: 'low'` means the venue was unrecognised and we are about to send
    // a BARE ticker — the form that returns the US JEPI for a European listing at a
    // price no currency or drift check can catch. It has to reach the user, so the
    // note is attached whatever the quote turns out to be.
    const resolution = resolveSymbolCandidates(inst, override)
    if (resolution.confidence === 'low' && resolution.note) {
      warnings.push(`symbol: ${resolution.note}`)
    }

    // A low-confidence resolution is a bare ticker on the US path, which is
    // exactly the form that returns a different company at a plausible price.
    // The currency check cannot catch it when both are USD, so the only real
    // defence is the drift check against the broker's own close — and without a
    // close price there is nothing to check against. Refuse rather than guess:
    // the statement price is a known-good fallback, a wrong security is not.
    const verifiable =
      isFiniteNumber(req.statement?.closePrice) && (req.statement?.closePrice ?? 0) > 0
    if (resolution.confidence === 'low' && !verifiable) {
      warnings.push(
        'skipped the live lookup: an unrecognised exchange leaves only a bare ticker, ' +
          'and with no statement close price there is no way to tell a correct match from ' +
          'a different company. Set a symbol override in Settings to fetch it.',
      )
    } else {
    try {
      const res = await provider.quote(inst, {
        ...(override ?? {}),
        statementClose: override?.statementClose ?? req.statement?.closePrice ?? null,
      })
      if (res.ok) {
        const gate = checkQuote(res.value, req.previous ?? null, {
          currency: req.statement?.currency ?? inst.tradeCurrency ?? null,
          closePrice: req.statement?.closePrice ?? null,
        })
        if (gate.ok) {
          return { instrumentKey: inst.key, quote: gate.value, source: provider.id, warnings }
        }
        // Refused, not repaired. The cached value stands and the user is told.
        warnings.push(`${provider.id} rejected: ${gate.reason}`)
      } else {
        warnings.push(`${provider.id}: ${res.reason}`)
      }
    } catch (e) {
      warnings.push(`${provider.id} threw: ${e instanceof Error ? e.message : String(e)}`)
    }
    }
  }

  // 3. Statement snapshot.
  if (req.statement && isFiniteNumber(req.statement.closePrice) && req.statement.closePrice > 0) {
    return {
      instrumentKey: inst.key,
      quote: statementQuote(req, req.statement),
      source: 'statement',
      warnings,
    }
  }

  // 4. Last known.
  if (req.previous) {
    return {
      instrumentKey: inst.key,
      quote: req.previous,
      source: req.previous.provenance.source,
      warnings,
    }
  }

  warnings.push('no price available from any source')
  return { instrumentKey: inst.key, quote: null, source: null, warnings }
}

export async function refreshQuotes(
  requests: QuoteRequest[],
  opts: RefreshOptions = {},
): Promise<QuoteResult[]> {
  const provider = opts.priceProvider ?? createStockanalysisPriceProvider(opts)
  const live = opts.live !== false
  const now = opts.now ?? new Date()
  const settled = await runPooled(requests, opts.concurrency ?? 4, (req) =>
    quoteOne(provider, req, live, now),
  )
  return requests.map((req, i) => {
    const r = settled[i]
    if (r && r.status === 'fulfilled') return r.value
    const reason = r && r.status === 'rejected' ? String(r.reason) : 'refresh aborted'
    // Same chain as `quoteOne`: statement outranks last-known.
    const fallback = req.statement ? statementQuote(req, req.statement) : (req.previous ?? null)
    return {
      instrumentKey: req.instrument.key,
      quote: fallback,
      source: fallback ? fallback.provenance.source : null,
      warnings: [reason],
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// DIVIDEND PROFILES
// ─────────────────────────────────────────────────────────────────────────────

export interface ProfileRequest {
  instrument: Instrument
  override?: ProviderOverride | null
}

export interface ProfileResult {
  instrumentKey: string
  profile: DividendProfile | null
  source: ProviderId | null
  warnings: string[]
}

async function profileOne(
  providers: DividendProvider[],
  req: ProfileRequest,
): Promise<ProfileResult> {
  const warnings: string[] = []
  for (const provider of providers) {
    try {
      const res = await provider.profile(req.instrument, req.override ?? null)
      if (res.ok) {
        // An accumulating fund is a real, complete answer — stop here rather than
        // ask the next provider and get its phantom rows instead.
        return {
          instrumentKey: req.instrument.key,
          profile: res.value,
          source: provider.id,
          warnings,
        }
      }
      warnings.push(`${provider.id}: ${res.reason}`)
    } catch (e) {
      warnings.push(`${provider.id} threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { instrumentKey: req.instrument.key, profile: null, source: null, warnings }
}

/**
 * extraETF first (deep, ISIN-addressed, correct dividend currency), stockanalysis
 * second — it is the only one of the two that covers individual stocks, which the
 * user will add.
 */
export async function refreshDividendProfiles(
  requests: ProfileRequest[],
  opts: RefreshOptions = {},
): Promise<ProfileResult[]> {
  const providers = opts.dividendProviders ?? [
    createExtraEtfProvider(opts),
    createStockanalysisDividendProvider(opts),
  ]
  const settled = await runPooled(requests, opts.concurrency ?? 3, (req) =>
    profileOne(providers, req),
  )
  return requests.map((req, i) => {
    const r = settled[i]
    if (r && r.status === 'fulfilled') return r.value
    return {
      instrumentKey: req.instrument.key,
      profile: null,
      source: null,
      warnings: [r && r.status === 'rejected' ? String(r.reason) : 'refresh aborted'],
    }
  })
}
