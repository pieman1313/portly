import { derive } from '../ingest/derive'
import { parseStatement } from '../ingest/statement'
import { PARSER_VERSION } from '../domain/types'
import type { ImportReport, Instrument, RawFile, RawRow } from '../domain/types'
import { db, requestPersistence } from './schema'

/**
 * Import orchestration: bytes in, deduplicated entities out.
 *
 * Imports are ADDITIVE and IDEMPOTENT. Statements from overlapping periods are
 * the normal case, not an error — a user exports a monthly statement in March
 * and then a full-year one in December, and the March trades appear in both.
 *
 * Three levels of duplicate detection, cheapest first:
 *   1. sha256Raw        the identical file, dropped without parsing.
 *   2. sha256Canonical  the same statement regenerated later. IBKR stamps
 *                       `WhenGenerated` into every export, so re-downloading
 *                       the same period yields different bytes but identical
 *                       content. Excluded from the canonical hash.
 *   3. per-entity ids   content hashes of section-specific natural keys, so
 *                       partial overlap converges row by row.
 */

export interface ImportOptions {
  /** Re-import a file we have already seen, replacing its derived rows. */
  force?: boolean
}

export async function importStatementFile(
  file: File,
  opts: ImportOptions = {},
): Promise<ImportReport> {
  const text = await file.text()
  return importStatementText(text, file.name, opts)
}

export async function importStatementText(
  text: string,
  fileName: string,
  opts: ImportOptions = {},
): Promise<ImportReport> {
  const base: ImportReport = {
    fileName,
    outcome: 'failed',
    message: '',
    parsed: {},
    added: {},
    skipped: {},
    warnings: [],
    reconciliation: [],
  }

  let parsed: Awaited<ReturnType<typeof parseStatement>>
  try {
    parsed = await parseStatement(text, fileName)
  } catch (err) {
    return { ...base, message: `Could not read the file: ${(err as Error).message}` }
  }

  const { file: fileMeta, rows, warnings } = parsed
  base.warnings = [...warnings]
  for (const r of rows) base.parsed[r.section] = (base.parsed[r.section] ?? 0) + 1

  if (!opts.force) {
    const exact = await db.rawFiles.get(fileMeta.sha256Raw)
    if (exact) {
      return {
        ...base,
        outcome: 'duplicate-exact',
        message: `Already imported on ${new Date(exact.importedAt).toLocaleDateString()}. Nothing changed.`,
      }
    }
    const regenerated = await db.rawFiles
      .where('sha256Canonical')
      .equals(fileMeta.sha256Canonical)
      .first()
    if (regenerated) {
      return {
        ...base,
        outcome: 'duplicate-regenerated',
        message:
          `This is the same statement as "${regenerated.name}", re-exported at a different time. ` +
          `Its contents are identical, so nothing changed.`,
      }
    }
  }

  const rawFile: RawFile = {
    ...fileMeta,
    id: fileMeta.sha256Raw,
    name: fileName,
    importedAt: new Date().toISOString(),
    parserVersion: PARSER_VERSION,
  }

  const bundle = derive(rawFile, rows)
  base.warnings.push(...bundle.warnings)
  base.reconciliation = bundle.reconciliation

  const counts = await persistBundle(rawFile, rows, bundle)

  await requestPersistence()

  const overlapping = Object.values(counts.skipped).some((n) => n > 0)
  return {
    ...base,
    outcome: overlapping ? 'partial-overlap' : 'imported',
    message: overlapping
      ? 'Imported. Rows already present from an earlier statement were skipped, not double-counted.'
      : 'Imported.',
    added: counts.added,
    skipped: counts.skipped,
  }
}

type Bundle = ReturnType<typeof derive>

async function persistBundle(
  rawFile: RawFile,
  rows: RawRow[],
  bundle: Bundle,
): Promise<{ added: Record<string, number>; skipped: Record<string, number> }> {
  const added: Record<string, number> = {}
  const skipped: Record<string, number> = {}

  await db.transaction(
    'rw',
    [
      db.rawFiles, db.rawRows, db.instruments, db.transactions,
      db.distributions, db.accruals, db.cashEvents, db.positions, db.fxRates,
    ],
    async () => {
      await db.rawFiles.put(rawFile)
      await db.rawRows.bulkPut(rows)

      // Instruments are REFERENCE data: upsert and union the alias sets, so a
      // ticker rename seen in a later statement merges rather than forks.
      let instAdded = 0
      for (const inst of bundle.instruments) {
        const existing = await db.instruments.get(inst.key)
        await db.instruments.put(existing ? mergeInstrument(existing, inst) : inst)
        if (!existing) instAdded++
      }
      added.instruments = instAdded

      // EVENT sections: add only ids we have never seen. This is what makes an
      // overlapping re-import a no-op rather than a double count.
      const eventTables = [
        ['transactions', db.transactions, bundle.transactions],
        ['distributions', db.distributions, bundle.distributions],
        ['accruals', db.accruals, bundle.accruals],
        ['cashEvents', db.cashEvents, bundle.cashEvents],
      ] as const

      for (const [name, table, items] of eventTables) {
        const ids = items.map((i) => i.id)
        const existing = new Set(
          (await table.bulkGet(ids)).filter(Boolean).map((r) => (r as { id: string }).id),
        )
        const fresh = items.filter((i) => !existing.has(i.id))
        // For rows we already hold, record that this file also reported them —
        // useful provenance when reconciling a discrepancy later.
        const seen = items.filter((i) => existing.has(i.id))
        if (fresh.length) await (table as { bulkPut: (x: unknown[]) => Promise<unknown> }).bulkPut(fresh)
        for (const item of seen) {
          const row = (await table.get(item.id)) as { fileIds: string[] } | undefined
          if (row && !row.fileIds.includes(rawFile.id)) {
            row.fileIds = [...row.fileIds, rawFile.id]
            await (table as { put: (x: unknown) => Promise<unknown> }).put(row)
          }
        }
        added[name] = fresh.length
        skipped[name] = seen.length
      }

      // SNAPSHOT section: keyed by (account, asOf), so re-importing the same
      // period replaces rather than accumulates.
      await db.positions.bulkPut(bundle.positions)
      added.positions = bundle.positions.length

      // Rates the statement stated about itself. Written with `add`-like
      // semantics via put on a deterministic id, and deliberately NOT allowed to
      // overwrite a rate already present: a real ECB rate fetched for that date
      // is better than one reverse-engineered from rounded block totals.
      if (bundle.fxRates.length) {
        const existing = new Set(
          (await db.fxRates.bulkGet(bundle.fxRates.map((r) => r.id)))
            .filter(Boolean)
            .map((r) => (r as { id: string }).id),
        )
        const fresh = bundle.fxRates.filter((r) => !existing.has(r.id))
        if (fresh.length) await db.fxRates.bulkPut(fresh)
        added.fxRates = fresh.length
      }
    },
  )

  return { added, skipped }
}

function mergeInstrument(existing: Instrument, next: Instrument): Instrument {
  const aliases = [...new Set([...existing.aliases, ...next.aliases])]
  return {
    ...existing,
    ...next,
    aliases,
    // Prefer whichever identity is strongest and whichever facts are known.
    conid: next.conid ?? existing.conid,
    isin: next.isin ?? existing.isin,
    name: next.name || existing.name,
    tradeCurrency: next.tradeCurrency ?? existing.tradeCurrency,
    divCurrency: next.divCurrency ?? existing.divCurrency,
    listingExchange: next.listingExchange ?? existing.listingExchange,
    firstSeen: existing.firstSeen < next.firstSeen ? existing.firstSeen : next.firstSeen,
    lastSeen: existing.lastSeen > next.lastSeen ? existing.lastSeen : next.lastSeen,
  }
}

/**
 * Re-derive every entity from the raw rows we already hold.
 *
 * This is the payoff for keeping raw_rows forever: a parser fix ships as a
 * version bump plus this call, with no re-import and no data loss.
 */
export async function rederiveAll(): Promise<{ files: number; warnings: string[] }> {
  const files = await db.rawFiles.orderBy('importedAt').toArray()
  const warnings: string[] = []

  await db.transaction(
    'rw',
    [db.instruments, db.transactions, db.distributions, db.accruals, db.cashEvents, db.positions],
    async () => {
      await Promise.all([
        db.instruments.clear(), db.transactions.clear(), db.distributions.clear(),
        db.accruals.clear(), db.cashEvents.clear(), db.positions.clear(),
      ])
    },
  )

  for (const file of files) {
    const rows = await db.rawRows.where('fileId').equals(file.id).sortBy('lineNo')
    const bundle = derive({ ...file, parserVersion: PARSER_VERSION }, rows)
    warnings.push(...bundle.warnings)
    await persistBundle({ ...file, parserVersion: PARSER_VERSION }, rows, bundle)
  }

  return { files: files.length, warnings }
}

/** Forget one statement and everything derived from it, then rebuild. */
export async function deleteFile(fileId: string): Promise<void> {
  await db.transaction('rw', [db.rawFiles, db.rawRows], async () => {
    await db.rawRows.where('fileId').equals(fileId).delete()
    await db.rawFiles.delete(fileId)
  })
  await rederiveAll()
}
