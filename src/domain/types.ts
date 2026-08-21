/**
 * Shared domain contract.
 *
 * Two layers, deliberately:
 *   RAW      — every line of every imported statement, verbatim, kept forever.
 *   DERIVED  — everything else. Disposable; rebuilt from RAW on parser upgrade.
 *
 * A parser bug must never be a data-loss bug. If we mis-read something, we bump
 * PARSER_VERSION and re-derive — we never ask the user to re-find an old export.
 */

export type Currency = string // ISO 4217: 'USD' | 'EUR' | 'GBP' | ...
export type ISODate = string // 'YYYY-MM-DD'
export type ISODateTime = string // 'YYYY-MM-DDTHH:mm:ss' (local to the exchange)

/** Bump when the parser changes semantics. Triggers a re-derive from raw_rows. */
export const PARSER_VERSION = 1

// ─────────────────────────────────────────────────────────────────────────────
// RAW LAYER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IBKR's row-type column. Note the empty string is a real, load-bearing value
 * (continuation rows in Notes/Legal Notes), so it cannot be normalised to null.
 */
export type RowType = 'Header' | 'Data' | 'SubTotal' | 'Total' | 'Notes' | ''

export interface RawFile {
  /** sha256 of the raw bytes. Primary key — re-importing byte-identical files is a no-op. */
  id: string
  name: string
  sha256Raw: string
  /**
   * sha256 over every line EXCEPT `Statement,Data,WhenGenerated`. Catches the
   * "same period, regenerated an hour later" case that sha256Raw misses.
   */
  sha256Canonical: string
  bytes: number
  importedAt: ISODateTime
  parserVersion: number

  // Statement identity — used to classify overlap between imports.
  account: string | null
  broker: string | null
  title: string | null
  periodStart: ISODate | null
  periodEnd: ISODate | null
  whenGenerated: string | null
  baseCurrency: Currency | null

  rowCount: number
  /** Sections actually present in this file. Restatement only applies to these. */
  sections: string[]
}

export interface RawRow {
  /** `${fileId}:${lineNo}` */
  id: string
  fileId: string
  /** 1-based line number in the original file. */
  lineNo: number
  section: string
  rowType: RowType
  /** Fields after CSV unquoting only — no trimming, no coercion. */
  fields: string[]
  /**
   * The header row bound to this section at this point in the file. A section
   * can rebind its header mid-file (Trades does: Stocks, then Forex), so the
   * header must be snapshotted per row, not looked up per section.
   */
  header: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// DERIVED LAYER
// ─────────────────────────────────────────────────────────────────────────────

/** How confident we are in the identity match, for UI disclosure. */
export type IdentitySource = 'conid' | 'isin' | 'symbol+exchange' | 'symbol'

export interface Instrument {
  /**
   * Stable primary key, in strict preference order:
   *   conid → isin → `${symbol}|${exchange}` → symbol
   * Never the bare ticker alone if anything better exists: tickers get renamed
   * (TDIV → VDIVd, same conid 234004667) and collide across venues.
   */
  key: string
  identitySource: IdentitySource

  conid: string | null
  isin: string | null
  /** Preferred display ticker — the most recently seen one. */
  symbol: string
  /** Every ticker this instrument has ever been reported under, including `symbol`. */
  aliases: string[]
  name: string

  assetCategory: string // 'Stocks' | 'Forex' | 'Bonds' | 'Options' | ...
  /** 'ETF' | 'COMMON' | null — from Financial Instrument Information. */
  type: string | null
  listingExchange: string | null
  multiplier: number

  /** Currency the instrument trades in (from Open Positions / Trades). */
  tradeCurrency: Currency | null
  /**
   * Currency dividends are actually paid in. NOT always tradeCurrency:
   * IUKD trades EUR on Borsa Italiana and pays GBP.
   */
  divCurrency: Currency | null

  firstSeen: ISODate
  lastSeen: ISODate
}

export type TradeKind = 'BUY' | 'SELL'

export interface Transaction {
  /** Content hash of the natural key. See ingest/dedupe.ts. */
  id: string
  /** Every file that reported this row. Length > 1 means overlapping statements. */
  fileIds: string[]
  sourceRowIds: string[]

  instrumentKey: string
  kind: TradeKind
  dateTime: ISODateTime
  date: ISODate

  /** Signed: positive = buy, negative = sell. Decimal — fractional shares are real. */
  quantity: number
  price: number
  currency: Currency

  proceeds: number
  /** Always stored as a positive cost, whatever sign IBKR used. */
  fees: number
  basis: number
  realizedPnl: number

  codes: string[]
  /** Soft-delete for restatement. Never hard-delete an imported row. */
  supersededAt: ISODateTime | null
}

export type CashKind =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'INTEREST'
  | 'FEE'
  | 'TAX'
  | 'FX'
  | 'OTHER'

export interface CashEvent {
  id: string
  fileIds: string[]
  sourceRowIds: string[]
  kind: CashKind
  date: ISODate
  amount: number // signed
  currency: Currency
  description: string
  supersededAt: ISODateTime | null
}

/** A dividend that was actually PAID (cash hit the account). */
export interface Distribution {
  id: string
  fileIds: string[]
  sourceRowIds: string[]

  instrumentKey: string | null
  isin: string | null
  /** IBKR's Dividends section date is the PAY date. */
  payDate: ISODate
  /** Filled in from the matching accrual when we can pair them; else null. */
  exDate: ISODate | null

  currency: Currency
  gross: number
  /** Withholding, stored positive. Matched from the Withholding Tax section. */
  tax: number
  net: number
  /** Per-share rate parsed out of the description, when present. */
  perShare: number | null
  description: string
  /** Ordinary / Mixed Income / Return of Capital / Payment in Lieu. */
  divType: string | null
  supersededAt: ISODateTime | null
}

/**
 * A declared-but-unpaid dividend, from Change in Dividend Accruals.
 *
 * IBKR posts `Po` when it accrues and `Re` when it reverses (on payment, or to
 * restate the tax). Netting Po against Re by
 * (instrument, exDate, payDate, grossRate) leaves exactly the open items.
 *
 * Caveat: IBKR posts the accrual at ex-date minus one day, so "open" here means
 * "already went ex, cash pending" — never "announced but not yet ex". That caps
 * CSV-only forward visibility at roughly four weeks.
 */
export interface Accrual {
  id: string
  fileIds: string[]
  sourceRowIds: string[]

  instrumentKey: string
  exDate: ISODate
  payDate: ISODate
  /** Share count at the record date — may differ from today's position. */
  quantity: number
  grossRate: number
  currency: Currency
  gross: number
  tax: number
  net: number
  /** True once Po/Re netting leaves a non-trivial balance AND payDate is future. */
  open: boolean
  supersededAt: ISODateTime | null
}

/**
 * Point-in-time position, straight from Open Positions. This is a SNAPSHOT
 * section: replace by (account, asOf), never accumulate across imports.
 *
 * Carries closePrice, which is why the app can render a correctly valued
 * portfolio the instant a file is dropped — offline, before any network call.
 */
export interface PositionSnapshot {
  /** `${account}|${asOf}|${instrumentKey}` */
  id: string
  fileId: string
  account: string
  asOf: ISODate
  instrumentKey: string
  currency: Currency
  quantity: number
  costPrice: number
  costBasis: number
  closePrice: number
  value: number
  unrealizedPnl: number
}

// ─────────────────────────────────────────────────────────────────────────────
// MARKET DATA (client-side fetch only — nothing is ever cached server-side)
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderId =
  | 'stockanalysis'
  | 'extraetf'
  | 'frankfurter'
  | 'euronext'
  | 'manual'
  | 'statement'

/** Every displayed number carries provenance. Staleness is shown, never hidden. */
export interface Provenance {
  source: ProviderId
  asOf: ISODateTime
}

export interface Quote {
  instrumentKey: string
  /** Always in MAJOR units. GBX is divided by 100 at the provider boundary. */
  price: number
  currency: Currency
  previousClose: number | null
  provenance: Provenance
}

/** A dividend event from an external provider (history + forward estimates). */
export interface ProviderDistribution {
  exDate: ISODate
  payDate: ISODate | null
  amount: number
  currency: Currency
  /** false = provider's own projection, not a declared payment. */
  declared: boolean
}

export interface DividendProfile {
  instrumentKey: string
  distributions: ProviderDistribution[]
  /** Payments per year, detected from history (median gap), not assumed. */
  frequency: number | null
  /** Trailing-12-month total per share, in `currency`. */
  ttmPerShare: number | null
  currency: Currency | null
  isDistributing: boolean
  /** Dividend CAGR keyed by horizon in years. */
  cagr: Record<string, number> | null
  provenance: Provenance
}

/** Daily FX. Frankfurter snaps weekends/holidays back to the prior business day. */
export interface FxRate {
  /** `${base}|${quote}|${date}` */
  id: string
  base: Currency
  quote: Currency
  /** The date the rate is FOR — may differ from the date requested. */
  date: ISODate
  rate: number
}

// ─────────────────────────────────────────────────────────────────────────────
// USER SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-instrument overrides. Always win over any provider. Sticky until cleared.
 */
export interface InstrumentOverride {
  instrumentKey: string
  /** e.g. 'LON-JEPI'. Needed because `VDIVd` 404s where its alias `TDIV` resolves. */
  providerSymbol?: string | null
  /**
   * 'minor' means the provider quotes in GBX/pence and we divide by 100.
   * Not derivable from any response — stockanalysis returns IUKD as
   * {"p":1032.4} with no currency field at all.
   */
  priceUnit?: 'major' | 'minor'
  manualPrice?: number | null
  manualPriceCurrency?: Currency | null
  divCurrency?: Currency | null
  excluded?: boolean
}

export interface Settings {
  id: 'settings'
  baseCurrency: Currency
  /** Dividend figures shown net of withholding tax by default. */
  showNetDividends: boolean
  costBasisMethod: 'FIFO' | 'AVERAGE'
  /** Opt-in: the app is fully functional offline without it. */
  enableMarketData: boolean
  lastRefresh: ISODateTime | null
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT REPORTING
// ─────────────────────────────────────────────────────────────────────────────

export type ImportOutcome =
  | 'imported'
  | 'duplicate-exact'
  | 'duplicate-regenerated'
  | 'partial-overlap'
  | 'failed'

export interface ImportReport {
  fileName: string
  outcome: ImportOutcome
  message: string
  parsed: Record<string, number> // section → rows read
  added: Record<string, number> // entity → rows newly stored
  skipped: Record<string, number> // entity → rows already present
  /** Non-fatal: unknown sections, unparseable rows, unmatched headers. */
  warnings: string[]
  /** Our totals vs IBKR's own stated totals. A mismatch means we have a bug. */
  reconciliation: ReconciliationCheck[]
}

export interface ReconciliationCheck {
  label: string
  ours: number
  theirs: number
  currency: Currency
  ok: boolean
}
