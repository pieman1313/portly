/**
 * The gate that turns silent corruption into a visible warning.
 *
 * Every P0 in this app is a number that is wrong by a plausible-looking factor:
 * 100× from pence, 2.3× from a US ticker collision, 1× but for last week. None of
 * them throw. `checkQuote` is the one place that refuses a value, and the caller's
 * only permitted response is to keep the previous one and surface a warning —
 * never to write the rejected value "just this once".
 */

import type { Currency, Quote } from '../domain/types'
import { fail, isFiniteNumber, ok } from './types'
import type { Result } from './types'

/** Refuse a move larger than this against a known-good previous price. Splits are
 *  not yet modelled, so a real 3:1 split will trip the gate — visibly, which is
 *  the correct outcome until the user confirms it. */
export const MAX_MOVE = 0.2

/**
 * The statement's `Close Price` is a weaker reference than a previous quote: it
 * can be months old, and for a cross-listed holding it is a different venue's
 * currency (IUKD closes EUR 12.05 in Milan while LON quotes GBP 10.32 — a 14%
 * spread that is not an error). A wide band still catches the 100× that matters.
 */
export const MAX_DRIFT_FROM_STATEMENT = 0.5

/** How close to exactly 100× we require before calling it pence. */
export const MINOR_UNIT_BAND = 0.1

export type PriceUnit = 'major' | 'minor' | 'unknown'

/**
 * Decide whether the provider answered in minor units (GBX/pence).
 *
 * Self-calibrating from the CSV's own `Close Price`, because no response carries
 * the information: `stockanalysis.com/api/quotes/q/LON-IUKD` returns `{"p":1032.4}`
 * with no currency field whatsoever, and 1032.4 GBX is GBP 10.32. It is per
 * LISTING, not per exchange — on the same LSE board VEUR quotes GBP and IUKD GBX
 * — so an exchange-level table would be wrong half the time.
 *
 * Returns `unknown` (not `major`) when the two prices are in different currencies
 * and the ratio lands nowhere near 1 or 100. Guessing there is the bug.
 */
export function detectPriceUnit(
  providerPrice: number,
  statementClosePrice: number | null | undefined,
): PriceUnit {
  if (!isFiniteNumber(providerPrice) || providerPrice <= 0) return 'unknown'
  if (!isFiniteNumber(statementClosePrice) || statementClosePrice <= 0) return 'unknown'
  const ratio = providerPrice / statementClosePrice
  if (Math.abs(ratio / 100 - 1) <= MINOR_UNIT_BAND) return 'minor'
  if (Math.abs(ratio - 1) <= MINOR_UNIT_BAND) return 'major'
  return 'unknown'
}

/** `unknown` is treated as major — but only after `detectPriceUnit` has had the
 *  statement price to look at, and the gate below still has to pass. */
export function applyPriceUnit(price: number, unit: PriceUnit): number {
  return unit === 'minor' ? price / 100 : price
}

export interface QuoteExpectation {
  /** From the statement, not from the provider. Null disables the check. */
  currency: Currency | null
  /** Latest Open Positions `Close Price`. Used only when there is no previous quote. */
  closePrice?: number | null
}

function asOfMillis(v: string | null | undefined): number | null {
  if (typeof v !== 'string' || v === '') return null
  // Bare `YYYY-MM-DDTHH:mm:ss` is parsed as local time; every producer in this app
  // emits UTC, so pin it explicitly rather than letting the host timezone decide.
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}Z`
  const t = Date.parse(normalized)
  return Number.isNaN(t) ? null : t
}

/**
 * Accept or refuse a freshly fetched quote.
 *
 * On refusal the caller keeps `prev` and shows the reason. It must not retry with
 * a different provider and quietly accept whatever that one says — a disagreement
 * between sources is information, and hiding it is how the pence bug survived.
 */
export function checkQuote(
  next: Quote,
  prev: Quote | null,
  expected: QuoteExpectation,
): Result<Quote> {
  if (!next || typeof next !== 'object') return fail('quote: not an object')
  if (!isFiniteNumber(next.price)) return fail('quote: price is not a finite number')
  if (next.price <= 0) return fail(`quote: non-positive price ${next.price}`)
  if (typeof next.currency !== 'string' || next.currency === '') {
    return fail('quote: missing currency')
  }
  if (!next.provenance || typeof next.provenance.asOf !== 'string') {
    return fail('quote: missing provenance')
  }

  const want = expected.currency
  if (want && next.currency.toUpperCase() !== want.toUpperCase()) {
    return fail(`quote: currency ${next.currency} but expected ${want}`)
  }
  if (prev && prev.currency && next.currency.toUpperCase() !== prev.currency.toUpperCase()) {
    return fail(`quote: currency changed ${prev.currency} → ${next.currency}`)
  }

  if (prev) {
    const nextAt = asOfMillis(next.provenance.asOf)
    const prevAt = asOfMillis(prev.provenance.asOf)
    if (nextAt !== null && prevAt !== null && nextAt < prevAt) {
      return fail(`quote: asOf ${next.provenance.asOf} is older than cached ${prev.provenance.asOf}`)
    }
    if (isFiniteNumber(prev.price) && prev.price > 0) {
      const move = Math.abs(next.price / prev.price - 1)
      if (move > MAX_MOVE) {
        return fail(
          `quote: ${(move * 100).toFixed(1)}% move from ${prev.price} to ${next.price} exceeds ${MAX_MOVE * 100}%`,
        )
      }
      return ok(next)
    }
  }

  // No usable previous quote — fall back to the broker's own close price so that
  // a 100× error is caught on the very first fetch, not on the second.
  const close = expected.closePrice
  if (isFiniteNumber(close) && close > 0) {
    const drift = Math.abs(next.price / close - 1)
    if (drift > MAX_DRIFT_FROM_STATEMENT) {
      return fail(
        `quote: ${(drift * 100).toFixed(1)}% away from statement close ${close} (got ${next.price})`,
      )
    }
  }

  return ok(next)
}
