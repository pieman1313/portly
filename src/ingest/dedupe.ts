/**
 * Section classification, natural keys and stable ids.
 *
 * An Activity Statement carries no transaction id — only a Flex query does. So
 * identity has to be reconstructed from row content. Two statements that
 * overlap (December, then the full year) must produce byte-identical ids for
 * the rows they share, while two genuinely identical fills on the same day must
 * stay two rows.
 *
 * The resolution is the date-scoped occurrence ordinal: IBKR never splits a
 * calendar day across statements (Daily is the finest cut it offers, and every
 * longer statement is a union of whole days), so "how many rows with this key
 * exist on date D" is a fact about the broker's books, not about the statement
 * window. Both files report the same count, the ordinals line up, and the
 * second import is a clean no-op. Counting occurrences per FILE instead would
 * hand ordinal 7 to a row the monthly statement stored as ordinal 1.
 */

export type SectionClass =
  | 'EVENT'
  | 'SNAPSHOT'
  | 'PERIOD_AGGREGATE'
  | 'REFERENCE'
  | 'IGNORE'

// Section names are matched exactly (never trimmed or case-folded): IBKR ships
// double spaces and ampersands inside them, and has renamed sections over time
// — the renames are listed as separate entries rather than normalised away.
const CLASSES: ReadonlyArray<readonly [SectionClass, readonly string[]]> = [
  [
    'EVENT',
    [
      'Trades',
      'Dividends',
      'Payment In Lieu Of Dividends',
      'Withholding Tax',
      'Interest',
      'Broker Interest Paid',
      'Broker Interest Received',
      'Bond Interest Paid',
      'Bond Interest Received',
      'Deposits & Withdrawals',
      'Deposits/Withdrawals',
      'Deposits',
      'Change in Dividend Accruals',
      'Fees',
      'Other Fees',
      'Advisor Fees',
      'Transaction Fees',
      'Commission Adjustments',
      'Price Adjustments',
      'Corporate Actions',
      'Transfers',
      'Incoming Trade Transfers',
      'Outgoing Trade Transfers',
      'Option Cash Settlements',
      'Statement of Funds',
      'Grant Activity',
    ],
  ],
  [
    'SNAPSHOT',
    [
      'Open Positions',
      'Net Asset Value',
      'Cash Report',
      'Interest Accruals',
      'Forex Balances',
      'Net Stock Position Summary',
      'Open Dividend Accruals',
      'Complex Position Summary',
      'Collateral for Customer Borrowing',
      'Stock Yield Enhancement Program Securities Lent',
    ],
  ],
  [
    'PERIOD_AGGREGATE',
    [
      'Change in NAV',
      'Change in Combined NAV',
      'Mark-to-Market Performance Summary',
      'Realized & Unrealized Performance Summary',
      'Total P/L for Statement Period',
      'Month & Year to Date Performance Summary',
      'Change in Position Value',
      'Positions and Mark-to-Market Profit and Loss',
      'Trade Summary by Symbol',
      'Trade Summary by Asset Class',
    ],
  ],
  ['REFERENCE', ['Financial Instrument Information', 'Codes', 'Base Currency Exchange Rate']],
  [
    'IGNORE',
    ['Notes/Legal Notes', 'Notes', 'Legal Notes', 'Statement', 'Account Information', 'Disclaimer'],
  ],
]

const SECTION_CLASS: ReadonlyMap<string, SectionClass> = new Map(
  CLASSES.flatMap(([cls, names]) => names.map((n) => [n, cls] as const)),
)

/**
 * Unknown sections fall back to IGNORE: we would rather drop a section IBKR
 * added last month than guess a key for it and dedupe it wrongly. Callers are
 * expected to warn on the ones they do not recognise.
 */
export function sectionClass(section: string): SectionClass {
  return SECTION_CLASS.get(section) ?? 'IGNORE'
}

// ─────────────────────────────────────────────────────────────────────────────
// Column access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Look a column up by name against the header bound to this row, trying each
 * candidate in order. Regexes exist because the base currency is interpolated
 * into column names (`Comm in USD`, `Value in EUR`) and because bonds swap
 * `Mult` for `Accrued Int.`.
 */
export function col(bound: Map<string, string>, names: readonly (string | RegExp)[]): string {
  for (const n of names) {
    if (typeof n === 'string') {
      const v = bound.get(n)
      if (v !== undefined) return v
    } else {
      for (const [k, v] of bound) if (k !== '' && n.test(k)) return v
    }
  }
  return ''
}

/** Column aliases, per §3.2 rule 3 of the format research. Order is preference. */
export const COL = {
  discriminator: ['DataDiscriminator'],
  assetCategory: ['Asset Category', 'Asset Class'],
  currency: ['Currency'],
  symbol: ['Symbol'],
  description: ['Description'],
  dateTime: ['Date/Time', 'Date', 'Settle Date', 'Value Date', 'Report Date', 'Activity Date'],
  date: ['Date', 'Settle Date', 'Value Date', 'Report Date', 'Activity Date', 'Date/Time'],
  quantity: ['Quantity', 'Qty', 'Settled Quantity'],
  price: ['T. Price', 'Trade Price', 'Xfer Price', 'Price'],
  proceeds: ['Proceeds', 'Notional Value'],
  commission: ['Comm/Fee', 'Comm/Tax', /^Comm in /],
  basis: ['Basis'],
  costBasis: ['Cost Basis', /^Cost Basis in /],
  costPrice: ['Cost Price'],
  closePrice: ['Close Price'],
  value: ['Value', /^Value in /, 'Market Value'],
  unrealized: ['Unrealized P/L', /^Unrealized P\/L in /],
  realized: ['Realized P/L'],
  amount: ['Amount', 'Cash Amount'],
  code: ['Code'],
  exDate: ['Ex Date'],
  payDate: ['Pay Date'],
  grossRate: ['Gross Rate'],
  grossAmount: ['Gross Amount', 'Gross Amnt'],
  netAmount: ['Net Amount', 'Net Amnt'],
  tax: ['Tax'],
  fee: ['Fee'],
  multiplier: ['Multiplier', 'Mult'],
  conid: ['Conid'],
  securityId: ['Security ID'],
  listingExch: ['Listing Exch'],
  underlying: ['Underlying'],
  type: ['Type'],
  subtitle: ['Subtitle'],
  direction: ['Direction'],
  xferAccount: ['Xfer Account'],
} as const satisfies Record<string, readonly (string | RegExp)[]>

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalisation
// ─────────────────────────────────────────────────────────────────────────────

/** IBKR's four flavours of "nothing here". Only `0` means zero. */
const EMPTYISH = new Set(['', '--', '-'])

const ISO_DT = /^(\d{4}-\d{2}-\d{2})(?:,?\s+(\d{2}:\d{2}:\d{2}))?$/
const NUMERIC = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/

/**
 * Make a raw cell comparable across statements. `"3,334.3400"` and `3334.34`
 * are the same number; `"2025-07-14, 07:37:45"` and `2025-07-14T07:37:45` are
 * the same instant; `" "` and `--` are both nothing.
 *
 * Deliberately lossy — this feeds keys, not the ledger. The raw text is kept
 * verbatim in raw_rows.
 */
export function canon(v: string | null | undefined): string {
  if (v == null) return ''
  const t = v.trim().replace(/\s+/g, ' ')
  if (EMPTYISH.has(t)) return ''

  const dt = ISO_DT.exec(t)
  if (dt) return dt[2] ? `${dt[1]}T${dt[2]}` : (dt[1] ?? '')

  if (NUMERIC.test(t)) {
    const n = Number(t.replace(/,/g, ''))
    if (Number.isFinite(n)) return canonNumber(n)
  }
  return t
}

/** Fixed scale so 50, 50.0 and 50.000000001 do not produce three keys. */
function canonNumber(n: number): string {
  if (n === 0) return '0'
  const s = n.toFixed(9).replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

/** The Code column is a `;`-separated set — order is not meaningful. */
export function canonCodes(v: string | null | undefined): string {
  return (v ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean)
    .sort()
    .join(';')
}

/**
 * `Stocks - Held with Interactive Brokers (U.K.) Limited carried by …` is the
 * same bucket as `Stocks`; the custody suffix must not fork the key.
 */
export function assetBucket(v: string | null | undefined): string {
  return (v ?? '').split(' - Held with')[0]?.trim() ?? ''
}

// ─────────────────────────────────────────────────────────────────────────────
// Natural keys
// ─────────────────────────────────────────────────────────────────────────────

/** ASCII unit separator — a byte no CSV cell can contain, so ['ab','c'] and
 * ['a','bc'] can never produce the same key string. */
export const KEY_SEP = '\u001f'

export function keyString(parts: readonly (string | number | null)[]): string {
  return parts.map((p) => (p == null ? '' : String(p))).join(KEY_SEP)
}

/**
 * The ordered field list that identifies a row within its section, or null if
 * the section is not an EVENT section (SNAPSHOT / PERIOD_AGGREGATE / REFERENCE
 * are keyed by window or by identity, never by row content).
 *
 * `resolveSymbol` lets the caller substitute a resolved instrument key for the
 * raw ticker, so a statement that says `TDIV` and one that says `VDIVd` key the
 * same trade identically. Without it the key degrades to the raw symbol.
 *
 * Every key contains a date. That is what makes the occurrence ordinal
 * date-scoped, and therefore stable across overlapping imports.
 */
export function naturalKey(
  section: string,
  bound: Map<string, string>,
  resolveSymbol?: (symbol: string) => string,
): string[] | null {
  if (sectionClass(section) !== 'EVENT') return null

  const c = (names: readonly (string | RegExp)[]) => canon(col(bound, names))
  const sym = () => {
    const raw = col(bound, COL.symbol).trim()
    if (raw === '') return ''
    return canon(resolveSymbol ? resolveSymbol(raw) : raw)
  }

  switch (section) {
    case 'Trades': {
      // Commission / basis / realized P/L are deliberately absent: IBKR restates
      // them between an annual and a monthly cut of the same fill. They live in
      // the content hash instead.
      const level = col(bound, COL.discriminator).trim().toUpperCase()
      return [
        'trade',
        level,
        assetBucket(col(bound, COL.assetCategory)),
        c(COL.currency),
        sym(),
        c(COL.dateTime),
        c(COL.quantity),
        c(COL.price),
      ]
    }

    // The description carries the ISIN and the per-share rate, which is what
    // separates two payments on the same instrument on the same day.
    case 'Dividends':
    case 'Payment In Lieu Of Dividends':
      return ['div', section, c(COL.currency), c(COL.date), c(COL.description), c(COL.amount)]

    case 'Withholding Tax':
      return ['wht', c(COL.currency), c(COL.date), c(COL.description), c(COL.amount)]

    case 'Deposits & Withdrawals':
    case 'Deposits/Withdrawals':
    case 'Deposits':
      return ['dw', c(COL.currency), c(COL.date), c(COL.description), c(COL.amount)]

    case 'Fees':
    case 'Other Fees':
    case 'Advisor Fees':
      return [
        'fee',
        section,
        c(COL.subtitle),
        c(COL.currency),
        c(COL.date),
        c(COL.description),
        c(COL.amount),
      ]

    case 'Transaction Fees':
      return [
        'txfee',
        assetBucket(col(bound, COL.assetCategory)),
        c(COL.currency),
        c(COL.dateTime),
        sym(),
        c(COL.description),
        c(COL.quantity),
        c(COL.price),
        c(COL.amount),
      ]

    case 'Change in Dividend Accruals':
      // Tax, gross amount and code are load-bearing: the real statement carries
      // two `Po` rows for one instrument on one ex-date that differ ONLY in tax
      // (4.42 vs 5.02). Collapsing them breaks the accrual balance by 0.60.
      return [
        'divaccr',
        assetBucket(col(bound, COL.assetCategory)),
        c(COL.currency),
        sym(),
        c(COL.date),
        c(COL.exDate),
        c(COL.payDate),
        c(COL.quantity),
        c(COL.grossRate),
        c(COL.grossAmount),
        c(COL.tax),
        c(COL.fee),
        canonCodes(col(bound, COL.code)),
      ]

    case 'Corporate Actions':
      // Date/Time is the effective date; Report Date is when IBKR got around to
      // printing it and moves between statements.
      return [
        'ca',
        assetBucket(col(bound, COL.assetCategory)),
        c(COL.currency),
        c(['Date/Time', 'Report Date']),
        c(COL.description),
        c(COL.quantity),
        c(COL.proceeds),
        c(COL.value),
      ]

    case 'Transfers':
      // Direction + counterparty account keeps the In and Out legs of one
      // inter-company transfer as two distinct rows.
      return [
        'xfer',
        assetBucket(col(bound, COL.assetCategory)),
        c(COL.currency),
        c(COL.date),
        sym(),
        c(['Type']),
        c(COL.direction),
        c(COL.quantity),
        c(COL.xferAccount),
      ]

    case 'Incoming Trade Transfers':
    case 'Outgoing Trade Transfers':
      return [
        'tradexfer',
        section,
        c(COL.currency),
        c(COL.date),
        sym(),
        c(['Instruction']),
        c(COL.quantity),
        c(COL.price),
      ]

    case 'Statement of Funds':
      // Balance is a running total that shifts with the statement window.
      return [
        'sof',
        c(COL.currency),
        c(['Report Date']),
        c(['Activity Date']),
        c(COL.description),
        c(['Debit']),
        c(['Credit']),
      ]

    // Interest, adjustments, option cash settlements, grants: all plain
    // (currency, date, description, amount) cash lines. Section is in the key
    // so Broker Interest Paid cannot collide with Broker Interest Received.
    default:
      return ['cash', section, c(COL.currency), c(COL.date), c(COL.description), c(COL.amount)]
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ids
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable content id: sha256 over the key parts plus the occurrence ordinal,
 * truncated. 20 hex chars is 80 bits — collision-safe for a personal ledger and
 * short enough to read in a debugger.
 */
export function makeId(parts: readonly (string | number | null)[], ordinal: number): string {
  return sha256HexSync(`${keyString(parts)}\u001e${ordinal}`).slice(0, 20)
}

/**
 * The occurrence index (0-based) of each item within its own key group, in file
 * order. Pass a `keyOf` that includes the calendar date — every key from
 * `naturalKey` does — so the count is scoped to the day and survives a
 * different statement window.
 */
export function assignOrdinals<T>(items: readonly T[], keyOf: (t: T) => string): number[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const k = keyOf(item)
    const n = seen.get(k) ?? 0
    seen.set(k, n + 1)
    return n
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// sha256
// ─────────────────────────────────────────────────────────────────────────────

// Hand-rolled because ids are minted in the middle of a synchronous walk, and
// crypto.subtle.digest is async while node:crypto does not exist in the browser
// this ships to. Named `…Sync` to stay distinct from statement.ts's WebCrypto
// `sha256Hex`, which hashes whole files where awaiting is fine.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0

export function sha256HexSync(msg: string): string {
  const bytes = new TextEncoder().encode(msg)
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const dv = new DataView(padded.buffer)
  const bits = bytes.length * 8
  dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000))
  dv.setUint32(padded.length - 4, bits >>> 0)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] as number
      const y = w[i - 2] as number
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0
    }

    let a = h[0] as number
    let b = h[1] as number
    let c = h[2] as number
    let d = h[3] as number
    let e = h[4] as number
    let f = h[5] as number
    let g = h[6] as number
    let hh = h[7] as number

    for (let i = 0; i < 64; i++) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (hh + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    h[0] = ((h[0] as number) + a) >>> 0
    h[1] = ((h[1] as number) + b) >>> 0
    h[2] = ((h[2] as number) + c) >>> 0
    h[3] = ((h[3] as number) + d) >>> 0
    h[4] = ((h[4] as number) + e) >>> 0
    h[5] = ((h[5] as number) + f) >>> 0
    h[6] = ((h[6] as number) + g) >>> 0
    h[7] = ((h[7] as number) + hh) >>> 0
  }

  let out = ''
  for (let i = 0; i < 8; i++) out += (h[i] as number).toString(16).padStart(8, '0')
  return out
}
