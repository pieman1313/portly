import { db } from './schema'

/**
 * Whole-database export and import.
 *
 * This is the only backup that exists. The app has no server, and IndexedDB is
 * best-effort storage that browsers evict under pressure, so an export is the
 * user's sole recovery path.
 *
 * Encryption is optional but offered, because the plaintext is a complete
 * record of someone's brokerage account and people put backups in Dropbox.
 *
 * Crypto choices, deliberately:
 *   AES-256-GCM       AEAD, so tampering is detected. Never CBC without a MAC.
 *   PBKDF2-SHA256     600k iterations, per OWASP's 2023 guidance. Argon2 would
 *                     be better but is not in WebCrypto and is not worth a wasm
 *                     dependency here.
 *   Random salt + IV  Fresh per export, from crypto.getRandomValues. A reused
 *                     GCM nonce under the same key is a catastrophic failure,
 *                     so the IV is never derived or fixed.
 */

const PBKDF2_ITERATIONS = 600_000
const SALT_BYTES = 16
const IV_BYTES = 12 // 96 bits, the size AES-GCM is specified for

export const BACKUP_FORMAT = 'portly-backup-v1'

export interface BackupPayload {
  format: typeof BACKUP_FORMAT
  createdAt: string
  encrypted: boolean
  /** base64, only when encrypted */
  salt?: string
  /** base64, only when encrypted */
  iv?: string
  /** base64 ciphertext when encrypted, otherwise the raw table dump */
  data: string | TableDump
}

export interface TableDump {
  rawFiles: unknown[]
  rawRows: unknown[]
  instruments: unknown[]
  overrides: unknown[]
  transactions: unknown[]
  distributions: unknown[]
  accruals: unknown[]
  cashEvents: unknown[]
  positions: unknown[]
  fxRates: unknown[]
  settings: unknown[]
}

const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

const unb64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function dumpTables(): Promise<TableDump> {
  const [
    rawFiles, rawRows, instruments, overrides, transactions,
    distributions, accruals, cashEvents, positions, fxRates, settings,
  ] = await Promise.all([
    db.rawFiles.toArray(), db.rawRows.toArray(), db.instruments.toArray(),
    db.overrides.toArray(), db.transactions.toArray(), db.distributions.toArray(),
    db.accruals.toArray(), db.cashEvents.toArray(), db.positions.toArray(),
    db.fxRates.toArray(), db.settings.toArray(),
  ])
  return {
    rawFiles, rawRows, instruments, overrides, transactions,
    distributions, accruals, cashEvents, positions, fxRates, settings,
  }
}

export async function exportBackup(passphrase?: string): Promise<BackupPayload> {
  const dump = await dumpTables()
  const createdAt = new Date().toISOString()

  if (!passphrase) {
    return { format: BACKUP_FORMAT, createdAt, encrypted: false, data: dump }
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(passphrase, salt)
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify(dump)),
  )

  return {
    format: BACKUP_FORMAT,
    createdAt,
    encrypted: true,
    salt: b64(salt),
    iv: b64(iv),
    data: b64(cipher),
  }
}

export async function readBackup(
  payload: BackupPayload,
  passphrase?: string,
): Promise<TableDump> {
  if (payload.format !== BACKUP_FORMAT) {
    throw new Error(`Unrecognised backup format: ${String(payload.format)}`)
  }

  if (!payload.encrypted) {
    if (typeof payload.data === 'string') throw new Error('Backup is malformed')
    return payload.data
  }

  if (!passphrase) throw new Error('This backup is encrypted — a passphrase is required')
  if (typeof payload.data !== 'string' || !payload.salt || !payload.iv) {
    throw new Error('Encrypted backup is missing its salt, IV or ciphertext')
  }

  const key = await deriveKey(passphrase, unb64(payload.salt))
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(payload.iv) as BufferSource },
      key,
      unb64(payload.data) as BufferSource,
    )
  } catch {
    // GCM authentication failure. Indistinguishable from a wrong passphrase by
    // design, and we must not hint which it was.
    throw new Error('Could not decrypt — wrong passphrase, or the file is damaged')
  }
  return JSON.parse(new TextDecoder().decode(plain)) as TableDump
}

/**
 * Restore a dump. `merge` keeps existing rows and adds missing ones (safe, and
 * the right default); `replace` wipes first.
 */
export async function restoreBackup(
  dump: TableDump,
  mode: 'merge' | 'replace' = 'merge',
): Promise<void> {
  const tables = [
    db.rawFiles, db.rawRows, db.instruments, db.overrides, db.transactions,
    db.distributions, db.accruals, db.cashEvents, db.positions, db.fxRates, db.settings,
  ]
  await db.transaction('rw', tables, async () => {
    if (mode === 'replace') await Promise.all(tables.map((t) => t.clear()))
    await Promise.all([
      db.rawFiles.bulkPut(dump.rawFiles as never[]),
      db.rawRows.bulkPut(dump.rawRows as never[]),
      db.instruments.bulkPut(dump.instruments as never[]),
      db.overrides.bulkPut(dump.overrides as never[]),
      db.transactions.bulkPut(dump.transactions as never[]),
      db.distributions.bulkPut(dump.distributions as never[]),
      db.accruals.bulkPut(dump.accruals as never[]),
      db.cashEvents.bulkPut(dump.cashEvents as never[]),
      db.positions.bulkPut(dump.positions as never[]),
      db.fxRates.bulkPut(dump.fxRates as never[]),
      db.settings.bulkPut(dump.settings as never[]),
    ])
  })
}
