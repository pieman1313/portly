import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, ReactNode } from 'react'
import { Badge, Card, EmptyState, Money } from '../components/primitives'
import { usePortfolio } from '../usePortfolio'
import type { PortfolioView } from '../usePortfolio'
import { useMarketData } from '../useMarketData'
import type { RefreshState } from '../useMarketData'
import { deleteFile, importStatementFile, rederiveAll } from '../../db/import'
import { clearEverything, clearMarketData, saveSettings, storageEstimate } from '../../db/schema'
import { SUPPORTED_CURRENCIES, isSupportedCurrency } from '../../providers/frankfurter'
import { exportBackup, readBackup, restoreBackup } from '../../db/backup'
import type { BackupPayload, TableDump } from '../../db/backup'
import type {
  ImportOutcome,
  ImportReport,
  RawFile,
  ReconciliationCheck,
  Settings,
} from '../../domain/types'

/**
 * Data tab: import, settings, diagnostics.
 *
 * This screen is where the user decides whether to trust every other screen,
 * so it errs towards saying too much rather than too little. Three rules run
 * through all of it:
 *
 *   - Overlapping statements are the NORMAL case. A skipped row is
 *     reassurance ("nothing was double-counted"), never a warning.
 *   - Reconciliation against IBKR's own stated totals is the proof the import
 *     is correct, so it is shown in full rather than summarised away.
 *   - Nothing here may block the page. No window.alert / confirm / prompt:
 *     every confirmation is a two-step inline control, every result is
 *     rendered in place.
 */

/**
 * Focus ring, matching the other tabs. Every control here is either a `button`
 * or an `input`, and several sit on the accent fill where the UA default ring
 * is nearly invisible, so the ring is explicit rather than inherited.
 */
const FOCUS =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface'

export function Data() {
  const view = usePortfolio()

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Data</h1>

      <ImportSection />
      <StatementsSection view={view} />
      <MarketDataSection view={view} />
      <SettingsSection view={view} />
      <BackupSection />
      <StorageSection files={view.files.length} rows={view.transactions.length} />
      <DangerSection />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Import
// ─────────────────────────────────────────────────────────────────────────────

type JobStatus = 'pending' | 'running' | 'done' | 'ignored'

interface ImportJob {
  id: string
  name: string
  status: JobStatus
  report: ImportReport | null
  /** Only for a throw — a parse failure comes back as a report, not an error. */
  error: string | null
}

const isCsv = (f: File): boolean => /\.csv$/i.test(f.name) || f.type === 'text/csv'

function ImportSection() {
  const [jobs, setJobs] = useState<ImportJob[]>([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const seq = useRef(0)
  // Drag events fire for every child element, so a boolean flips off far too
  // early. Counting enter/leave pairs is the only reliable way to know when
  // the pointer has actually left the zone.
  const dragDepth = useRef(0)

  const run = async (files: File[]) => {
    if (busy || files.length === 0) return
    const planned: ImportJob[] = files.map((f) => ({
      id: `job-${seq.current++}`,
      name: f.name,
      status: isCsv(f) ? 'pending' : 'ignored',
      report: null,
      error: null,
    }))
    setJobs(planned)
    setBusy(true)

    const update = (id: string, patch: Partial<ImportJob>) =>
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)))

    // Sequential on purpose: each import writes to the same tables and reads
    // back what the previous one stored to detect overlap.
    for (const [i, file] of files.entries()) {
      const job = planned[i]
      if (!job || job.status === 'ignored') continue
      update(job.id, { status: 'running' })
      try {
        const report = await importStatementFile(file)
        update(job.id, { status: 'done', report })
      } catch (err) {
        update(job.id, { status: 'done', error: (err as Error).message })
      }
    }
    setBusy(false)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    void run(Array.from(e.dataTransfer.files))
  }

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    // Reset so choosing the same file twice still fires a change event.
    e.target.value = ''
    void run(files)
  }

  const total = jobs.filter((j) => j.status !== 'ignored').length
  const finished = jobs.filter((j) => j.status === 'done').length
  const ignored = jobs.length - total

  // Only this one sentence lives in the live region. The reports themselves are
  // tables and lists: piping them through aria-live would make a screen reader
  // read every cell of every report aloud on every state change.
  const status = busy
    ? total > 0
      ? `Importing file ${Math.min(finished + 1, total)} of ${total}…`
      : 'Checking the files you chose…'
    : jobs.length === 0
      ? ''
      : total === 0
        ? `Nothing to import — ${ignored === 1 ? 'that file is' : 'those files are'} not CSV.`
        : `Finished. ${finished} of ${total} ${total === 1 ? 'file' : 'files'} processed${
            ignored > 0 ? `, ${ignored} skipped as not CSV` : ''
          }. Results below.`

  return (
    <Card
      title="Import an IBKR Activity Statement"
      subtitle="Export from Interactive Brokers as CSV, then drop it here."
    >
      <p className="text-sm text-ink/90 mb-3">
        <span className="font-semibold">Your files never leave this device.</span>{' '}
        They are read and parsed entirely inside your browser and stored only on this
        machine. Portly has no server to upload them to.
      </p>

      <div
        onDragEnter={(e) => {
          e.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragging(false)
        }}
        onDrop={onDrop}
        className={`rounded-xl border border-dashed p-4 sm:p-6 text-center transition-colors ${
          dragging ? 'border-accent bg-accent/10' : 'border-border bg-white/[0.02]'
        }`}
      >
        {/* The input stays in the accessibility tree (sr-only, not hidden) so it
            is reachable by keyboard and by a screen reader; the label is the
            visible target. Drag-and-drop is an enhancement — it does not exist
            on a phone, so tap-to-choose is the primary path. */}
        <input
          id="portly-import-input"
          type="file"
          accept=".csv,text/csv"
          multiple
          disabled={busy}
          onChange={onPick}
          className="sr-only peer"
        />
        <label
          htmlFor="portly-import-input"
          className={`inline-flex items-center justify-center min-h-[44px] px-4 rounded-lg text-sm font-medium cursor-pointer
            bg-accent text-white peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2
            peer-focus-visible:ring-offset-surface ${busy ? 'opacity-60 pointer-events-none' : ''}`}
        >
          {busy ? 'Importing…' : 'Choose statement files'}
        </label>
        <p className="text-xs text-muted mt-2">
          <span className="hidden sm:inline">Or drag CSV files onto this area. </span>
          You can select several at once — they are imported one after another.
        </p>
      </div>

      {/* Rendered unconditionally so the region exists before its text changes;
          an aria-live element added at the same time as its content is not
          reliably announced. */}
      <p aria-live="polite" className="text-sm text-muted empty:hidden mt-4">
        {status}
      </p>

      {jobs.length > 0 && (
        <div className="mt-4 space-y-3">
          {jobs.map((job) => (
            <ImportJobRow key={job.id} job={job} />
          ))}
        </div>
      )}
    </Card>
  )
}

const OUTCOME: Record<
  ImportOutcome,
  { tone: 'good' | 'warn' | 'crit' | 'muted'; label: string; plain: string }
> = {
  imported: {
    tone: 'good',
    label: 'Imported',
    plain: 'Every row in this statement was new and has been stored.',
  },
  'partial-overlap': {
    tone: 'good',
    label: 'Imported, overlap skipped',
    plain:
      'This statement covers a period you had already imported. Portly already had those rows, so they were skipped — nothing has been double-counted. Overlapping statements are completely normal.',
  },
  'duplicate-exact': {
    tone: 'muted',
    label: 'Already imported',
    plain:
      'This is byte-for-byte the same file you imported before, so there was nothing new to add. Your figures are unchanged.',
  },
  'duplicate-regenerated': {
    tone: 'muted',
    label: 'Same statement, re-exported',
    plain:
      'IBKR stamps the export time into every file, so re-downloading the same period gives a different file with identical contents. Portly recognised it and changed nothing.',
  },
  failed: {
    tone: 'crit',
    label: 'Could not import',
    plain: 'Nothing was stored from this file. Your existing data is untouched.',
  },
}

function ImportJobRow({ job }: { job: ImportJob }) {
  if (job.status === 'ignored') {
    return (
      <div className="rounded-lg border border-border p-3">
        <FileHeading name={job.name} badge={<Badge tone="warn">Skipped</Badge>} />
        <p className="text-sm text-muted mt-1">
          Not a .csv file. Export your Activity Statement from IBKR in CSV format.
        </p>
      </div>
    )
  }

  if (job.status !== 'done') {
    return (
      <div className="rounded-lg border border-border p-3">
        <FileHeading
          name={job.name}
          badge={<Badge tone="muted">{job.status === 'running' ? 'Reading' : 'Queued'}</Badge>}
        />
      </div>
    )
  }

  if (job.error) {
    return (
      <div className="rounded-lg border border-crit/40 bg-crit/10 p-3">
        <FileHeading name={job.name} badge={<Badge tone="crit">Failed</Badge>} />
        <p className="text-sm mt-1">{job.error}</p>
      </div>
    )
  }

  if (!job.report) return null
  return <ReportPanel report={job.report} />
}

function FileHeading({ name, badge }: { name: string; badge: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <h3 className="text-sm font-medium break-all min-w-0">{name}</h3>
      <span className="shrink-0">{badge}</span>
    </div>
  )
}

function ReportPanel({ report }: { report: ImportReport }) {
  const meta = OUTCOME[report.outcome]
  const parsed = Object.entries(report.parsed).sort(([a], [b]) => a.localeCompare(b))
  const entities = [...new Set([...Object.keys(report.added), ...Object.keys(report.skipped)])]
    .filter((k) => (report.added[k] ?? 0) > 0 || (report.skipped[k] ?? 0) > 0)
    .sort((a, b) => a.localeCompare(b))

  const frame =
    meta.tone === 'crit'
      ? 'border-crit/40 bg-crit/10'
      : meta.tone === 'good'
        ? 'border-good/40 bg-good/5'
        : 'border-border'

  return (
    <div className={`rounded-lg border p-3 ${frame}`}>
      <FileHeading name={report.fileName} badge={<Badge tone={meta.tone}>{meta.label}</Badge>} />
      <p className="text-sm mt-1">{report.message || meta.plain}</p>
      {report.message && <p className="text-sm text-muted mt-1">{meta.plain}</p>}

      {parsed.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs uppercase tracking-wide text-muted">Rows read, by section</h4>
          <ul className="flex flex-wrap gap-1.5 mt-1.5">
            {parsed.map(([section, n]) => (
              <li
                key={section}
                className="text-[11px] border border-border rounded px-1.5 py-0.5 text-muted"
              >
                {section} <span className="num text-ink">{n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {entities.length > 0 && <AddedSkipped report={report} entities={entities} />}

      <Reconciliation report={report} />

      {report.warnings.length > 0 && (
        <details className="mt-3 group">
          <summary className="text-sm cursor-pointer min-h-[44px] flex items-center gap-2">
            <Badge tone="warn">{report.warnings.length}</Badge>
            <span>
              {report.warnings.length === 1 ? 'note from the parser' : 'notes from the parser'}
            </span>
          </summary>
          <ul className="mt-1.5 space-y-1 text-xs text-muted list-disc pl-5">
            {report.warnings.map((w, i) => (
              <li key={`${i}-${w}`}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function AddedSkipped({ report, entities }: { report: ImportReport; entities: string[] }) {
  const skippedTotal = entities.reduce((t, k) => t + (report.skipped[k] ?? 0), 0)
  return (
    <div className="mt-3">
      <h4 className="text-xs uppercase tracking-wide text-muted">Stored</h4>
      <table className="w-full mt-1.5 text-sm">
        <caption className="sr-only">
          Rows added and rows already present, by kind, for {report.fileName}
        </caption>
        <thead>
          <tr className="text-xs text-muted">
            <th scope="col" className="text-left font-normal py-1">
              Kind
            </th>
            <th scope="col" className="text-right font-normal py-1">
              Added
            </th>
            <th scope="col" className="text-right font-normal py-1">
              Already had
            </th>
          </tr>
        </thead>
        <tbody>
          {entities.map((k) => (
            <tr key={k} className="border-t border-border">
              <th scope="row" className="text-left font-normal py-1.5">
                {label(k)}
              </th>
              <td className="num text-right py-1.5">{count(report.added, k)}</td>
              <td className="num text-right py-1.5 text-muted">{count(report.skipped, k)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {skippedTotal > 0 && (
        <p className="text-xs text-muted mt-1.5">
          “Already had” rows came from a statement you imported earlier. They were matched by
          content and skipped, so nothing is counted twice.
        </p>
      )}
      {entities.includes('positions') && (
        <p className="text-xs text-muted mt-1.5">
          Position snapshots are a picture of one day, not a list of events: IBKR restates the
          whole block, so Portly replaces it rather than merging it. There is no “already had”
          figure to report for them, which is what the dash means.
        </p>
      )}
    </div>
  )
}

function Reconciliation({ report }: { report: ImportReport }) {
  const checks = report.reconciliation
  if (checks.length === 0) {
    if (report.outcome === 'failed' || report.outcome.startsWith('duplicate')) return null
    return (
      <p className="text-xs text-muted mt-3">
        This statement carried no totals of its own, so there was nothing to cross-check against.
      </p>
    )
  }

  const failed = checks.filter((c) => !c.ok)
  const allOk = failed.length === 0

  return (
    <div className="mt-3">
      <h4 className="text-xs uppercase tracking-wide text-muted">
        Cross-check against IBKR’s own totals
      </h4>

      {allOk ? (
        <p className="flex items-start gap-2 text-sm text-good mt-1.5">
          <span aria-hidden>✓</span>
          <span>
            All {checks.length} {checks.length === 1 ? 'total matches' : 'totals match'} the figures
            IBKR printed in this statement. The import is exact.
          </span>
        </p>
      ) : (
        <p className="flex items-start gap-2 text-sm text-crit mt-1.5">
          <span aria-hidden>×</span>
          <span>
            {failed.length} of {checks.length} totals do not match what IBKR printed. Treat the
            affected figures as unreliable and please report this — a mismatch means Portly has a
            bug, not that your statement is wrong.
          </span>
        </p>
      )}

      <ul className="mt-2 space-y-1.5">
        {checks.map((c, i) => (
          // Labels are not guaranteed unique — two blocks of the same section
          // and currency produce the same string — so the index is part of the key.
          <li
            key={`${i}-${c.label}`}
            className={
              c.ok
                ? 'flex items-center justify-between gap-3 text-sm'
                : 'rounded-lg border border-crit/40 bg-crit/10 p-2.5'
            }
          >
            {c.ok ? (
              <>
                <span className="flex items-center gap-2 min-w-0">
                  <span aria-hidden className="text-good">
                    ✓
                  </span>
                  <span className="truncate">{c.label}</span>
                  <span className="sr-only">matches</span>
                </span>
                <span className="shrink-0 text-muted">
                  <CheckValue check={c} value={c.ours} />
                </span>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Badge tone="crit">Mismatch</Badge>
                  <span className="text-sm font-medium">{c.label}</span>
                </div>
                {/* Two up at 360px so our figure and IBKR's stay side by side;
                    the difference wraps underneath rather than being squeezed. */}
                <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2 text-sm">
                  <div className="min-w-0">
                    <dt className="text-xs text-muted">Portly</dt>
                    <dd className="break-words">
                      <CheckValue check={c} value={c.ours} />
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted">IBKR</dt>
                    <dd className="break-words">
                      <CheckValue check={c} value={c.theirs} />
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted">Difference</dt>
                    <dd className="break-words">
                      <CheckValue check={c} value={c.ours - c.theirs} signed />
                    </dd>
                  </div>
                </dl>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One side of a reconciliation check.
 *
 * `ReconciliationCheck` carries a currency for every check, but not every check
 * is money: the Trades block reconciles a SHARE COUNT as well as proceeds,
 * commission and realized P/L, and it tags that count with the trade currency
 * because that is how the row is grouped. Rendering it with `Money` would print
 * “$100.00” for 100 shares, so quantity checks are rendered as a bare count
 * with an explicit unit instead.
 */
function CheckValue({
  check,
  value,
  signed = false,
}: {
  check: ReconciliationCheck
  value: number
  signed?: boolean
}) {
  if (isQuantityCheck(check.label)) {
    const sign = signed && value > 0 ? '+' : ''
    return (
      <span className="num">
        {sign}
        {fmtQty(value)} <span className="text-muted text-xs">units</span>
      </span>
    )
  }
  return <Money value={value} currency={check.currency} signed={signed} colored={signed} />
}

const isQuantityCheck = (label: string): boolean => label.startsWith('Trades quantity')

// ─────────────────────────────────────────────────────────────────────────────
// 2. Imported statements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Columns that only earn their space from `md` up. At 640px the six-column
 * table already needs ~575px of unbreakable content (a nowrap period, a nowrap
 * timestamp, a delete button) inside a ~592px card, so shipping all of them at
 * `sm` puts the whole page one long account number away from scrolling
 * sideways. The two droppable facts move into the first cell instead.
 */
const AT_MD = 'hidden md:table-cell'

function StatementsSection({ view }: { view: PortfolioView }) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const remove = async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      // deleteFile re-derives every figure from the statements that remain, so
      // this can take a moment on a large history.
      await deleteFile(id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card
      title="Imported statements"
      subtitle={
        view.files.length > 0
          ? `${view.files.length} ${view.files.length === 1 ? 'file' : 'files'} stored on this device`
          : undefined
      }
    >
      {view.loading ? (
        <p className="text-sm text-muted">Reading your data…</p>
      ) : view.files.length === 0 ? (
        <EmptyState title="No statements yet">
          Import an IBKR Activity Statement above and every other tab fills in immediately —
          offline, using the closing prices in the statement itself.
        </EmptyState>
      ) : (
        <>
          {error && (
            <p className="text-sm text-crit mb-3 flex items-start gap-2">
              <span aria-hidden>×</span>
              <span>Could not delete: {error}</span>
            </p>
          )}

          {/* Below sm this is a stacked card list, not a scrolling table: a
              horizontally scrolling table on a phone hides the delete button. */}
          <ul className="sm:hidden space-y-2">
            {view.files.map((f) => (
              <li key={f.id} className="rounded-lg border border-border p-3">
                <h3 className="text-sm font-medium break-all">{f.name}</h3>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-xs">
                  <Field label="Account" value={f.account ?? '—'} />
                  <Field label="Rows" value={<span className="num">{f.rowCount}</span>} />
                  <Field label="Period" value={period(f)} />
                  <Field label="Imported" value={when(f.importedAt)} />
                </dl>
                <div className="mt-2">
                  <ConfirmAction
                    label="Delete"
                    question={`Delete “${f.name}”? Everything derived from it is rebuilt from the statements that remain.`}
                    confirmLabel="Delete statement"
                    busy={busyId === f.id}
                    busyLabel="Deleting and rebuilding…"
                    onConfirm={() => remove(f.id)}
                  />
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden sm:block">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Imported statements, with account, period, import date and row count
              </caption>
              <thead>
                <tr className="text-xs text-muted">
                  <th scope="col" className="text-left font-normal py-1">
                    Statement
                  </th>
                  <th scope="col" className={`text-left font-normal py-1 ${AT_MD}`}>
                    Account
                  </th>
                  <th scope="col" className="text-left font-normal py-1">
                    Period
                  </th>
                  <th scope="col" className={`text-left font-normal py-1 ${AT_MD}`}>
                    Imported
                  </th>
                  <th scope="col" className="text-right font-normal py-1">
                    Rows
                  </th>
                  <th scope="col" className="text-right font-normal py-1">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.files.map((f) => (
                  <tr key={f.id} className="border-t border-border align-top">
                    <th scope="row" className="text-left font-normal py-2 pr-3 max-w-[18rem]">
                      <span className="block break-all">{f.name}</span>
                      <span className="block text-xs text-muted">{bytes(f.bytes)}</span>
                      {/* Kept in the row at every width, just not as its own
                          column until there is room for one. */}
                      <span className="block md:hidden text-xs text-muted break-all">
                        {f.account ?? 'account unknown'} · imported {when(f.importedAt)}
                      </span>
                    </th>
                    <td className={`py-2 pr-3 text-muted ${AT_MD}`}>{f.account ?? '—'}</td>
                    <td className="py-2 pr-3 num whitespace-nowrap">{period(f)}</td>
                    <td className={`py-2 pr-3 text-muted whitespace-nowrap ${AT_MD}`}>
                      {when(f.importedAt)}
                    </td>
                    <td className="py-2 pr-3 num text-right">{f.rowCount}</td>
                    <td className="py-2 text-right">
                      <ConfirmAction
                        label="Delete"
                        question="Delete this statement and rebuild from the rest?"
                        confirmLabel="Delete"
                        busy={busyId === f.id}
                        busyLabel="Deleting…"
                        onConfirm={() => remove(f.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Discrepancies view={view} />
        </>
      )}
    </Card>
  )
}

/**
 * A ledger that disagrees with IBKR's own position report means a row was
 * dropped or double-counted. It belongs next to the statements, not buried in
 * a holdings screen, because the fix is almost always "import the missing
 * statement".
 */
function Discrepancies({ view }: { view: PortfolioView }) {
  const checks = view.portfolio.discrepancies
  const symbolOf = useSymbolLookup(view)
  if (checks.length === 0) return null
  return (
    <div className="mt-4 rounded-lg border border-serious/40 bg-serious/10 p-3">
      <h3 className="text-sm font-medium flex items-center gap-2">
        <Badge tone="serious">{checks.length}</Badge>
        <span>
          {checks.length === 1
            ? 'share count disagrees with IBKR'
            : 'share counts disagree with IBKR'}
        </span>
      </h3>
      <p className="text-xs text-muted mt-1">
        Portly replays your trades to work out what you hold. For these, the replay does not match
        the position IBKR reported — usually a statement covering the missing trades has not been
        imported.
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {checks.map((c) => (
          <li
            key={`${c.instrumentKey}-${c.asOf}`}
            className="flex flex-wrap items-baseline justify-between gap-x-3"
          >
            <span className="min-w-0 truncate">
              {symbolOf(c.instrumentKey)} <span className="text-muted text-xs">at {c.asOf}</span>
            </span>
            {/* Share counts, not money — no currency belongs on these. */}
            <span className="num text-muted">
              ours {fmtQty(c.ledgerQuantity)} · IBKR {fmtQty(c.snapshotQuantity)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Market data
// ─────────────────────────────────────────────────────────────────────────────

function MarketDataSection({ view }: { view: PortfolioView }) {
  const { state, refresh } = useMarketData()
  const [saveError, setSaveError] = useState<string | null>(null)
  const on = view.settings.enableMarketData
  const symbolOf = useSymbolLookup(view)

  const setEnabled = (next: boolean) => {
    setSaveError(null)
    if (!next) {
      // Cached quotes and dividend profiles outlive the session now that they
      // are in Dexie, so switching market data off would otherwise leave every
      // other screen valued at live prices indefinitely — the opposite of what
      // the copy beside this switch promises. Drop them so "off" really does
      // mean the statement's closing prices.
      clearMarketData().catch((e: Error) => setSaveError(e.message))
    }
    saveSettings({ enableMarketData: next }).catch((e: Error) => setSaveError(e.message))
  }

  const lastRun = state.lastRun ?? view.settings.lastRefresh

  // Until the stored settings have loaded, `view.settings` is the built-in
  // default — showing that as if it were the user's choice would be a lie.
  if (view.loading) {
    return (
      <Card title="Market data">
        <p className="text-sm text-muted">Loading…</p>
      </Card>
    )
  }

  return (
    <Card
      title="Market data"
      subtitle="Optional. Off by choice is a supported way to use Portly."
    >
      <Switch
        id="portly-market-data"
        checked={on}
        onChange={setEnabled}
        label="Fetch live prices and dividend history"
        description="When off, Portly values everything at the closing prices printed in your statements."
      />
      {saveError && <p className="text-sm text-crit mt-2">Could not save: {saveError}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!on || state.running || !view.hasData}
          onClick={() =>
            void refresh({
              instruments: view.instruments,
              overrides: view.overrides,
              transactions: view.transactions,
              snapshots: view.snapshots,
              baseCurrency: view.settings.baseCurrency,
              enabled: on,
            })
          }
          className={`min-h-[44px] px-4 rounded-lg text-sm font-medium bg-accent text-white disabled:opacity-40 ${FOCUS}`}
        >
          {state.running ? 'Refreshing…' : 'Refresh now'}
        </button>
        <span className="text-xs text-muted">
          Last refresh: {lastRun ? when(lastRun) : 'never'}
        </span>
      </div>
      {!on && (
        <p className="text-xs text-muted mt-2">Switch market data on to refresh.</p>
      )}
      {on && !view.hasData && (
        <p className="text-xs text-muted mt-2">Import a statement first — there is nothing to price yet.</p>
      )}

      <div aria-live="polite">
        <RefreshResult state={state} />
      </div>

      <h3 className="text-sm font-medium mt-5">What actually leaves this device</h3>
      <ul className="mt-1.5 space-y-1 text-sm text-muted list-disc pl-5">
        <li>
          A ticker or ISIN goes to <span className="text-ink">stockanalysis.com</span> and{' '}
          <span className="text-ink">extraetf.com</span> to look up a price and a dividend history.
        </li>
        <li>
          A pair of currency codes and a date range go to{' '}
          <span className="text-ink">frankfurter.dev</span> for ECB exchange rates.
        </li>
        <li>
          <span className="text-ink">Never sent:</span> amounts, quantities, cost basis, account
          numbers, your name, or any part of the statement file.
        </li>
      </ul>
      <p className="text-xs text-muted mt-2">
        These are public, keyless endpoints called straight from your browser, so they do see your
        IP address and which tickers you asked about. If that matters to you, leave this off —
        every screen still works.
      </p>

      <Coverage view={view} symbolOf={symbolOf} />
    </Card>
  )
}

function RefreshResult({ state }: { state: RefreshState }) {
  const ran = state.lastRun !== null || state.error !== null || state.quotesFailed > 0 ||
    state.quotesOk > 0
  if (state.running) {
    return <p className="text-sm text-muted mt-3">Fetching rates, prices and dividend history…</p>
  }
  if (!ran) return null

  return (
    <div className="mt-3">
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Prices fetched" value={state.quotesOk} />
        <Stat
          label="Prices failed"
          value={state.quotesFailed}
          tone={state.quotesFailed > 0 ? 'warn' : undefined}
        />
        <Stat label="Dividend profiles" value={state.profilesOk} />
        <Stat label="FX days stored" value={state.fxDays} />
      </dl>

      {state.error && (
        <p className="text-sm text-crit mt-2 flex items-start gap-2">
          <span aria-hidden>×</span>
          <span>
            Refresh failed: {state.error}. Nothing was lost — figures fall back to your statements’
            closing prices.
          </span>
        </p>
      )}

      {state.warnings.length > 0 && (
        <details className="mt-2">
          <summary className="text-sm cursor-pointer min-h-[44px] flex items-center gap-2">
            <Badge tone="warn">{state.warnings.length}</Badge>
            <span>providers could not answer everything</span>
          </summary>
          <ul className="mt-1.5 space-y-1 text-xs text-muted list-disc pl-5">
            {state.warnings.map((w, i) => (
              <li key={`${i}-${w}`}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** What the current data situation actually costs the user, in plain terms. */
function Coverage({
  view,
  symbolOf,
}: {
  view: PortfolioView
  symbolOf: (key: string) => string
}) {
  if (!view.hasData) return null
  const { unpriced, missingFx } = view.portfolio
  const cov = view.forecast.coverage
  const declaredOnly = cov.declaredOnly.length
  const missingForecast = cov.missing.length

  const items: { tone: 'good' | 'warn' | 'serious'; badge: string; text: ReactNode }[] = []

  if (unpriced.length === 0) {
    items.push({ tone: 'good', badge: 'OK', text: 'Every open position has a price.' })
  } else {
    items.push({
      tone: 'warn',
      badge: 'No price',
      text: (
        <>
          {unpriced.length} {unpriced.length === 1 ? 'position has' : 'positions have'} no price at
          all and {unpriced.length === 1 ? 'is' : 'are'} left out of the portfolio value:{' '}
          <span className="text-ink">{unpriced.map(symbolOf).join(', ')}</span>
        </>
      ),
    })
  }

  if (missingFx.length > 0) {
    items.push({
      tone: 'serious',
      badge: 'No rate',
      text: (
        <>
          {missingFx.length} {missingFx.length === 1 ? 'position' : 'positions'} could not be
          converted to {view.settings.baseCurrency} — no exchange rate for the dates involved:{' '}
          <span className="text-ink">{missingFx.map(symbolOf).join(', ')}</span>
        </>
      ),
    })
  }

  // The forecast has its OWN missing-FX set — a dividend paid in a currency the
  // portfolio value never needed converting. Those payments are simply absent
  // from the 12-month total, so it has to be said out loud here too.
  if (cov.missingFx.length > 0) {
    items.push({
      tone: 'serious',
      badge: 'No rate',
      text: (
        <>
          {cov.missingFx.length} forecast{' '}
          {cov.missingFx.length === 1 ? 'position is' : 'positions are'} missing from the
          12-month total — their dividends could not be converted to{' '}
          {view.settings.baseCurrency}:{' '}
          <span className="text-ink">{cov.missingFx.map(symbolOf).join(', ')}</span>
        </>
      ),
    })
  }

  if (cov.staleHistory.length > 0) {
    items.push({
      tone: 'warn',
      badge: 'Stale',
      text: (
        <>
          {cov.staleHistory.length}{' '}
          {cov.staleHistory.length === 1 ? 'position is' : 'positions are'} projected from a
          dividend history more than a year old, so the amounts are a guess rather than a pattern:{' '}
          <span className="text-ink">{cov.staleHistory.map(symbolOf).join(', ')}</span>
        </>
      ),
    })
  }

  if (cov.positions > 0) {
    const full = cov.estimated === cov.positions
    items.push({
      tone: full ? 'good' : 'warn',
      badge: full ? 'OK' : 'Partial',
      text: full ? (
        <>Forecast covers all {cov.positions} positions for a full 12 months.</>
      ) : (
        <>
          Forecast is complete for {cov.estimated} of {cov.positions} positions.
          {declaredOnly > 0 && ` ${declaredOnly} can only be seen about four weeks ahead, through declared accruals.`}
          {missingForecast > 0 && ` ${missingForecast} contribute nothing to the forecast at all.`}
        </>
      ),
    })
  }

  return (
    <div className="mt-5">
      <h3 className="text-sm font-medium">Where you stand right now</h3>
      <ul className="mt-1.5 space-y-1.5 text-sm">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="shrink-0 mt-0.5">
              <Badge tone={it.tone}>{it.badge}</Badge>
            </span>
            <span className="text-muted">{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Settings
// ─────────────────────────────────────────────────────────────────────────────

function SettingsSection({ view }: { view: PortfolioView }) {
  const [error, setError] = useState<string | null>(null)
  const patch = (p: Partial<Settings>) => {
    setError(null)
    saveSettings(p).catch((e: Error) => setError(e.message))
  }

  // Same reason as Market data: never present the defaults as the user's own.
  if (view.loading) {
    return (
      <Card title="Settings">
        <p className="text-sm text-muted">Loading…</p>
      </Card>
    )
  }

  return (
    <Card title="Settings">
      {error && <p className="text-sm text-crit mb-3">Could not save: {error}</p>}

      <div className="space-y-5">
        <BaseCurrencyField
          value={view.settings.baseCurrency}
          onCommit={(c) => patch({ baseCurrency: c })}
        />

        <Choice
          id="portly-cost-basis"
          label="Cost basis method"
          value={view.settings.costBasisMethod}
          options={[
            { value: 'FIFO', label: 'FIFO' },
            { value: 'AVERAGE', label: 'Average' },
          ]}
          onChange={(v) => patch({ costBasisMethod: v })}
          help="Your total gain is identical either way — only the split between realized and unrealized moves. FIFO matches most tax regimes; average is steadier when you buy the same holding often."
        />

        <Choice
          id="portly-dividends"
          label="Dividend figures"
          value={view.settings.showNetDividends ? 'net' : 'gross'}
          options={[
            { value: 'net', label: 'Net' },
            { value: 'gross', label: 'Gross' },
          ]}
          onChange={(v) => patch({ showNetDividends: v === 'net' })}
          help="Net is what actually reached your account, after withholding tax. Gross is what was declared. This applies to income received and to the forward forecast."
        />
      </div>
    </Card>
  )
}

function BaseCurrencyField({
  value,
  onCommit,
}: {
  value: string
  onCommit: (code: string) => void
}) {
  // A select, not a text field. The old free-text input accepted any
  // three-letter string, and anything outside the ECB's list — AED, TWD, CNH —
  // makes every Frankfurter request 404, which silently takes down FX for the
  // whole portfolio. There is no reason to let someone type their way into that.
  const codes = Object.keys(SUPPORTED_CURRENCIES).sort()
  const known = isSupportedCurrency(value)

  return (
    <div>
      <label htmlFor="portly-base-ccy" className="text-sm block">
        Base currency
      </label>
      <p className="text-xs text-muted mt-0.5">
        Every total is converted into this currency at the ECB rate for the date of each event.
      </p>
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <select
          id="portly-base-ccy"
          value={known ? value : ''}
          aria-describedby="portly-base-ccy-hint"
          onChange={(e) => {
            const next = e.target.value
            if (next && next !== value) onCommit(next)
          }}
          className={`min-h-[44px] px-3 pr-8 rounded-lg bg-bg border border-border text-sm ${FOCUS}`}
        >
          {/* Only reachable if a statement or an older build set something the
              ECB does not publish. Shown so the field never lies about the
              value actually in force. */}
          {!known && <option value="">{value || 'Select a currency'}</option>}
          {codes.map((c) => (
            <option key={c} value={c}>
              {c} — {SUPPORTED_CURRENCIES[c]}
            </option>
          ))}
        </select>
      </div>
      <p id="portly-base-ccy-hint" className="text-xs mt-1">
        {known ? (
          <span className="text-muted">
            The {codes.length} currencies the ECB publishes daily rates for. Changing this needs
            exchange rates for the new base — refresh market data afterwards.
          </span>
        ) : (
          <span className="text-crit">
            {value} is not published by the ECB, so no conversion is possible. Pick one of the{' '}
            {codes.length} supported currencies.
          </span>
        )}
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Backup
// ─────────────────────────────────────────────────────────────────────────────

function BackupSection() {
  return (
    <Card
      title="Backup"
      subtitle="A file you keep. There is no copy of your data anywhere else."
    >
      <ExportBlock />
      <hr className="border-border my-5" />
      <RestoreBlock />
    </Card>
  )
}

function ExportBlock() {
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const payload = await exportBackup(pass || undefined)
      const name = `portly-backup-${new Date().toISOString().slice(0, 10)}${
        payload.encrypted ? '-encrypted' : ''
      }.json`
      download(name, JSON.stringify(payload))
      setResult(
        payload.encrypted
          ? `Saved ${name}. It is encrypted — without the passphrase nobody can read it, including you.`
          : `Saved ${name}. It is unencrypted plain text.`,
      )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h3 className="text-sm font-medium">Export</h3>
      <p className="text-xs text-muted mt-0.5">
        Writes every statement and every derived figure to one JSON file.
      </p>

      <div className="mt-3">
        <label htmlFor="portly-export-pass" className="text-sm block">
          Passphrase (optional)
        </label>
        <input
          id="portly-export-pass"
          type="password"
          autoComplete="new-password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder="Leave empty for plain JSON"
          className={`mt-1 w-full sm:w-80 min-h-[44px] px-3 rounded-lg bg-bg border border-border text-sm ${FOCUS}`}
        />
        <p className="text-xs text-muted mt-1">
          Encrypts with AES-256-GCM, key stretched with PBKDF2. There is no recovery: lose the
          passphrase and the file is gone.
        </p>
      </div>

      {!pass && (
        <p className="mt-3 flex items-start gap-2 text-sm">
          <span className="shrink-0">
            <Badge tone="warn">Plain text</Badge>
          </span>
          <span className="text-muted">
            An unencrypted export is a complete record of your account — every trade, dividend,
            balance and account number, readable by anything that can open a text file. Add a
            passphrase before putting it in cloud storage or email.
          </span>
        </p>
      )}

      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className={`mt-3 min-h-[44px] px-4 rounded-lg text-sm font-medium bg-accent text-white disabled:opacity-40 ${FOCUS}`}
      >
        {busy ? 'Preparing…' : 'Export backup'}
      </button>

      <div aria-live="polite">
        {result && (
          <p className="text-sm text-good mt-2 flex items-start gap-2">
            <span aria-hidden>✓</span>
            <span>{result}</span>
          </p>
        )}
        {error && <p className="text-sm text-crit mt-2">Export failed: {error}</p>}
      </div>
    </div>
  )
}

function RestoreBlock() {
  const [file, setFile] = useState<File | null>(null)
  const [pass, setPass] = useState('')
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    setResult(null)
    let payload: BackupPayload
    try {
      // Parsed in its own try: SyntaxError is the one failure we can name
      // precisely, and matching on the message text instead would be
      // browser-dependent — Safari's reads "The string did not match the
      // expected pattern" and never mentions JSON at all.
      payload = JSON.parse(await file.text()) as BackupPayload
    } catch (err) {
      setError(
        err instanceof SyntaxError
          ? 'That file is not a Portly backup — it is not valid JSON.'
          : `Could not read that file: ${(err as Error).message}`,
      )
      setBusy(false)
      return
    }

    // `null` and `[1,2,3]` are both valid JSON, and readBackup would fail on
    // them with a TypeError the user cannot act on.
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      setError('That file is valid JSON, but it is not a Portly backup.')
      setBusy(false)
      return
    }

    try {
      const dump = await readBackup(payload, pass || undefined)
      await restoreBackup(dump, mode)
      setResult(
        `Restored ${countRows(dump).toLocaleString()} rows from ${dump.rawFiles.length} statement${
          dump.rawFiles.length === 1 ? '' : 's'
        } (${mode === 'replace' ? 'replaced everything' : 'merged with what was already here'}).`,
      )
      setPass('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h3 className="text-sm font-medium">Restore</h3>
      <p className="text-xs text-muted mt-0.5">
        Reads a backup file created by Portly, on this or another device.
      </p>

      <div className="mt-3">
        <label htmlFor="portly-restore-file" className="text-sm block">
          Backup file
        </label>
        <input
          id="portly-restore-file"
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setResult(null)
            setError(null)
          }}
          className={`mt-1 block w-full text-sm text-muted file:min-h-[44px] file:mr-3 file:px-4
            file:rounded-lg file:border-0 file:bg-accent file:text-white file:text-sm file:font-medium
            file:cursor-pointer ${FOCUS}`}
        />
      </div>

      <div className="mt-3">
        <label htmlFor="portly-restore-pass" className="text-sm block">
          Passphrase (only if the backup is encrypted)
        </label>
        <input
          id="portly-restore-pass"
          type="password"
          autoComplete="off"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          className={`mt-1 w-full sm:w-80 min-h-[44px] px-3 rounded-lg bg-bg border border-border text-sm ${FOCUS}`}
        />
      </div>

      <div className="mt-4">
        <Choice
          id="portly-restore-mode"
          label="How to apply it"
          value={mode}
          options={[
            { value: 'merge', label: 'Merge' },
            { value: 'replace', label: 'Replace' },
          ]}
          onChange={setMode}
          help={
            mode === 'merge'
              ? 'Keeps what is already here and adds anything missing. Rows are matched by content, so nothing is duplicated.'
              : 'Deletes everything on this device first, then loads the backup. Anything imported since the backup was made is lost.'
          }
        />
      </div>

      <div className="mt-3">
        {mode === 'replace' ? (
          <ConfirmAction
            label="Restore (replace everything)"
            question="This erases the data on this device and replaces it with the backup. Anything imported since that backup was made will be gone."
            confirmLabel="Replace everything"
            disabled={!file || busy}
            busy={busy}
            busyLabel="Restoring…"
            onConfirm={run}
          />
        ) : (
          <button
            type="button"
            onClick={() => void run()}
            disabled={!file || busy}
            className={`min-h-[44px] px-4 rounded-lg text-sm font-medium border border-border disabled:opacity-40 ${FOCUS}`}
          >
            {busy ? 'Restoring…' : 'Restore (merge)'}
          </button>
        )}
      </div>

      <div aria-live="polite">
        {result && (
          <p className="text-sm text-good mt-2 flex items-start gap-2">
            <span aria-hidden>✓</span>
            <span>{result}</span>
          </p>
        )}
        {error && (
          <p className="text-sm text-crit mt-2 flex items-start gap-2">
            <span aria-hidden>×</span>
            <span>{error}</span>
          </p>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Storage
// ─────────────────────────────────────────────────────────────────────────────

function StorageSection({ files, rows }: { files: number; rows: number }) {
  const [est, setEst] = useState<{ usage: number; quota: number } | null | undefined>(undefined)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    storageEstimate()
      .then((e) => {
        if (alive) setEst(e)
      })
      .catch(() => {
        if (alive) setEst(null)
      })
    return () => {
      alive = false
    }
    // Re-measure whenever the stored data changes shape, plus on demand.
  }, [files, rows, tick])

  const pctUsed =
    est && est.quota > 0 ? Math.min(100, (est.usage / est.quota) * 100) : null

  return (
    <Card title="Storage">
      {est === undefined ? (
        <p className="text-sm text-muted">Measuring…</p>
      ) : // storageEstimate() defaults both figures to 0 when the browser answers
      // with nothing, and "0 B used" would be a confident lie about a database
      // that demonstrably has statements in it. All-zero means "not reported".
      est === null || (est.usage === 0 && est.quota === 0) ? (
        <p className="text-sm text-muted">
          This browser does not report how much storage the app is using.
        </p>
      ) : (
        <>
          <p className="text-sm">
            <span className="num">{bytes(est.usage)}</span> used
            {est.quota > 0 && (
              <>
                {' '}
                of about <span className="num">{bytes(est.quota)}</span> available
                {pctUsed !== null && <span className="text-muted"> ({pctUsed.toFixed(1)}%)</span>}
              </>
            )}
          </p>
          {pctUsed !== null && (
            <div
              role="meter"
              aria-valuenow={Math.round(pctUsed)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Storage used"
              className="mt-2 h-2 rounded-full bg-border overflow-hidden"
            >
              <div className="h-full bg-accent" style={{ width: `${Math.max(pctUsed, 0.5)}%` }} />
            </div>
          )}
        </>
      )}

      <button
        type="button"
        onClick={() => setTick((t) => t + 1)}
        className={`mt-3 min-h-[44px] px-3 rounded-lg border border-border text-sm ${FOCUS}`}
      >
        Re-check
      </button>

      <p className="text-xs text-muted mt-3">
        Everything lives in this browser’s IndexedDB. Browsers are allowed to evict it — when the
        device runs low on space, or after a long time away, and Safari is especially eager. Portly
        asks to be treated as persistent, but that request can be refused. An exported backup is
        your only real safety net.
      </p>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Danger zone
// ─────────────────────────────────────────────────────────────────────────────

function DangerSection() {
  const [rebuild, setRebuild] = useState<{ files: number; warnings: string[] } | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildError, setRebuildError] = useState<string | null>(null)
  const [wiping, setWiping] = useState(false)
  const [wiped, setWiped] = useState(false)
  const [wipeError, setWipeError] = useState<string | null>(null)

  const doRebuild = async () => {
    setRebuilding(true)
    setRebuildError(null)
    setRebuild(null)
    try {
      setRebuild(await rederiveAll())
    } catch (err) {
      setRebuildError((err as Error).message)
    } finally {
      setRebuilding(false)
    }
  }

  const doWipe = async () => {
    setWiping(true)
    setWipeError(null)
    try {
      await clearEverything()
      setWiped(true)
    } catch (err) {
      setWipeError((err as Error).message)
    } finally {
      setWiping(false)
    }
  }

  return (
    <Card title="Rebuild and erase" className="border-serious/40">
      <div>
        <h3 className="text-sm font-medium">Rebuild all figures</h3>
        <p className="text-xs text-muted mt-0.5">
          Throws away every derived number and works them out again from the statements you
          imported. Safe: no source data is touched, and it is the right first move if a figure
          looks wrong.
        </p>
        <button
          type="button"
          onClick={() => void doRebuild()}
          disabled={rebuilding}
          className={`mt-2 min-h-[44px] px-4 rounded-lg border border-border text-sm disabled:opacity-40 ${FOCUS}`}
        >
          {rebuilding ? 'Rebuilding…' : 'Rebuild from statements'}
        </button>
        <div aria-live="polite">
          {rebuild && (
            <div className="mt-2">
              <p className="text-sm text-good flex items-start gap-2">
                <span aria-hidden>✓</span>
                <span>
                  Rebuilt from {rebuild.files} {rebuild.files === 1 ? 'statement' : 'statements'}.
                </span>
              </p>
              {rebuild.warnings.length > 0 && (
                <details className="mt-1">
                  <summary className="text-sm cursor-pointer min-h-[44px] flex items-center gap-2">
                    <Badge tone="warn">{rebuild.warnings.length}</Badge>
                    <span>notes from the rebuild</span>
                  </summary>
                  <ul className="mt-1.5 space-y-1 text-xs text-muted list-disc pl-5">
                    {rebuild.warnings.map((w, i) => (
                      <li key={`${i}-${w}`}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {rebuildError && <p className="text-sm text-crit mt-2">Rebuild failed: {rebuildError}</p>}
        </div>
      </div>

      <hr className="border-border my-5" />

      <div>
        <h3 className="text-sm font-medium">Erase everything</h3>
        <p className="text-xs text-muted mt-0.5">
          Deletes every statement, every figure and every setting from this browser. This cannot be
          undone and there is no copy anywhere else — export a backup first.
        </p>
        <div className="mt-2" aria-live="polite">
          {wiped ? (
            <div>
              <p className="text-sm flex items-start gap-2">
                <span aria-hidden>✓</span>
                <span>Everything has been erased.</span>
              </p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className={`mt-2 min-h-[44px] px-4 rounded-lg bg-accent text-white text-sm font-medium ${FOCUS}`}
              >
                Reload Portly
              </button>
              <p className="text-xs text-muted mt-1">
                Reload to clear the figures still held in memory on the other tabs.
              </p>
            </div>
          ) : (
            <ConfirmAction
              label="Erase everything"
              question="Delete every statement, figure and setting from this browser? This cannot be undone."
              confirmLabel="Erase everything"
              busy={wiping}
              busyLabel="Erasing…"
              onConfirm={doWipe}
            />
          )}
          {wipeError && <p className="text-sm text-crit mt-2">Erase failed: {wipeError}</p>}
        </div>
      </div>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Local controls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two-step confirmation, inline.
 *
 * Deliberately not window.confirm: a modal dialog freezes the whole page,
 * cannot be styled, reads badly on a phone and hides the very list the user is
 * confirming against. Arming instead swaps this control for the question plus
 * a pair of buttons in the same spot.
 */
function ConfirmAction({
  label,
  question,
  confirmLabel,
  onConfirm,
  disabled = false,
  busy = false,
  busyLabel = 'Working…',
}: {
  label: string
  question: string
  confirmLabel: string
  onConfirm: () => void | Promise<void>
  disabled?: boolean
  busy?: boolean
  busyLabel?: string
}) {
  const [armed, setArmed] = useState(false)

  if (busy) {
    return <span className="text-sm text-muted inline-flex items-center min-h-[44px]">{busyLabel}</span>
  }

  if (!armed) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setArmed(true)}
        className={`min-h-[44px] px-3 rounded-lg border border-serious/50 text-serious text-sm disabled:opacity-40 ${FOCUS}`}
      >
        {label}
      </button>
    )
  }

  return (
    <div role="group" aria-label={label} className="text-left">
      <p className="text-sm text-ink">{question}</p>
      <div className="flex flex-wrap gap-2 mt-2">
        <button
          type="button"
          onClick={() => {
            setArmed(false)
            void onConfirm()
          }}
          className={`min-h-[44px] px-3 rounded-lg bg-crit text-white text-sm font-medium ${FOCUS}`}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          className={`min-h-[44px] px-3 rounded-lg border border-border text-sm ${FOCUS}`}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * On/off switch. Local rather than the kit's `Toggle` for one reason: this is
 * a binary state, not a choice between two named things, and it needs a 44px
 * touch target. The state is always spelled out in words next to the track —
 * the colour is decoration.
 */
function Switch({
  id,
  checked,
  onChange,
  label,
  description,
}: {
  id: string
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  description?: string
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor={id} id={`${id}-label`} className="text-sm">
          {label}
        </label>
        {description && (
          <p id={`${id}-desc`} className="text-xs text-muted mt-0.5">
            {description}
          </p>
        )}
      </div>
      {/* role="switch" takes its name from the author, not from its contents,
          so the visible "On"/"Off" text inside the button is NOT a name —
          without aria-labelledby this reads out as just "On, switch, on". */}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        onClick={() => onChange(!checked)}
        className={`shrink-0 min-h-[44px] px-2 inline-flex items-center gap-2 rounded-lg border border-border ${FOCUS}`}
      >
        <span
          aria-hidden
          className={`relative block w-9 h-5 rounded-full transition-colors ${
            checked ? 'bg-accent' : 'bg-border'
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-ink transition-all ${
              checked ? 'left-[1.125rem]' : 'left-0.5'
            }`}
          />
        </span>
        <span className="text-xs w-6 text-left">{checked ? 'On' : 'Off'}</span>
      </button>
    </div>
  )
}

/** Segmented choice, sized for a thumb. Mirrors the kit's Toggle visually. */
function Choice<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  help,
}: {
  id: string
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
  help?: string
}) {
  return (
    <div>
      <span id={`${id}-label`} className="text-sm block">
        {label}
      </span>
      <div
        role="group"
        aria-labelledby={`${id}-label`}
        className="inline-flex mt-2 rounded-lg border border-border overflow-hidden"
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
            className={`min-h-[44px] px-4 text-sm ${FOCUS} ${
              o.value === value ? 'bg-accent text-white' : 'text-muted hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {help && <p className="text-xs text-muted mt-1.5">{help}</p>}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'warn'
}) {
  return (
    <div className="rounded-lg border border-border p-2.5 min-w-0">
      <dt className="text-xs text-muted truncate">{label}</dt>
      <dd className={`num text-lg font-semibold ${tone === 'warn' ? 'text-warn' : ''}`}>{value}</dd>
    </div>
  )
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

function useSymbolLookup(view: PortfolioView): (key: string) => string {
  const map = useMemo(
    () => new Map(view.instruments.map((i) => [i.key, i.symbol])),
    [view.instruments],
  )
  // Fall back to the key: an unresolvable key is still more useful than blank.
  return (key: string) => map.get(key) ?? key
}

const ENTITY_LABEL: Record<string, string> = {
  instruments: 'Instruments',
  transactions: 'Trades',
  distributions: 'Dividends paid',
  accruals: 'Dividend accruals',
  cashEvents: 'Cash movements',
  positions: 'Position snapshots',
}

const label = (key: string): string => ENTITY_LABEL[key] ?? key

/**
 * A count the importer actually reported, or an em dash.
 *
 * `??  0` would be a lie here: the importer does not track an "already had"
 * figure for position snapshots at all, and printing 0 would claim it had
 * checked and found none.
 */
function count(record: Record<string, number>, key: string): ReactNode {
  const n = record[key]
  if (n == null || !Number.isFinite(n)) {
    return (
      <>
        <span aria-hidden>—</span>
        <span className="sr-only">not tracked</span>
      </>
    )
  }
  return n.toLocaleString()
}

function bytes(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function when(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** ISO dates, not localised: a statement period must be unambiguous. */
function period(f: RawFile): string {
  if (!f.periodStart && !f.periodEnd) return '—'
  return `${f.periodStart ?? '?'} → ${f.periodEnd ?? '?'}`
}

function fmtQty(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'
}

function countRows(dump: TableDump): number {
  return Object.values(dump).reduce((t, rows) => t + (Array.isArray(rows) ? rows.length : 0), 0)
}

/**
 * Save a string to disk. The object URL is revoked on the next task rather
 * than immediately: the click has only queued the download at that point, and
 * revoking synchronously cancels it in some browsers. Not revoking at all
 * would pin the whole backup in memory until the tab closes.
 */
function download(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
