import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { usePortfolio } from '../usePortfolio'
import type { Holding } from '../../metrics/holdings'
import { pct, sumDefined } from '../../metrics/money'
import type { Currency, ISODate, Provenance, Quote } from '../../domain/types'
import {
  Badge,
  Card,
  EmptyState,
  Money,
  Pct,
  StatTile,
  Staleness,
  formatMoney,
  formatPct,
} from '../components/primitives'

/**
 * Positions.
 *
 * Every figure comes from `usePortfolio()`; nothing here recomputes a metric.
 * The two derived quantities in this file are presentation-only ratios of
 * numbers the view already produced (a row's P/L over its own cost, and the
 * footer's sum of the rows currently on screen), and both go through the same
 * `pct` / `sumDefined` helpers the metrics layer uses so they cannot drift.
 *
 * Three things drive the layout:
 *   - Base and native currency are different things. Value, cost and P/L are
 *     shown in base because those are the only columns that legitimately add
 *     up; price and average cost stay in the position's own currency, which is
 *     printed on every row so nothing implies one currency throughout.
 *   - A missing number is never a zero. Unpriced positions render "—" and say
 *     why; a position with no dividend history has an unknown forward yield,
 *     not a yield of nought.
 *   - Below `sm` this is a list of cards, not a squeezed table. Eleven columns
 *     cannot be honest at 360px and a horizontal scrollbar just hides them.
 */

type SortKey = 'value' | 'weight' | 'pnl' | 'pnlPct' | 'symbol' | 'yield'

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'value', label: 'Market value' },
  { value: 'weight', label: 'Weight' },
  { value: 'pnl', label: 'Unrealised P/L' },
  { value: 'pnlPct', label: 'Unrealised P/L %' },
  { value: 'symbol', label: 'Symbol' },
  { value: 'yield', label: 'Forward yield' },
]

/** A holding plus everything the table needs, resolved once per render. */
interface Row {
  h: Holding
  /** Unrealised P/L over this position's own cost basis, both in base. */
  pnlPct: number | null
  yieldPct: number | null
  incomeBase: number | null
  yieldOnCostPct: number | null
  /** Forward income is visible only through an accrual: ~4 weeks, understated. */
  declaredOnly: boolean
  /** No provider history and no accrual — forward income is unknown, not zero. */
  noDividendData: boolean
  /**
   * At least one projected payment could not be converted to base. `forecast`
   * folds those legs in as 0, so the position's forward figures would be a
   * confident understatement — report them as unknown instead.
   */
  incomeFxUnknown: boolean
  staleHistory: boolean
  discrepancy: boolean
  missingFx: boolean
  unpriced: boolean
  provenance: Provenance | null
  firstBuy: ISODate | null
  /** Tickers this instrument has also been reported under. */
  otherAliases: string[]
}

export function Holdings() {
  const view = usePortfolio()
  const { portfolio, forecast, yields, settings } = view
  const base = settings.baseCurrency

  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('value')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [showClosed, setShowClosed] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  const rows = useMemo<Row[]>(() => {
    const quoteByKey = new Map(view.quotes.map((q) => [q.instrumentKey, q]))
    const yieldByKey = new Map(yields.byInstrument.map((y) => [y.instrumentKey, y]))
    const unpriced = new Set(portfolio.unpriced)
    const missingFx = new Set(portfolio.missingFx)
    const discrepancies = new Set(portfolio.discrepancies.map((d) => d.instrumentKey))
    const noData = new Set(forecast.coverage.missing)
    const declared = new Set(forecast.coverage.declaredOnly)
    const stale = new Set(forecast.coverage.staleHistory)
    const incomeFx = new Set(forecast.coverage.missingFx)

    return portfolio.holdings.map((h) => {
      const y = yieldByKey.get(h.instrumentKey) ?? null
      const blind = noData.has(h.instrumentKey)
      const fxBlind = incomeFx.has(h.instrumentKey)
      // An instrument the forecast could not see at all pays "unknown", and
      // PositionYield reports that as a hard 0 — suppress it here. Same for a
      // position whose projected payments could not be converted: `forecast`
      // adds those legs as 0, which is an understatement, not a measurement.
      const incomeKnown = y !== null && !blind && !fxBlind
      return {
        h,
        pnlPct:
          h.unrealizedPnlBase === null || h.costBasisBase === null
            ? null
            : pct(h.unrealizedPnlBase, h.costBasisBase),
        yieldPct: incomeKnown ? y.forwardYieldPct : null,
        incomeBase: incomeKnown ? y.forwardIncomeBase : null,
        yieldOnCostPct: incomeKnown ? y.yieldOnCostPct : null,
        declaredOnly: declared.has(h.instrumentKey),
        noDividendData: blind,
        incomeFxUnknown: fxBlind,
        staleHistory: stale.has(h.instrumentKey),
        discrepancy: discrepancies.has(h.instrumentKey),
        missingFx: missingFx.has(h.instrumentKey),
        unpriced: unpriced.has(h.instrumentKey),
        provenance: priceProvenance(h, quoteByKey.get(h.instrumentKey) ?? null),
        firstBuy: firstPurchase(h),
        otherAliases: (h.instrument?.aliases ?? []).filter((a) => a !== h.symbol),
      }
    })
  }, [portfolio, forecast, yields, view.quotes])

  const closedCount = rows.filter((r) => r.h.closed).length

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const kept = rows.filter((r) => (showClosed || !r.h.closed) && matches(r, q))
    const factor = dir === 'desc' ? -1 : 1
    return [...kept].sort((a, b) => compare(a, b, sort, factor))
  }, [rows, query, showClosed, sort, dir])

  const totals = useMemo(() => {
    // Excluded positions are outside every portfolio total by definition, so
    // the footer must drop them too or it stops matching the tiles.
    const counted = visible.filter((r) => !r.h.excluded)
    const value = totalOrNull(counted.map((r) => r.h.marketValueBase))
    const cost = totalOrNull(counted.map((r) => r.h.costBasisBase))
    const pnl = totalOrNull(counted.map((r) => r.h.unrealizedPnlBase))
    return {
      value,
      cost,
      pnl,
      pnlPct: pnl === null || cost === null ? null : pct(pnl, cost),
      realized: totalOrNull(counted.map((r) => r.h.realizedPnlBase)),
      weight: totalOrNull(counted.map((r) => r.h.weightPct)),
      /** Rows actually inside the sums — the label must not claim the others. */
      counted: counted.length,
      excluded: visible.length - counted.length,
      // `sumDefined` skips nulls; say how many, or the total looks complete.
      // The two causes need separate counts because they are fixed on
      // different screens — a price on this tab, an FX rate on Data.
      noPrice: counted.filter(
        (r) => r.h.marketValueBase === null && r.h.marketValue === null,
      ).length,
      noValueFx: counted.filter(
        (r) => r.h.marketValueBase === null && r.h.marketValue !== null,
      ).length,
    }
  }, [visible])

  // Realised P/L lives on for a position that no longer exists, so hiding sold
  // rows quietly removes money from the footer. Say how much.
  const hiddenSold = useMemo(() => {
    if (showClosed) return { count: 0, realized: 0 }
    const gone = rows.filter((r) => r.h.closed && !r.h.excluded && matches(r, query.trim().toLowerCase()))
    return { count: gone.length, realized: sumDefined(gone.map((r) => r.h.realizedPnlBase)) }
  }, [rows, showClosed, query])

  if (view.loading) {
    return (
      <div aria-busy="true" className="text-sm text-muted py-12 text-center">
        Loading positions…
      </div>
    )
  }

  if (!view.hasData) {
    return (
      <EmptyState
        title="No positions yet"
        action={
          <a
            href="#/data"
            className="inline-flex items-center justify-center h-11 px-4 rounded-lg bg-accent text-white text-sm"
          >
            Go to Data
          </a>
        }
      >
        Import an Interactive Brokers Activity Statement on the Data tab and every position,
        lot and dividend in it shows up here.
      </EmptyState>
    )
  }

  if (portfolio.holdings.length === 0) {
    return (
      <EmptyState title="No positions in these statements">
        The imported statements contain no trades or open positions. A cash-only statement is
        a valid import — add one that covers your trading history to populate this tab.
      </EmptyState>
    )
  }

  const open = portfolio.holdings.filter((h) => !h.excluded && !h.closed)
  const openCount = open.length
  const excludedCount = rows.filter((r) => r.h.excluded).length
  // An all-unpriced (or all-unconvertible) book totals zero through
  // `sumDefined`. That is an absence of prices, not an empty account — and
  // Overview already refuses to print it, so printing it here would put two
  // screens in open disagreement. A genuinely sold-out account has no open
  // positions at all, and zero is then the truth.
  const valueKnown = openCount === 0 || open.some((h) => h.marketValueBase !== null)
  const costKnown = openCount === 0 || open.some((h) => h.costBasisBase !== null)
  const pnlKnown = openCount === 0 || open.some((h) => h.unrealizedPnlBase !== null)
  // Market value needs one FX rate on the valuation date; cost basis needs one
  // per acquisition date. Offline the first is available and the second is not,
  // so these two totals routinely cover different numbers of positions. Say so
  // on the tile — an unlabelled subtotal beside a full-portfolio value reads as
  // a portfolio-wide figure.
  const cov = portfolio.costBasisCoverage
  const partial = cov.covered < cov.total
  const coverageHint = partial ? ` · ${cov.covered} of ${cov.total} positions` : ''
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  return (
    <div className="space-y-4">
      {/* Every other tab opens with one, so the document outline stays h1 → h2
          → h3 as the user moves between them. */}
      <h1 className="sr-only">Holdings</h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Holdings"
          value={String(openCount)}
          hint={countHint(closedCount, portfolio.unpriced.length, excludedCount)}
        />
        <StatTile
          label={`Market value (${base})`}
          value={
            <Money
              value={valueKnown ? portfolio.marketValueBase : null}
              currency={base}
              dp={0}
            />
          }
          // Not "as of": prices can be live quotes from a minute ago. `asOf` is
          // the date the FX conversion (and any statement close price) uses.
          hint={`FX as of ${portfolio.asOf}`}
        />
        <StatTile
          label={`Cost basis (${base})`}
          value={
            <Money value={costKnown ? portfolio.costBasisBase : null} currency={base} dp={0} />
          }
          hint={`${portfolio.method} · shares still held${coverageHint}`}
        />
        <StatTile
          label={`Unrealised P/L (${base})`}
          value={
            <Money
              value={pnlKnown ? portfolio.unrealizedPnlBase : null}
              currency={base}
              dp={0}
              signed
              colored
            />
          }
          hint={`${formatPct(
            pnlKnown && costKnown
              ? pct(portfolio.unrealizedPnlBase, portfolio.costBasisBase)
              : null,
          )} on cost${coverageHint}`}
        />
      </div>

      <Card
        title="Positions"
        subtitle={`Value, cost and P/L in ${base}. Price and average cost in the position's own currency.`}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search symbol or name"
            aria-label="Search holdings by symbol, name, ISIN or a previous ticker"
            className="h-11 sm:w-56 min-w-0 rounded-lg bg-bg border border-border px-3 text-sm placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="holdings-sort" className="sr-only">
              Sort by
            </label>
            <select
              id="holdings-sort"
              value={sort}
              onChange={(e) => {
                const next = e.target.value as SortKey
                setSort(next)
                // Each measure has an obvious first look: biggest money first,
                // but names read A–Z. Flipping to match saves a second tap.
                setDir(next === 'symbol' ? 'asc' : 'desc')
              }}
              className="h-11 rounded-lg bg-bg border border-border px-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
              className="h-11 px-3 rounded-lg border border-border text-xs text-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span aria-hidden>{dir === 'desc' ? '↓' : '↑'}</span>{' '}
              {directionLabel(sort, dir)}
            </button>
            {/* Only meaningful once something has actually been sold. */}
            {closedCount > 0 && (
              <label className="inline-flex items-center gap-2 h-11 px-3 rounded-lg border border-border text-xs text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={showClosed}
                  onChange={(e) => setShowClosed(e.target.checked)}
                  className="w-4 h-4 accent-accent"
                />
                Show sold ({closedCount})
              </label>
            )}
          </div>
        </div>

        {forecast.coverage.positions > 0 &&
          (forecast.coverage.ratio < 1 || forecast.coverage.missingFx.length > 0) && (
          <p className="text-xs text-muted mb-3">
            Forward yield is estimated for {forecast.coverage.estimated} of{' '}
            {forecast.coverage.positions} positions
            {forecast.coverage.declaredOnly.length > 0 &&
              `, declared accruals only for ${forecast.coverage.declaredOnly.length}`}
            {forecast.coverage.missing.length > 0 &&
              `, unknown for ${forecast.coverage.missing.length}`}
            {forecast.coverage.missingFx.length > 0 &&
              `, not convertible to ${base} for ${forecast.coverage.missingFx.length}`}
            .
          </p>
        )}

        {visible.length === 0 ? (
          <div className="py-8 text-center">
            {query.trim() === '' ? (
              // Not a search miss: every position in the ledger is closed.
              <p className="text-sm text-muted">
                Every position has been sold. Tick “Show sold” to see them and their realised
                P/L.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted">
                  No open holdings match “{query.trim()}”.
                  {hiddenSold.count > 0 &&
                    ` ${hiddenSold.count} sold position${hiddenSold.count === 1 ? '' : 's'} match — tick “Show sold” to see ${hiddenSold.count === 1 ? 'it' : 'them'}.`}
                </p>
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="mt-3 h-11 px-4 rounded-lg border border-border text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Clear search
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            <HoldingCards
              rows={visible}
              base={base}
              expanded={expanded}
              onToggle={toggle}
              totals={totals}
            />
            <HoldingsTable
              rows={visible}
              base={base}
              expanded={expanded}
              onToggle={toggle}
              totals={totals}
            />
            <Footnotes
              base={base}
              rows={visible}
              totals={totals}
              hiddenSold={hiddenSold}
            />
          </>
        )}
      </Card>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Table (sm and up)
// ─────────────────────────────────────────────────────────────────────────────

interface Totals {
  /** Null, not zero, when not one row in the column could be converted. */
  value: number | null
  cost: number | null
  pnl: number | null
  pnlPct: number | null
  realized: number | null
  weight: number | null
  counted: number
  excluded: number
  noPrice: number
  noValueFx: number
}

interface ListProps {
  rows: Row[]
  base: Currency
  expanded: ReadonlySet<string>
  onToggle: (key: string) => void
  totals: Totals
}

/** Columns appear as the viewport earns them; the rest live in the detail panel. */
const AT_MD = 'hidden md:table-cell'
const AT_LG = 'hidden lg:table-cell'
const NUM = 'px-2 py-2 text-right align-middle whitespace-nowrap'

function HoldingsTable({ rows, base, expanded, onToggle, totals }: ListProps) {
  return (
    // Below `sm` the cards take over, so this never scrolls on a phone. The
    // guard is for the narrow window between `lg` (all eleven columns) and the
    // width they actually need — better a scoped scrollbar than the whole page
    // sliding sideways.
    <div className="hidden sm:block overflow-x-auto">
      <table className="w-full text-xs lg:text-sm border-collapse">
        <caption className="sr-only">
          Portfolio positions with quantity, price, market value, cost basis, unrealised and
          realised profit and loss, weight and forward yield. Expand a row for identity,
          lots and price provenance.
        </caption>
        <thead>
          <tr className="text-muted border-b border-border">
            <th scope="col" className="px-2 py-2 text-left font-medium">
              Symbol
            </th>
            <th scope="col" className={`${NUM} font-medium`}>
              Qty
            </th>
            <th scope="col" className={`${AT_LG} ${NUM} font-medium`}>
              Avg cost
            </th>
            <th scope="col" className={`${NUM} font-medium`}>
              Price
            </th>
            <th scope="col" className={`${NUM} font-medium`}>
              Value ({base})
            </th>
            <th scope="col" className={`${AT_LG} ${NUM} font-medium`}>
              Cost ({base})
            </th>
            <th scope="col" className={`${NUM} font-medium`}>
              Unreal. P/L
            </th>
            <th scope="col" className={`${AT_MD} ${NUM} font-medium`}>
              P/L %
            </th>
            <th scope="col" className={`${NUM} font-medium`}>
              Weight
            </th>
            <th scope="col" className={`${AT_LG} ${NUM} font-medium`}>
              Realised
            </th>
            <th scope="col" className={`${AT_MD} ${NUM} font-medium`}>
              Fwd yield
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const open = expanded.has(r.h.instrumentKey)
            const detailId = `holding-detail-table-${r.h.instrumentKey}`
            return (
              <TableRow
                key={r.h.instrumentKey}
                row={r}
                base={base}
                open={open}
                detailId={detailId}
                onToggle={onToggle}
              />
            )
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-border font-semibold">
            <th scope="row" className="px-2 py-2 text-left">
              Total
              <span className="block text-[11px] font-normal text-muted">
                {countedLabel(totals)}
              </span>
            </th>
            <td className={NUM} />
            <td className={`${AT_LG} ${NUM}`} />
            <td className={NUM} />
            <td className={NUM}>
              <Money value={totals.value} currency={base} />
            </td>
            <td className={`${AT_LG} ${NUM}`}>
              <Money value={totals.cost} currency={base} />
            </td>
            <td className={NUM}>
              <Money value={totals.pnl} currency={base} signed colored />
            </td>
            <td className={`${AT_MD} ${NUM}`}>
              <Pct value={totals.pnlPct} />
            </td>
            <td className={`${NUM} num`}>{formatPct(totals.weight, 1, false)}</td>
            <td className={`${AT_LG} ${NUM}`}>
              <Money value={totals.realized} currency={base} signed colored />
            </td>
            <td className={`${AT_MD} ${NUM}`} />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function TableRow({
  row,
  base,
  open,
  detailId,
  onToggle,
}: {
  row: Row
  base: Currency
  open: boolean
  detailId: string
  onToggle: (key: string) => void
}) {
  const { h } = row
  return (
    <>
      <tr className="border-b border-border/60 align-middle">
        <th scope="row" className="px-0 py-0 text-left font-normal max-w-[220px]">
          <button
            type="button"
            onClick={() => onToggle(h.instrumentKey)}
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            className="w-full min-h-[44px] px-2 py-2 flex items-start gap-2 text-left hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
          >
            <Chevron open={open} />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 flex-wrap">
                <span className="font-semibold">{h.symbol}</span>
                <span className="text-[11px] text-muted">{h.currency}</span>
                <RowBadges row={row} />
              </span>
              <span className="block text-[11px] text-muted truncate">{h.name}</span>
              {row.otherAliases.length > 0 && (
                <span className="block text-[11px] text-muted truncate">
                  also {row.otherAliases.join(', ')}
                </span>
              )}
            </span>
          </button>
        </th>
        <td className={`${NUM} num`}>{formatQty(h.quantity)}</td>
        <td className={`${AT_LG} ${NUM}`}>
          <Money value={h.avgUnitCost} currency={h.currency} dp={unitDp(h.avgUnitCost)} />
        </td>
        <td className={NUM}>
          <Money value={h.price} currency={h.priceCurrency ?? h.currency} dp={unitDp(h.price)} />
        </td>
        <td className={NUM}>
          <Money value={h.marketValueBase} currency={base} />
        </td>
        <td className={`${AT_LG} ${NUM}`}>
          <Money value={h.costBasisBase} currency={base} />
        </td>
        <td className={NUM}>
          <Money value={h.unrealizedPnlBase} currency={base} signed colored />
        </td>
        <td className={`${AT_MD} ${NUM}`}>
          <Pct value={row.pnlPct} />
        </td>
        <td className={`${NUM} num`}>{formatPct(h.weightPct, 1, false)}</td>
        <td className={`${AT_LG} ${NUM}`}>
          <Money value={h.realizedPnlBase} currency={base} signed colored />
        </td>
        <td className={`${AT_MD} ${NUM} num`}>
          {formatPct(row.yieldPct, 2, false)}
          {row.declaredOnly && row.yieldPct !== null && <span aria-hidden> †</span>}
        </td>
      </tr>
      {open && (
        <tr id={detailId} className="border-b border-border/60 bg-bg/60">
          <td colSpan={11} className="px-2 py-3">
            <HoldingDetail row={row} base={base} />
          </td>
        </tr>
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Cards (below sm)
// ─────────────────────────────────────────────────────────────────────────────

function HoldingCards({ rows, base, expanded, onToggle, totals }: ListProps) {
  return (
    <div className="sm:hidden">
      <ul className="space-y-2">
        {rows.map((r) => (
          <HoldingCard
            key={r.h.instrumentKey}
            row={r}
            base={base}
            open={expanded.has(r.h.instrumentKey)}
            onToggle={onToggle}
          />
        ))}
      </ul>
      <div className="mt-3 pt-3 border-t border-border">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-xs text-muted min-w-0">Total · {countedLabel(totals)}</span>
          <Money value={totals.value} currency={base} className="font-semibold" />
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <Field label={`Cost (${base})`}>
            <Money value={totals.cost} currency={base} />
          </Field>
          <Field label="Weight">
            <span className="num">{formatPct(totals.weight, 1, false)}</span>
          </Field>
          <Field label={`Unrealised P/L (${base})`}>
            <Money value={totals.pnl} currency={base} signed colored />
          </Field>
          <Field label={`Realised P/L (${base})`}>
            <Money value={totals.realized} currency={base} signed colored />
          </Field>
        </dl>
      </div>
    </div>
  )
}

function HoldingCard({
  row,
  base,
  open,
  onToggle,
}: {
  row: Row
  base: Currency
  open: boolean
  onToggle: (key: string) => void
}) {
  const { h } = row
  const detailId = `holding-detail-card-${h.instrumentKey}`
  return (
    <li className="border border-border rounded-xl">
      <button
        type="button"
        onClick={() => onToggle(h.instrumentKey)}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        className="w-full min-h-[44px] p-3 flex items-start justify-between gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-xl"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 flex-wrap">
            <Chevron open={open} />
            <span className="font-semibold text-sm">{h.symbol}</span>
            <span className="text-[11px] text-muted">{h.currency}</span>
          </span>
          <span className="block text-xs text-muted truncate mt-0.5">{h.name}</span>
          {row.otherAliases.length > 0 && (
            <span className="block text-[11px] text-muted truncate">
              also {row.otherAliases.join(', ')}
            </span>
          )}
        </span>
        <span className="text-right shrink-0">
          <Money value={h.marketValueBase} currency={base} className="text-sm font-semibold" />
          <span className="block text-xs">
            <Money value={h.unrealizedPnlBase} currency={base} signed colored />
          </span>
        </span>
      </button>

      <div className="px-3 pb-3">
        <div className="flex flex-wrap gap-1 mb-2 empty:mb-0">
          <RowBadges row={row} />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <Field label="Quantity">
            <span className="num">{formatQty(h.quantity)}</span>
          </Field>
          <Field label="Weight">
            <span className="num">{formatPct(h.weightPct, 1, false)}</span>
          </Field>
          <Field label={`Price (${h.priceCurrency ?? h.currency})`}>
            <Money value={h.price} currency={h.priceCurrency ?? h.currency} dp={unitDp(h.price)} />
          </Field>
          <Field label={`Avg cost (${h.currency})`}>
            <Money value={h.avgUnitCost} currency={h.currency} dp={unitDp(h.avgUnitCost)} />
          </Field>
          <Field label={`Cost basis (${base})`}>
            <Money value={h.costBasisBase} currency={base} />
          </Field>
          <Field label="P/L %">
            <Pct value={row.pnlPct} />
          </Field>
          <Field label={`Realised P/L (${base})`}>
            <Money value={h.realizedPnlBase} currency={base} signed colored />
          </Field>
          <Field label="Forward yield">
            <span className="num">
              {formatPct(row.yieldPct, 2, false)}
              {row.declaredOnly && row.yieldPct !== null && <span aria-hidden> †</span>}
            </span>
          </Field>
        </dl>
        {open && (
          <div id={detailId} className="mt-3 pt-3 border-t border-border">
            <HoldingDetail row={row} base={base} />
          </div>
        )}
      </div>
    </li>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared pieces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-row warning set. Every badge carries text, never a bare colour, and
 * each one is explained in full in the detail panel below it.
 */
function RowBadges({ row }: { row: Row }) {
  const { h } = row
  return (
    <>
      {h.closed && <Badge tone="muted">sold</Badge>}
      {h.excluded && <Badge tone="muted">excluded</Badge>}
      {row.unpriced && <Badge tone="muted">no price</Badge>}
      {row.discrepancy && <Badge tone="warn">qty check</Badge>}
      {h.uncoveredShares > 0 && <Badge tone="warn">partial cost</Badge>}
      {row.missingFx && <Badge tone="warn">no FX rate</Badge>}
    </>
  )
}

function HoldingDetail({ row, base }: { row: Row; base: Currency }) {
  const { h } = row
  const inst = h.instrument
  const priceCcy = h.priceCurrency ?? h.currency
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">
        {h.symbol} detail
      </h3>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-4 text-xs">
        <Field label="ISIN">
          <span className="num">{inst?.isin ?? '—'}</span>
        </Field>
        <Field label="Conid">
          <span className="num">{inst?.conid ?? '—'}</span>
        </Field>
        <Field label="Exchange">{inst?.listingExchange ?? '—'}</Field>
        <Field label="Identity from">{inst?.identitySource ?? '—'}</Field>
        <Field label="Currency">
          {h.currency}
          {priceCcy !== h.currency && ` · priced in ${priceCcy}`}
        </Field>
        <Field label="Asset class">
          {h.assetCategory}
          {inst?.type ? ` · ${inst.type}` : ''}
        </Field>
        <Field label="Cost basis method">{h.method}</Field>
        <Field label="Open lots">
          <span className="num">{h.lots.length}</span>
          {h.reopens > 0 && (
            <span className="text-muted"> · reopened {h.reopens}×</span>
          )}
        </Field>
        <Field label="First purchase">
          {row.firstBuy ? <time dateTime={row.firstBuy}>{row.firstBuy}</time> : '—'}
        </Field>
        <Field label="Quantity source">
          {h.quantitySource === 'ledger' ? 'trade ledger' : 'broker snapshot'}
        </Field>
        <Field label={`Realised P/L (${base})`}>
          <Money value={h.realizedPnlBase} currency={base} signed colored />
        </Field>
        {/* The native leg only earns a slot when it is a different number from
            the base one — otherwise it is the same figure printed twice. */}
        {h.currency !== base && (
          <>
            <Field label={`Cost basis (${h.currency})`}>
              <Money value={h.costBasis} currency={h.currency} />
            </Field>
            <Field label={`Unrealised P/L (${h.currency})`}>
              <Money value={h.unrealizedPnl} currency={h.currency} signed colored />
            </Field>
            <Field label={`Realised P/L (${h.currency})`}>
              <Money value={h.realizedPnl} currency={h.currency} signed colored />
            </Field>
          </>
        )}
        {priceCcy !== base && (
          <Field label={`Market value (${priceCcy})`}>
            <Money value={h.marketValue} currency={priceCcy} />
          </Field>
        )}
        <Field label={`Forward income (${base}, 12m)`}>
          <Money value={row.incomeBase} currency={base} />
        </Field>
        <Field label="Yield on cost">
          <span className="num">{formatPct(row.yieldOnCostPct, 2, false)}</span>
        </Field>
        <Field label="Price provenance">
          {row.provenance ? (
            <Staleness provenance={row.provenance} />
          ) : h.priceAsOf ? (
            // Priced, but the provider that supplied it is no longer in the
            // session cache. Show the timestamp rather than claim "no price".
            <span className="text-muted text-[11px]">as of {h.priceAsOf}</span>
          ) : (
            <span className="text-muted text-[11px]">no price</span>
          )}
        </Field>
      </dl>

      {/* Aliases are the whole story behind a renamed ticker: one instrument,
          two symbols across statements, one conid. Show every one. */}
      <div className="text-xs">
        <span className="text-muted">Known tickers: </span>
        {(inst?.aliases ?? [h.symbol]).map((a) => (
          <span
            key={a}
            className="inline-block num border border-border rounded px-1.5 py-0.5 mr-1 mb-1"
          >
            {a}
          </span>
        ))}
        {row.otherAliases.length > 0 && (
          <p className="text-muted mt-1 leading-relaxed">
            Same instrument under more than one ticker — the broker renamed it. Statements from
            before and after the rename are merged on{' '}
            {inst?.identitySource === 'conid' ? 'its conid' : `its ${inst?.identitySource ?? 'symbol'}`}
            , so this one row covers the whole history under either ticker.
          </p>
        )}
      </div>

      {row.discrepancy && h.check && (
        <Note tone="warn" title="Ledger and broker disagree">
          On {h.check.asOf} the replayed ledger holds{' '}
          <span className="num">{formatQty(h.check.ledgerQuantity)}</span> but IBKR reported{' '}
          <span className="num">{formatQty(h.check.snapshotQuantity)}</span> (difference{' '}
          <span className="num">{formatQty(h.check.difference)}</span>). A trade row is missing
          or counted twice, so cost basis and P/L for this position are suspect. Re-import the
          statements that cover this period.
        </Note>
      )}

      {h.uncoveredShares > 0 && (
        <Note tone="warn" title="Cost basis is partial">
          <span className="num">{formatQty(h.uncoveredShares)}</span> shares were sold that no
          imported purchase covers — the statement history starts after they were bought. Their
          cost is missing, so realised P/L is overstated and cost basis understated. Import
          earlier statements to close the gap.
        </Note>
      )}

      {row.missingFx && (
        <Note tone="warn" title={`No FX rate to ${base}`}>
          At least one leg of this position could not be converted, so its {base} figures are
          shown as “—” and it is left out of the totals rather than counted as zero.
        </Note>
      )}

      {row.unpriced && (
        <Note tone="muted" title="No price available">
          Neither the statement nor a provider gave a price for {h.symbol}, so value and weight
          are unknown. Enable market data on the Data tab, or set a manual price.
        </Note>
      )}

      {h.quantitySource === 'snapshot' && (
        <Note tone="muted" title="From the broker snapshot">
          No trades for this position appear in the imported statements, so quantity and cost
          come from IBKR's Open Positions section. Lot dates are unknown, which makes the
          currency attribution of cost basis weaker than for the other positions.
        </Note>
      )}

      {row.noDividendData && (
        <Note tone="muted" title="Forward income unknown">
          No dividend history and no open accrual for this instrument, so its forward yield is
          unknown — not zero. It contributes nothing to the forecast total.
        </Note>
      )}

      {row.incomeFxUnknown && (
        <Note tone="warn" title={`Forward income has no FX rate to ${base}`}>
          At least one projected payment for this position is in a currency with no rate to{' '}
          {base} on file, so its forward income and yield are shown as “—”. The portfolio
          forecast counts the unconvertible leg as nothing, which understates it.
        </Note>
      )}

      {row.declaredOnly && (
        <Note tone="muted" title="Forward income is declared only">
          Only IBKR's open accruals are visible for this position, which is about four weeks of
          horizon. The real twelve-month figure is higher.
        </Note>
      )}

      {row.staleHistory && (
        <Note tone="muted" title="Seasonality from an old window">
          The payment pattern used for this position comes from a window older than twelve
          months, so the month-by-month split may have moved.
        </Note>
      )}

      {h.excluded && (
        <Note tone="muted" title="Excluded from totals">
          You excluded this instrument on the Data tab. It is shown for reference and left out
          of every portfolio figure.
        </Note>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted truncate">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  )
}

/** Explanatory block. Tone is reinforcement — the title always carries the meaning. */
function Note({
  tone,
  title,
  children,
}: {
  tone: 'warn' | 'muted'
  title: string
  children: ReactNode
}) {
  return (
    <div className="text-xs">
      <Badge tone={tone}>{title}</Badge>
      <p className="text-muted mt-1 leading-relaxed">{children}</p>
    </div>
  )
}

function Footnotes({
  base,
  rows,
  totals,
  hiddenSold,
}: {
  base: Currency
  rows: Row[]
  totals: Totals
  hiddenSold: { count: number; realized: number }
}) {
  const anyDeclared = rows.some((r) => r.declaredOnly && r.yieldPct !== null)
  const plural = (n: number) => (n === 1 ? '' : 's')
  return (
    <div className="mt-3 pt-3 border-t border-border text-[11px] text-muted space-y-1">
      <p>“—” means unknown, not zero. Select a row for identity, lots and price provenance.</p>
      {anyDeclared && (
        <p>† Forward yield from declared accruals only — roughly four weeks of visibility.</p>
      )}
      {/* `sumDefined` skips what it cannot add. Left unsaid, the total reads as
          complete when it is really the sum of a subset. */}
      {totals.noPrice > 0 && (
        <p>
          {totals.noPrice} position{plural(totals.noPrice)} ha
          {totals.noPrice === 1 ? 's' : 've'} no price, so{' '}
          {totals.noPrice === 1 ? 'it adds' : 'they add'} nothing to the totals rather than
          counting as zero. Refresh market data or set a price on the Data tab.
        </p>
      )}
      {totals.noValueFx > 0 && (
        <p>
          {totals.noValueFx} position{plural(totals.noValueFx)} could not be converted to {base}
          {' '}and {totals.noValueFx === 1 ? 'is' : 'are'} left out of the totals. Refresh FX
          rates on the Data tab.
        </p>
      )}
      {totals.excluded > 0 && (
        <p>
          {totals.excluded} excluded position{plural(totals.excluded)} {' '}
          {totals.excluded === 1 ? 'is' : 'are'} listed but outside every total.
        </p>
      )}
      {hiddenSold.count > 0 && (
        <p>
          Realised P/L of {hiddenSold.count} sold position{plural(hiddenSold.count)} (
          {formatMoney(hiddenSold.realized, base, { signed: true })}) is not in the total above
          — tick “Show sold” to include {hiddenSold.count === 1 ? 'it' : 'them'}.
        </p>
      )}
    </div>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 mt-0.5 text-muted transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `sumDefined` skips nulls, so a column where NOTHING could be converted sums
 * to a confident zero. Nothing known is "unknown", and only an empty selection
 * is legitimately nought.
 */
function totalOrNull(values: (number | null)[]): number | null {
  return values.length > 0 && values.every((v) => v === null) ? null : sumDefined(values)
}

/**
 * Quantities are decimal. Four places, trailing zeros trimmed — and a dust
 * position is never printed as "0", which would read as closed.
 */
function formatQty(quantity: number): string {
  if (!Number.isFinite(quantity)) return '—'
  if (quantity === 0) return '0'
  if (Math.abs(quantity) < 0.00005) return quantity > 0 ? '<0.0001' : '−<0.0001'
  const body = new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(quantity)
  // Same true minus as `formatMoney`, so a negative discrepancy lines up with
  // the money columns instead of showing a narrower ASCII hyphen.
  return body.replace('-', '−')
}

/**
 * Per-unit money: two places, except under one unit where two places round a
 * pence-quoted price to nothing.
 */
function unitDp(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) && Math.abs(value) < 1 ? 4 : 2
}

/**
 * Earliest acquisition still visible in the ledger: open lots for a live
 * position, and the lots consumed by past sales for one that has been trimmed
 * or closed. Null when the quantity came from a snapshot — there are no lots.
 */
function firstPurchase(h: Holding): ISODate | null {
  let earliest: ISODate | null = null
  const consider = (date: ISODate) => {
    if (earliest === null || date < earliest) earliest = date
  }
  for (const lot of h.lots) consider(lot.date)
  for (const sale of h.sales) for (const c of sale.consumed) consider(c.lotDate)
  return earliest
}

/**
 * `Staleness` wants a real provider and timestamp. A live quote carries its
 * own provenance, so use that rather than inventing one; a statement close
 * price is 'statement' and a user override is 'manual'.
 */
function priceProvenance(h: Holding, quote: Quote | null): Provenance | null {
  if (h.priceSource === null || h.priceAsOf === null) return null
  if (h.priceSource === 'quote') return quote?.provenance ?? null
  return {
    source: h.priceSource === 'snapshot' ? 'statement' : 'manual',
    asOf: h.priceAsOf,
  }
}

function matches(row: Row, query: string): boolean {
  if (query === '') return true
  const { h } = row
  // Aliases are searchable on purpose: a renamed ticker must still be findable
  // under the name the user remembers buying.
  const haystack = [h.symbol, h.name, h.instrument?.isin ?? '', ...row.otherAliases]
  return haystack.some((v) => v.toLowerCase().includes(query))
}

function metric(row: Row, key: SortKey): number | null {
  switch (key) {
    case 'value':
      return row.h.marketValueBase
    case 'weight':
      return row.h.weightPct
    case 'pnl':
      return row.h.unrealizedPnlBase
    case 'pnlPct':
      return row.pnlPct
    case 'yield':
      return row.yieldPct
    default:
      return null
  }
}

function compare(a: Row, b: Row, key: SortKey, factor: number): number {
  if (key === 'symbol') return factor * a.h.symbol.localeCompare(b.h.symbol)
  const av = metric(a, key)
  const bv = metric(b, key)
  // Unknowns sink in BOTH directions. A missing price is not the smallest
  // value in the column, and reversing the sort must not bury it at the top.
  if (av === null && bv === null) return a.h.symbol.localeCompare(b.h.symbol)
  if (av === null) return 1
  if (bv === null) return -1
  if (av === bv) return a.h.symbol.localeCompare(b.h.symbol)
  return factor * (av < bv ? -1 : 1)
}

function directionLabel(sort: SortKey, dir: 'asc' | 'desc'): string {
  if (sort === 'symbol') return dir === 'asc' ? 'A–Z' : 'Z–A'
  return dir === 'desc' ? 'High–low' : 'Low–high'
}

function countHint(closed: number, unpriced: number, excluded: number): string | undefined {
  const parts: string[] = []
  if (closed > 0) parts.push(`${closed} sold`)
  if (unpriced > 0) parts.push(`${unpriced} unpriced`)
  if (excluded > 0) parts.push(`${excluded} excluded`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * The footer sums non-excluded rows only, so the count beside it has to be the
 * same population — "12 shown" over the sum of 11 is how a total starts lying.
 */
function countedLabel(totals: Totals): string {
  const shown = `${totals.counted} shown`
  return totals.excluded > 0 ? `${shown} · ${totals.excluded} excluded` : shown
}
