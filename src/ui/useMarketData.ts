import { useCallback, useState } from 'react'
import { db, saveSettings } from '../db/schema'
import { fetchRatesRange } from '../providers/frankfurter'
import { refreshDividendProfiles, refreshQuotes } from '../providers/index'
import type {
  Currency,
  Instrument,
  InstrumentOverride,
  ISODate,
  PositionSnapshot,
  Quote,
  Transaction,
} from '../domain/types'

/**
 * Market-data refresh.
 *
 * Everything here is fetched from the browser, on demand, from keyless
 * CORS-open endpoints. Nothing is cached server-side and nothing about the
 * portfolio is ever uploaded — the only thing that leaves the device is an
 * ISIN or a ticker, which is unavoidable if we want a price at all.
 *
 * Refresh is always optional. A failure downgrades a number's provenance to
 * the statement's own closing price; it never blanks a screen and never throws.
 */

export interface RefreshState {
  running: boolean
  lastRun: string | null
  warnings: string[]
  quotesOk: number
  quotesFailed: number
  profilesOk: number
  fxDays: number
  error: string | null
}

const IDLE: RefreshState = {
  running: false,
  lastRun: null,
  warnings: [],
  quotesOk: 0,
  quotesFailed: 0,
  profilesOk: 0,
  fxDays: 0,
  error: null,
}

export interface RefreshInputs {
  instruments: Instrument[]
  overrides: InstrumentOverride[]
  transactions: Transaction[]
  snapshots: PositionSnapshot[]
  baseCurrency: Currency
  enabled: boolean
}

export function useMarketData() {
  const [state, setState] = useState<RefreshState>(IDLE)

  const refresh = useCallback(async (input: RefreshInputs) => {
    if (!input.enabled) {
      setState({ ...IDLE, error: 'Market data is switched off in Settings.' })
      return
    }
    setState((s) => ({ ...s, running: true, error: null, warnings: [] }))

    const warnings: string[] = []
    let quotesOk = 0
    let quotesFailed = 0
    let profilesOk = 0
    let fxDays = 0

    try {
      // 1. FX first — every other number is converted with it. One ranged call
      //    covers the whole history rather than one call per transaction.
      fxDays = await refreshFx(input, warnings)

      // 2. Quotes. The statement's own closing price is passed in as the
      //    expectation, which is what lets the pence detector self-calibrate.
      const latestSnapshot = latestSnapshotByInstrument(input.snapshots)
      const held = heldInstruments(input)

      const results = await refreshQuotes(
        held.map((instrument) => {
          const snap = latestSnapshot.get(instrument.key)
          return {
            instrument,
            override: input.overrides.find((o) => o.instrumentKey === instrument.key) ?? null,
            previous: null,
            statement: snap
              ? { closePrice: snap.closePrice, currency: snap.currency, asOf: snap.asOf }
              : null,
          }
        }),
        { live: true },
      )

      const quotes: Quote[] = []
      for (const r of results) {
        if (r.quote) {
          quotes.push(r.quote)
          quotesOk++
        } else {
          quotesFailed++
        }
        warnings.push(...r.warnings)
      }
      // Persisted, not held in memory: the staleness gate blocks a re-fetch for
      // 15 minutes, so a reload inside that window would otherwise leave the
      // app with no quotes and no permission to get any.
      if (quotes.length) await db.quotes.bulkPut(quotes)

      // 3. Dividend profiles. These drive the forward projection; without them
      //    the forecast falls back to declared accruals only, which is honest
      //    but only sees about four weeks ahead.
      const profileResults = await refreshDividendProfiles(
        held.map((instrument) => ({
          instrument,
          override: input.overrides.find((o) => o.instrumentKey === instrument.key) ?? null,
        })),
        { live: true },
      )
      const profiles = profileResults.flatMap((r) => (r.profile ? [r.profile] : []))
      profilesOk = profiles.length
      for (const r of profileResults) warnings.push(...r.warnings)
      if (profiles.length) await db.profiles.bulkPut(profiles)

      const lastRun = new Date().toISOString()
      await saveSettings({ lastRefresh: lastRun })
      setState({
        running: false, lastRun, warnings, quotesOk, quotesFailed, profilesOk, fxDays, error: null,
      })
    } catch (err) {
      // A refresh failing is normal — these are undocumented endpoints. Report
      // it and keep whatever we already had.
      setState({
        running: false,
        lastRun: null,
        warnings,
        quotesOk,
        quotesFailed,
        profilesOk,
        fxDays,
        error: (err as Error).message,
      })
    }
  }, [])

  return { state, refresh }
}

/** Only fetch for things actually held, or ever held. Never the whole universe. */
function heldInstruments(input: RefreshInputs): Instrument[] {
  const touched = new Set(input.transactions.map((t) => t.instrumentKey))
  for (const s of input.snapshots) touched.add(s.instrumentKey)
  return input.instruments.filter(
    (i) => touched.has(i.key) && i.assetCategory !== 'Forex',
  )
}

function latestSnapshotByInstrument(
  snapshots: readonly PositionSnapshot[],
): Map<string, PositionSnapshot> {
  const out = new Map<string, PositionSnapshot>()
  for (const s of snapshots) {
    const prev = out.get(s.instrumentKey)
    if (!prev || s.asOf > prev.asOf) out.set(s.instrumentKey, s)
  }
  return out
}

/**
 * Fetch the daily FX series covering the whole transaction history, for every
 * currency the portfolio actually touches.
 *
 * Rates are keyed by the date they are FOR, not the date requested: Frankfurter
 * snaps weekends and TARGET holidays back to the previous business day and
 * echoes the real date, and `toFxRates` preserves that.
 */
async function refreshFx(input: RefreshInputs, warnings: string[]): Promise<number> {
  const currencies = new Set<Currency>()
  for (const t of input.transactions) currencies.add(t.currency)
  for (const s of input.snapshots) currencies.add(s.currency)
  for (const i of input.instruments) {
    if (i.tradeCurrency) currencies.add(i.tradeCurrency)
    if (i.divCurrency) currencies.add(i.divCurrency)
  }
  currencies.delete(input.baseCurrency)
  if (currencies.size === 0) return 0

  const dates = input.transactions.map((t) => t.date).filter(Boolean).sort()
  const start = earlier(dates[0] ?? todayISO(), todayISO())
  const end = todayISO()

  // Argument order is (start, end, base, symbols) — all four are strings, so
  // getting it wrong typechecks cleanly and silently returns nothing useful.
  const res = await fetchRatesRange(start, end, input.baseCurrency, [...currencies])
  if (!res.ok) {
    warnings.push(`Exchange rates unavailable: ${res.reason}`)
    return 0
  }
  await db.fxRates.bulkPut(res.value)
  return new Set(res.value.map((r) => r.date)).size
}

const todayISO = (): ISODate => new Date().toISOString().slice(0, 10)
const earlier = (a: ISODate, b: ISODate): ISODate => (a < b ? a : b)
