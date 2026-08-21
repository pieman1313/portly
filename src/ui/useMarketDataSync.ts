import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, DEFAULT_SETTINGS } from '../db/schema'
import { useMarketData } from './useMarketData'
import type { RefreshState } from './useMarketData'

/**
 * Keeps market data fresh without the user having to ask.
 *
 * Refreshes when the app opens, and again whenever an import changes what is
 * held. A manual button still exists on the Data tab, but needing it to see
 * today's prices is a bug, not a feature.
 *
 * Mounted exactly once, from the app shell. Deliberately does NOT call
 * `usePortfolio()`: that hook runs the whole metrics pipeline, and a second
 * caller would run it a second time on every render. This reads only the few
 * small tables a refresh actually needs.
 */

/** Re-fetch on open if the last refresh is older than this. */
const STALE_MS = 15 * 60 * 1000

/**
 * Module-level, not component state, for two reasons: StrictMode mounts every
 * effect twice in development, and a tab switch remounts the shell's children.
 * Both would otherwise fire a duplicate fan-out at these endpoints.
 */
let inFlight = false
let lastSignature = ''

/** Exported for tests, which need each case to start from a clean slate. */
export function resetSyncGuard(): void {
  inFlight = false
  lastSignature = ''
}

export function useMarketDataSync(): RefreshState {
  const { state, refresh } = useMarketData()

  const data = useLiveQuery(async () => {
    const [settings, instruments, overrides, transactions, snapshots, fileCount] =
      await Promise.all([
        db.settings.get('settings'),
        db.instruments.toArray(),
        db.overrides.toArray(),
        db.transactions.toArray(),
        db.positions.toArray(),
        db.rawFiles.count(),
      ])
    return {
      settings: settings ?? DEFAULT_SETTINGS,
      instruments,
      overrides,
      transactions,
      snapshots,
      fileCount,
    }
  }, [])

  useEffect(() => {
    if (!data) return
    const { settings, instruments } = data
    if (!settings.enableMarketData) return
    // Nothing imported yet: there is nothing to look up, and firing requests
    // for an empty portfolio would just be noise.
    if (instruments.length === 0) return
    if (inFlight) return

    // What we are holding, and in what currency. A change here means an import
    // brought in something new, so the previous refresh no longer covers it.
    const signature = [
      data.fileCount,
      instruments.length,
      settings.baseCurrency,
      instruments.map((i) => i.key).sort().join(','),
    ].join('|')

    const last = settings.lastRefresh ? Date.parse(settings.lastRefresh) : 0
    const stale = !Number.isFinite(last) || Date.now() - last > STALE_MS

    if (signature === lastSignature && !stale) return

    inFlight = true
    lastSignature = signature
    void refresh({
      instruments,
      overrides: data.overrides,
      transactions: data.transactions,
      snapshots: data.snapshots,
      baseCurrency: settings.baseCurrency,
      enabled: true,
    }).finally(() => {
      inFlight = false
    })
  }, [data, refresh])

  return state
}
