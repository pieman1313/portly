/**
 * Symbol resolution — the highest-risk code in the provider layer.
 *
 * Two failure modes here are silent and expensive:
 *
 *   - A bare ticker sent for a non-US listing returns a DIFFERENT SECURITY that
 *     validates cleanly. `JEPI` is a $57.72 US NYSEArca fund; `JEPI.L` is a $24.95
 *     Irish UCITS ETF. Both are USD, so no currency check can catch the swap —
 *     only the exchange qualifier can. So: never emit a bare ticker for a listing
 *     we know is not US.
 *   - IBKR renames tickers. Conid 234004667 reports as `TDIV` in some sections of
 *     the same file and `VDIVd` in others; `AMS-VDIVD` 404s and `AMS-TDIV` 200s.
 *     So we try every alias the broker has ever used, not just the current one.
 */

import type { Currency, Instrument } from '../domain/types'
import type { ProviderOverride } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// VENUES
// ─────────────────────────────────────────────────────────────────────────────

export type VenueMapping =
  | { kind: 'prefixed'; prefix: string }
  /** US venues address by bare ticker — that is the correct form, not a fallback. */
  | { kind: 'us' }
  | { kind: 'unknown' }

/**
 * IBKR `Listing Exch` → stockanalysis venue prefix.
 *
 * A Map, not an object literal: `listingExchange` comes from a user-supplied CSV
 * and a column reading `__proto__` must not reach a prototype chain.
 */
const VENUE_PREFIX = new Map<string, string>([
  ['LSEETF', 'LON'],
  ['LSE', 'LON'],
  ['AEB', 'AMS'],
  // Borsa Italiana is BIT, not MIL, and Euronext Paris is EPA, not PAR.
  // Both were wrong from the start and neither had ever returned a price:
  // MIL-SWDA and PAR-MC 404, BIT-SWDA and EPA-MC are 200.
  ['BVME.ETF', 'BIT'],
  ['BVME', 'BIT'],
  ['SBF', 'EPA'],
  ['IBIS', 'ETR'],
  ['IBIS2', 'ETR'],
  ['XETRA', 'ETR'],
  ['SEHK', 'HKG'],
  ['TSE', 'TSX'],
  // Verified live against a known listing on each venue before adding.
  ['EBS', 'SWX'],
  ['SWX', 'SWX'],
  ['VSE', 'VIE'],
  ['BM', 'BME'],
  ['OSE', 'OSL'],
  ['TSEJ', 'TYO'],
  ['ASX', 'ASX'],
])

const US_VENUES = new Set([
  'NASDAQ',
  'NASDAQ.NMS',
  'NYSE',
  'ARCA',
  'BATS',
  'AMEX',
  'NYSEAM',
  'IEX',
  'PSE',
])

/**
 * Last-resort currency for a venue, used only when the statement never told us
 * what the instrument trades in.
 *
 * LON is deliberately absent: the LSE lists in GBP, GBX, USD *and* EUR on the
 * same board (IUIT is USD, VEUR is GBP, IUKD is GBX), so guessing there is how
 * the pence bug gets in. No answer beats a wrong answer.
 */
const VENUE_CURRENCY = new Map<string, Currency>([
  ['AMS', 'EUR'],
  ['BIT', 'EUR'],
  ['ETR', 'EUR'],
  ['EPA', 'EUR'],
  ['BME', 'EUR'],
  ['VIE', 'EUR'],
  ['HKG', 'HKD'],
  ['TSX', 'CAD'],
  ['SWX', 'CHF'],
  ['OSL', 'NOK'],
  ['TYO', 'JPY'],
  ['ASX', 'AUD'],
])

/** Every prefix the venue table can emit — used to classify a manual override. */
const KNOWN_PREFIXES = new Set(VENUE_PREFIX.values())

export function mapListingExchange(listingExchange: string | null | undefined): VenueMapping {
  const key = (listingExchange ?? '').trim().toUpperCase()
  if (key === '') return { kind: 'unknown' }
  const prefix = VENUE_PREFIX.get(key)
  if (prefix) return { kind: 'prefixed', prefix }
  if (US_VENUES.has(key)) return { kind: 'us' }
  return { kind: 'unknown' }
}

export function venueCurrency(mapping: VenueMapping): Currency | null {
  if (mapping.kind === 'us') return 'USD'
  if (mapping.kind === 'prefixed') return VENUE_CURRENCY.get(mapping.prefix) ?? null
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// TICKERS
// ─────────────────────────────────────────────────────────────────────────────

/** Everything that will ever be interpolated into a provider URL path. Anything
 *  outside this set is rejected rather than escaped — a ticker with a slash in it
 *  is a parser bug or an attack, never a security. */
const SAFE_TICKER = /^[A-Z0-9][A-Z0-9.-]{0,19}$/
const SAFE_OVERRIDE = /^[A-Z0-9][A-Z0-9.-]{0,31}$/

function normalizeTicker(raw: string): string | null {
  // IBKR writes multi-class US tickers with a space (`BRK B`); every provider
  // we talk to uses a dot.
  const t = raw.trim().toUpperCase().replace(/\s+/g, '.')
  return SAFE_TICKER.test(t) ? t : null
}

/**
 * IBKR appends a lowercase disambiguation letter when a ticker is reissued
 * (`VDIV` → `VDIVd`). No provider carries it, so the stripped form is worth
 * trying — but as a guess, after every ticker the broker actually reported.
 */
export function stripDisambiguator(raw: string): string | null {
  const m = /^([A-Z0-9]{2,})[a-z]$/.exec(raw.trim())
  return m ? m[1]! : null
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

export type SymbolConfidence = 'high' | 'low'

export interface SymbolResolution {
  /** Provider symbols to try, best first. Empty means "do not call the provider". */
  candidates: string[]
  confidence: SymbolConfidence
  /** Set whenever confidence is low, so Settings can prompt for an override. */
  note: string | null
  /**
   * Which stockanalysis path form these candidates use. `q` addresses an
   * exchange-prefixed listing, `s` addresses a US symbol. They are not
   * interchangeable: /api/quotes/q/AAPL is a 404 and /api/quotes/s/LON-IUKD is
   * a 404. Carried explicitly rather than sniffed from the string, because a
   * US ticker such as BRK-B is indistinguishable from a prefixed one.
   */
  pathKind: 'q' | 's'

}

/**
 * Candidate provider symbols in priority order.
 *
 * Order is: user override (short-circuits everything) → current ticker → every
 * historical alias → stripped-disambiguator guesses. Broker-reported tickers are
 * evidence; the stripped form is inference, so it sorts last.
 */
export function resolveSymbolCandidates(
  inst: Instrument,
  override?: ProviderOverride | null,
): SymbolResolution {
  if (override?.excluded === true) {
    return { candidates: [], confidence: 'high', note: 'excluded by user', pathKind: 'q' }
  }

  const manual = override?.providerSymbol
  if (typeof manual === 'string' && manual.trim() !== '') {
    const up = manual.trim().toUpperCase()
    // A garbage override is reported, never silently discarded: falling back to
    // auto-resolution behind the user's back is how you end up on the US JEPI.
    if (!SAFE_OVERRIDE.test(up)) {
      return {
        candidates: [], confidence: 'low', pathKind: 'q',
        note: `override "${manual}" is not a valid symbol`,
      }
    }
    // An override may name either form. A recognised venue prefix means the
    // exchange-addressed path; anything else is treated as a US symbol.
    const prefixed = KNOWN_PREFIXES.has(up.split('-')[0] ?? '')
    return { candidates: [up], confidence: 'high', note: null, pathKind: prefixed ? 'q' : 's' }
  }

  // Cash forex has no listing and no provider symbol; FX comes from Frankfurter.
  if (inst.assetCategory === 'Forex' || inst.assetCategory === 'Cash') {
    return { candidates: [], confidence: 'high', note: 'forex is priced from FX rates', pathKind: 'q' }
  }

  const reported: string[] = []
  const seen = new Set<string>()
  for (const raw of [inst.symbol, ...(inst.aliases ?? [])]) {
    if (typeof raw !== 'string') continue
    const t = normalizeTicker(raw)
    if (!t || seen.has(t)) continue
    seen.add(t)
    reported.push(t)
  }

  const guessed: string[] = []
  for (const raw of [inst.symbol, ...(inst.aliases ?? [])]) {
    if (typeof raw !== 'string') continue
    const base = stripDisambiguator(raw)
    if (!base) continue
    const t = normalizeTicker(base)
    if (!t || seen.has(t)) continue
    seen.add(t)
    guessed.push(t)
  }

  const tickers = [...reported, ...guessed]
  if (tickers.length === 0) {
    return { candidates: [], confidence: 'low', note: 'no usable ticker on the instrument', pathKind: 'q' }
  }

  const venue = mapListingExchange(inst.listingExchange)
  if (venue.kind === 'prefixed') {
    return {
      candidates: tickers.map((t) => `${venue.prefix}-${t}`),
      confidence: 'high',
      note: null,
      pathKind: 'q',
    }
  }
  if (venue.kind === 'us') {
    // US venues address by bare symbol on the `s` path.
    return { candidates: tickers, confidence: 'high', note: null, pathKind: 's' }
  }

  // Unknown venue: the bare ticker is all we have and it is exactly the form that
  // silently returns the wrong security, so it goes last and is flagged.
  return {
    candidates: tickers,
    confidence: 'low',
    pathKind: 's',
    note: `unknown listing exchange "${inst.listingExchange ?? ''}" — a bare ticker may match a different security`,
  }
}

export function resolveProviderSymbol(
  inst: Instrument,
  override?: ProviderOverride | null,
): string[] {
  return resolveSymbolCandidates(inst, override).candidates
}

/**
 * Currency to stamp on a quote when the provider does not say.
 *
 * stockanalysis returns `{"p":1032.4}` for LON-IUKD with no currency field at all,
 * so the statement's own trade currency is the authority and the venue table is
 * only reached for an instrument we have never held.
 */
export function expectedQuoteCurrency(
  inst: Instrument,
  override?: ProviderOverride | null,
): Currency | null {
  if (override?.manualPriceCurrency) return override.manualPriceCurrency
  if (inst.tradeCurrency) return inst.tradeCurrency
  return venueCurrency(mapListingExchange(inst.listingExchange))
}
