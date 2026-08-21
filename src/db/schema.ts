import Dexie from 'dexie'
import type { Table } from 'dexie'
import type {
  Accrual,
  CashEvent,
  Distribution,
  DividendProfile,
  FxRate,
  Instrument,
  InstrumentOverride,
  PositionSnapshot,
  Quote,
  RawFile,
  RawRow,
  Settings,
  Transaction,
} from '../domain/types'

/**
 * IndexedDB schema.
 *
 * Two tiers with very different lifetimes:
 *
 *   raw_files / raw_rows   Kept forever. Never rewritten by a migration. A year
 *                          of statements is a few hundred KB, and they are the
 *                          only thing standing between a parser bug and data loss.
 *
 *   everything else        Derived and disposable. Most migrations are just
 *                          "drop the derived tables and re-derive from raw".
 *
 * Migrations use an explicit version ladder. Never
 * `if (v !== CURRENT) deleteEverything()` — that is a data-loss bug wearing a
 * migration costume.
 */
export class PortlyDb extends Dexie {
  rawFiles!: Table<RawFile, string>
  rawRows!: Table<RawRow, string>

  instruments!: Table<Instrument, string>
  overrides!: Table<InstrumentOverride, string>
  transactions!: Table<Transaction, string>
  distributions!: Table<Distribution, string>
  accruals!: Table<Accrual, string>
  cashEvents!: Table<CashEvent, string>
  positions!: Table<PositionSnapshot, string>

  fxRates!: Table<FxRate, string>
  settings!: Table<Settings, string>

  /**
   * Last known market data. Persisted, not session state, because the refresh
   * is rate-limited to once every 15 minutes: without this a reload inside that
   * window has no quotes AND is not allowed to fetch, so the portfolio silently
   * falls back to the statement's closing prices. Provenance travels with each
   * row, so a stale quote is labelled rather than mistaken for a fresh one.
   */
  quotes!: Table<Quote, string>
  profiles!: Table<DividendProfile, string>

  constructor(name = 'portly') {
    super(name)

    this.version(1).stores({
      rawFiles: 'id, sha256Canonical, account, periodStart, periodEnd, importedAt',
      rawRows: 'id, fileId, section, [fileId+section], lineNo',

      instruments: 'key, isin, conid, symbol, *aliases',
      overrides: 'instrumentKey',
      transactions: 'id, instrumentKey, date, [instrumentKey+date], supersededAt',
      distributions: 'id, instrumentKey, payDate, [instrumentKey+payDate], supersededAt',
      accruals: 'id, instrumentKey, payDate, open, supersededAt',
      cashEvents: 'id, kind, date, supersededAt',
      positions: 'id, instrumentKey, asOf, [account+asOf]',

      fxRates: 'id, [base+quote], date',
      settings: 'id',
    })

    // v2 adds the market-data cache. Additive: no existing store is touched, so
    // Dexie carries every row across untouched and there is nothing to migrate.
    this.version(2).stores({
      quotes: 'instrumentKey',
      profiles: 'instrumentKey',
    })
  }
}

export const db = new PortlyDb()

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  baseCurrency: 'USD',
  showNetDividends: true,
  costBasisMethod: 'FIFO',
  enableMarketData: true,
  lastRefresh: null,
}

export async function getSettings(): Promise<Settings> {
  return (await db.settings.get('settings')) ?? DEFAULT_SETTINGS
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch, id: 'settings' as const }
  await db.settings.put(next)
  return next
}

/**
 * Ask the browser not to evict us. IndexedDB is best-effort storage by default
 * and Safari in particular will clear it — which for this app means losing the
 * entire import history. Cheap to request, so request it on first import.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}

/** Drop cached market data, forcing the next refresh to go to the network. */
export async function clearMarketData(): Promise<void> {
  await Promise.all([db.quotes.clear(), db.profiles.clear()])
  await saveSettings({ lastRefresh: null })
}

/** Wipe only the derived tables. raw_files and raw_rows are never touched. */
export async function clearDerived(): Promise<void> {
  await db.transaction(
    'rw',
    [db.instruments, db.transactions, db.distributions, db.accruals, db.cashEvents, db.positions],
    async () => {
      await Promise.all([
        db.instruments.clear(),
        db.transactions.clear(),
        db.distributions.clear(),
        db.accruals.clear(),
        db.cashEvents.clear(),
        db.positions.clear(),
      ])
    },
  )
}

/** Full reset, including raw. Only ever from an explicit, confirmed user action. */
export async function clearEverything(): Promise<void> {
  await db.delete()
  await db.open()
}
