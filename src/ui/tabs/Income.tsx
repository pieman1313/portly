import { useEffect, useMemo, useRef, useState } from 'react'
import type { Currency, Distribution, ISODate } from '../../domain/types'
import {
  addMonths,
  firstOfMonth,
  isValidISODate,
  monthKey,
  monthsBetween,
} from '../../metrics/fx'
import { instrumentLabel, isRegular } from '../../metrics/income'
import type { GroupedIncome, PaymentsMatrix, Period, PeriodBucket } from '../../metrics/income'
import { saveSettings } from '../../db/schema'
import { Columns, SEQUENTIAL, foldStack, heatColor, seriesColor } from '../components/charts'
import {
  Badge,
  Card,
  EmptyState,
  Money,
  StatTile,
  Toggle,
  formatMoney,
} from '../components/primitives'
import { usePortfolio } from '../usePortfolio'

/**
 * Income — dividends actually RECEIVED.
 *
 * Every figure on this screen is bucketed by PAY date, because this is a
 * cash-flow record: the question it answers is "when did the money land".
 * Ex-date belongs to the entitlement views (TTM per share, yield) and to the
 * Forecast tab; mixing the two conventions double-counts a December ex /
 * January pay. Hence the copy says "paid", never "earned".
 *
 * Nothing here is computed from the database. The tab reads `usePortfolio()`
 * and only ever picks fields off, or sums, values the view model already
 * produced.
 */

const PERIOD_OPTIONS = [
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
]

const BASIS_OPTIONS = [
  { value: 'net', label: 'Net' },
  { value: 'gross', label: 'Gross' },
]

const SPLIT_OPTIONS = [
  { value: 'ticker', label: 'By holding' },
  { value: 'total', label: 'Total' },
]

/**
 * Colour is assigned by entity, from a fixed order, so the bar keeps its hue
 * no matter what else ends up on the screen.
 */
const INCOME_ENTITIES = ['dividends']

/**
 * Eight coloured tickers, then one grey "Other". The palette has eight hues and
 * a ninth is never invented; a legend longer than this is unreadable at 360px
 * anyway, which is the real cap.
 */
const MAX_TICKERS = 8

/** Stacked by holding unless the user asks for the plain total. */
type Split = 'ticker' | 'total'

const isPeriod = (v: string): v is Period =>
  v === 'month' || v === 'quarter' || v === 'year'

export function Income() {
  const view = usePortfolio()
  const [period, setPeriod] = useState<Period>('month')

  const base = view.settings.baseCurrency
  const net = view.settings.showNetDividends

  // The grouped buckets are a superset of the plain ones — same totals, plus
  // the per-holding split the chart stacks — so the tiles read them too rather
  // than making the view model bucket the same payments twice.
  const income = useMemo(() => view.incomeByGrouped(period), [view.incomeByGrouped, period])
  const buckets = income.buckets
  // The tiles always talk in months ("best month", "average month"), so they
  // read their own monthly buckets rather than whatever the period toggle says.
  const monthly = useMemo(
    () => (period === 'month' ? buckets : view.incomeBy('month')),
    [buckets, period, view.incomeBy],
  )
  const trailing = useMemo(() => trailing12(monthly, view.today), [monthly, view.today])
  const best = useMemo(() => bestMonth(monthly), [monthly])

  const firstPayDate = useMemo(() => {
    let earliest: string | null = null
    for (const d of view.distributions) {
      // A pay date that is not a real date cannot be the "since" of anything;
      // an empty string would otherwise sort first and print "Since ".
      if (!isValidISODate(d.payDate)) continue
      if (earliest === null || d.payDate < earliest) earliest = d.payDate
    }
    return earliest
  }, [view.distributions])

  // Specials and returns of capital reach the all-time total but are filtered
  // out of the period buckets and the matrix. That gap is visible, so it has
  // to be explained rather than left for the user to discover.
  const irregularCount = useMemo(
    () => view.distributions.filter((d) => !isRegular(d.divType, d.description)).length,
    [view.distributions],
  )

  const chartMissingFx = useMemo(
    () => buckets.reduce((t, b) => t + b.missingFx, 0),
    [buckets],
  )

  // instrumentKey -> ticker, the user's rename included. Built by the view
  // model, not here: `view.matrix` is already labelled from the same map, and
  // a second copy on this screen is how the chart legend and the matrix start
  // calling one holding two different things.
  const symbols = view.symbols

  // Persisted, not local: gross/net is a whole-app stance. `matrix` and
  // `totalDividendsBase` are built inside usePortfolio from this flag, and a
  // tab-local copy would put a net chart above a gross matrix.
  const setBasis = (v: string) => {
    void saveSettings({ showNetDividends: v !== 'gross' }).catch(() => {
      // Storage refused the preference (Safari private mode evicts IndexedDB).
      // The screen keeps showing the basis it already had, so no number on it
      // is wrong and there is nothing to alarm the user about.
    })
  }

  if (view.loading) return <LoadingSkeleton />

  if (!view.hasData) {
    return (
      <Card title="Dividends paid">
        <EmptyState
          title="No statements imported yet"
          action={
            <a
              href="#/data"
              className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-lg bg-accent text-white text-sm font-medium focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              Go to the Data tab
            </a>
          }
        >
          Import an Interactive Brokers Activity Statement CSV and every dividend in it
          shows up here, bucketed by the month the cash actually arrived.
        </EmptyState>
      </Card>
    )
  }

  if (view.distributions.length === 0) {
    return (
      <Card title="Dividends paid">
        <EmptyState title="No dividends in these statements">
          Your imported statements contain no dividend payments. Only cash that has
          actually been paid appears here — declared-but-unpaid dividends are on the
          Forecast tab.
        </EmptyState>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 [&_button]:min-h-[44px] [&_button]:px-3">
        <Toggle
          label="Group by"
          options={PERIOD_OPTIONS}
          value={period}
          onChange={(v) => {
            if (isPeriod(v)) setPeriod(v)
          }}
        />
        <Toggle
          label="Show"
          options={BASIS_OPTIONS}
          value={net ? 'net' : 'gross'}
          onChange={setBasis}
        />
      </div>

      <p className="text-xs text-muted max-w-prose">
        Net uses the withholding tax actually reported against each payment in your
        statement — not an assumed 15% or 30%. Everything on this screen is bucketed by
        pay date, so a bar is the cash that landed in that period.
      </p>

      <Tiles
        base={base}
        net={net}
        allTime={view.totalDividendsBase}
        since={firstPayDate}
        trailing={trailing}
        best={best}
      />

      {/* The tiles are sums of the same converted payments the chart plots, so
          an FX gap understates them too — and unlike the chart and the matrix
          they carry no card header to hang a badge off. */}
      {chartMissingFx > 0 && (
        <p className="text-xs text-warn max-w-prose">
          {chartMissingFx === 1 ? '1 payment' : `${chartMissingFx} payments`} had no{' '}
          {base} rate on the pay date and could not be converted, so every total on this
          screen is understated by {chartMissingFx === 1 ? 'it' : 'them'}.
        </p>
      )}

      {irregularCount > 0 && (
        <p className="text-xs text-muted max-w-prose">
          {irregularCount === 1 ? '1 payment is' : `${irregularCount} payments are`} a
          return of capital, payment in lieu or special. They are counted in the all-time
          total but left out of the chart and matrix below, where they would show up as a
          spike and then a phantom cut a year later.
        </p>
      )}

      <IncomeChart
        base={base}
        net={net}
        period={period}
        income={income}
        symbols={symbols}
        trailing={trailing}
        missingFx={chartMissingFx}
      />

      <MatrixCard base={base} net={net} matrix={view.matrix} />

      <RecentPayments distributions={view.distributions} symbols={symbols} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat tiles
// ─────────────────────────────────────────────────────────────────────────────

interface Trailing {
  total: number
  /** Elapsed calendar months the average is spread over, 1..12. */
  months: number
  average: number
  from: string
  to: string
}

function Tiles({
  base,
  net,
  allTime,
  since,
  trailing,
  best,
}: {
  base: Currency
  net: boolean
  allTime: number
  since: string | null
  trailing: Trailing | null
  best: PeriodBucket | null
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        // The basis is not repeated on every tile: the toggle above and the
        // chart title both name it, and a 360px tile hint truncates.
        label={net ? 'Paid, all time (net)' : 'Paid, all time (gross)'}
        value={<Money value={allTime} currency={base} compact />}
        hint={since === null ? undefined : `Since ${formatDay(since)}`}
      />
      <StatTile
        label="Last 12 months"
        value={<Money value={trailing?.total ?? null} currency={base} compact />}
        hint={trailing === null ? undefined : `${trailing.from} – ${trailing.to}`}
      />
      <StatTile
        label="Best month"
        value={<Money value={best?.amount ?? null} currency={base} compact />}
        hint={best === null ? 'No month with a payment' : monthName(best.key)}
      />
      <StatTile
        label="Average month"
        value={<Money value={trailing?.average ?? null} currency={base} compact />}
        hint={
          trailing === null
            ? undefined
            : `Over the last ${trailing.months} ${trailing.months === 1 ? 'month' : 'months'}`
        }
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main chart
// ─────────────────────────────────────────────────────────────────────────────

function IncomeChart({
  base,
  net,
  period,
  income,
  symbols,
  trailing,
  missingFx,
}: {
  base: Currency
  net: boolean
  period: Period
  income: GroupedIncome
  symbols: ReadonlyMap<string, string>
  trailing: Trailing | null
  missingFx: number
}) {
  // Stacked by default: "which holding paid me that" is the question the bar
  // raises. The plain total stays one click away for anyone who only wants the
  // cash-flow shape.
  const [split, setSplit] = useState<Split>('ticker')

  const buckets = income.buckets

  // Colour and rank come from `income.order` — contribution over the WHOLE
  // window — so a ticker keeps its hue when the period toggle reshapes the bars
  // and when a smaller neighbour folds away.
  const stack = useMemo(
    () =>
      foldStack(
        buckets.map((b) => b.byInstrument),
        (key) => instrumentLabel(key, symbols),
        { max: MAX_TICKERS, order: income.order },
      ),
    [buckets, income.order, symbols],
  )

  // One contributor stacks into a bar identical to the total, so there is
  // nothing to toggle and no legend worth its vertical space.
  const splittable = stack.shown.length > 1
  const byTicker = splittable && split === 'ticker'

  const data = useMemo(
    () =>
      buckets.map((b, i) => ({
        label: bucketLabel(b.key, period),
        ...(byTicker ? stack.rows[i] ?? {} : { amount: b.amount }),
      })),
    [buckets, period, byTicker, stack.rows],
  )

  let peak = 0
  for (const b of buckets) if (b.amount > peak) peak = b.amount
  // Small portfolios pay tens, not thousands: rounding those to whole units
  // would flatten the whole axis to one tick.
  const dp = peak > 0 && peak < 100 ? 2 : 0
  const format = (v: number) => formatMoney(v, base, { dp, compact: true })
  // The axis rounds and compacts to fit its ticks; the tooltip must not. A
  // holding that paid 0.42 into a bar of 900 would otherwise be listed as "0"
  // directly above a total that includes it.
  const exact = (v: number) => formatMoney(v, base, { dp: 2 })

  const title = net ? 'Net dividends paid' : 'Gross dividends paid'
  // The trailing average is stated in words rather than drawn as a reference
  // line: the kit has no reference-line affordance and hand-rolling one would
  // mean reaching past `Columns` into Recharts.
  // The average is a MONTHLY figure, so its precision follows its own size, not
  // the peak of a yearly bar: at dp 0 an average of 0.30 would print as "0".
  const subtitle =
    trailing === null
      ? `${periodNoun(period)} totals, ${base}`
      : `${periodNoun(period)} totals, ${base} · averaging ${formatMoney(
          trailing.average,
          base,
          { dp: Math.abs(trailing.average) < 100 ? 2 : 0 },
        )} a month over the last ${trailing.months}`

  return (
    <Card
      title={title}
      subtitle={subtitle}
      right={
        missingFx > 0 ? (
          <Badge tone="warn">
            {missingFx} without an FX rate
          </Badge>
        ) : undefined
      }
    >
      {data.length === 0 ? (
        <p className="text-sm text-muted py-6 text-center">
          No regular dividends to plot yet.
        </p>
      ) : (
        <>
          {splittable && (
            <div className="mb-3 flex justify-end">
              <Toggle
                label="Bars"
                options={SPLIT_OPTIONS}
                value={split}
                onChange={(v) => setSplit(v === 'total' ? 'total' : 'ticker')}
              />
            </div>
          )}
          <p className="sr-only">
            {byTicker
              ? `Bar chart of ${periodNoun(period).toLowerCase()} dividends, each bar split by holding, largest contributor first: ${stack.series
                  .map((s) => s.name)
                  .join(', ')}. The payments matrix below gives every holding's exact amount for every month.`
              : `Bar chart of ${periodNoun(period).toLowerCase()} dividend totals. The payments matrix below breaks the same money down by holding.`}
          </p>
          <Columns
            data={data}
            xKey="label"
            height={260}
            stacked={byTicker}
            format={format}
            tooltipFormat={exact}
            series={
              byTicker
                ? stack.series
                : [
                    {
                      key: 'amount',
                      name: title,
                      color: seriesColor('dividends', INCOME_ENTITIES),
                    },
                  ]
            }
          />
        </>
      )}
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Payments matrix
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two lightest ramp steps do not carry the default ink at 4.5:1, so they
 * flip to a light or dark foreground. Keyed off the kit's own ramp rather than
 * a second copy of the thresholds.
 */
const CELL_INK: Record<string, string> = {
  [SEQUENTIAL[3]]: 'text-white',
  [SEQUENTIAL[4]]: 'text-bg',
}

const HEAD_CELL =
  'sticky top-0 z-10 bg-surface px-2 py-1.5 text-right text-[11px] font-medium text-muted border-b border-border'
const ROW_HEAD =
  'sticky left-0 z-20 bg-surface px-3 py-1.5 text-left align-top border-r border-border'
const FOOT_CELL =
  'sticky bottom-0 z-10 bg-surface px-2 py-1.5 text-right border-t border-border'

const FOCUS =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface'

/**
 * Months in the phone window.
 *
 * A month column has to fit the widest amount it will ever print, and the base
 * currency decides that: "$1,234" is six characters, but a currency with no
 * symbol prints its code instead ("1,234 CHF") and needs half a column more. At
 * 360px the card leaves about 334px once the page and card padding are paid
 * for, and the holding column takes 104 of it — so four ~49px columns fit an
 * amount with a symbol, three ~68px ones fit an amount with a code. Nothing is
 * ellipsised either way; the window shrinks instead.
 */
const PHONE_MONTHS = 4
const PHONE_MONTHS_WIDE = 3
/** Characters at which an amount stops fitting a quarter of the month strip. */
const WIDE_AMOUNT = 8

function MatrixCard({
  base,
  net,
  matrix,
}: {
  base: Currency
  net: boolean
  matrix: PaymentsMatrix
}) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const columns = matrix.months.length

  let max = 0
  for (const row of matrix.rows) {
    for (const cell of row.cells) if (cell > max) max = cell
  }
  // Same rule as the chart axis: a portfolio paying tens rather than thousands
  // must not have every cell rounded to a whole unit.
  const dp = max > 0 && max < 100 ? 2 : 0

  const size = Math.max(
    1,
    Math.min(
      columns,
      widestAmount(matrix, base, dp) >= WIDE_AMOUNT ? PHONE_MONTHS_WIDE : PHONE_MONTHS,
    ),
  )

  // Land on the most recent months — on both layouts. A user opening this wants
  // last month, not the first month they ever held anything.
  const [start, setStart] = useState(() => Math.max(0, columns - size))
  useEffect(() => {
    setStart(Math.max(0, columns - size))
  }, [columns, size])

  useEffect(() => {
    const el = scroller.current
    if (el === null) return
    const snap = () => {
      if (el.clientWidth > 0) el.scrollLeft = el.scrollWidth
    }
    snap()
    // Below sm the wide table is display:none, so the call above measured a box
    // of zero and scrolled nothing. Rotating a phone into landscape crosses the
    // breakpoint and reveals it; without this the reveal would land on the
    // oldest month, the one month nobody opened this to see.
    if (typeof ResizeObserver === 'undefined') return
    let shown = el.clientWidth > 0
    const ro = new ResizeObserver(() => {
      const nowShown = el.clientWidth > 0
      if (nowShown && !shown) snap()
      shown = nowShown
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
    }
  }, [columns])

  if (columns === 0 || matrix.rows.length === 0) {
    return (
      <Card title="Payments matrix">
        <p className="text-sm text-muted py-6 text-center">
          No regular dividend payments to lay out yet.
        </p>
      </Card>
    )
  }

  return (
    <Card
      // From sm up the matrix owns its own scroller, and it has to: the sticky
      // first column and header row are positioned against it. Letting the card
      // cap and scroll as well would stack two scrollers, so a swipe would move
      // whichever one the browser guessed at. Below sm nothing here scrolls at
      // all and capping the card would put that nested scroller back.
      cap={false}
      title="Payments matrix"
      subtitle={`Each holding, each month, ${net ? 'net of withholding' : 'before withholding'}`}
      right={
        matrix.missingFx > 0 ? (
          <Badge tone="warn">{matrix.missingFx} without an FX rate</Badge>
        ) : undefined
      }
    >
      <PhoneMatrix
        base={base}
        matrix={matrix}
        max={max}
        dp={dp}
        size={size}
        start={Math.min(start, Math.max(0, columns - size))}
        onStart={setStart}
      />

      {/* From sm up, the one table in the app allowed to scroll sideways: it is
          genuinely 2-D, and stacking it into cards would destroy the month
          comparison that is the whole point of it. A mouse and a trackpad both
          drive a sideways scroller fine, and the width is there to use.

          Below sm it is not rendered at all — display:none takes it out of hit
          testing, so it cannot capture a gesture, and out of the accessibility
          tree, so the paged window above is not announced twice. */}
      <div className="hidden sm:block">
        <div
          ref={scroller}
          tabIndex={0}
          role="region"
          aria-label="Payments matrix, scrolls horizontally"
          className="-mx-4 sm:-mx-5 overflow-auto overscroll-x-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          // overscroll-x-contain, NOT overscroll-contain: containing both axes
          // stopped a vertical swipe that began inside the matrix from ever
          // reaching the page. Horizontal containment is the part we want —
          // dragging the matrix sideways should not also drag the page. It stays
          // because a trackpad can still chain a two-finger scroll out of here.
          //
          // Containment does not fix gesture CAPTURE, which is the other half of
          // the problem and has no CSS answer at all — see PhoneMatrix.
        >
          <table className="border-separate border-spacing-0 text-xs">
            {/* Announced, not printed. A caption is how a screen reader learns
                what a 2-D grid is before it starts reading cells, so it has to
                exist — but on the card it was five lines of prose explaining a
                grid that a sighted user has already read. The two facts that
                are not self-evident, blank meaning no payment and what the
                shading is worth, live in the legend under the table. */}
            <caption className="sr-only">
              <MatrixCaption base={base} />
            </caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 top-0 z-30 bg-surface px-3 py-1.5 text-left text-[11px] font-medium text-muted border-b border-r border-border min-w-[116px]"
                >
                  Holding
                </th>
                {matrix.months.map((m) => (
                  <th key={m} scope="col" className={`${HEAD_CELL} min-w-[54px]`}>
                    <span className="block">{monthAbbr(m)}</span>
                    <span className="block text-[10px] font-normal opacity-80">
                      &rsquo;{m.slice(2, 4)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row) => (
                <tr key={row.instrumentKey ?? row.label}>
                  <th scope="row" className={ROW_HEAD}>
                    <span className="block font-medium text-ink truncate max-w-[104px]">
                      {row.label}
                    </span>
                    <span className="num block text-[11px] font-normal text-muted">
                      {cellText(row.total, base, dp)}
                    </span>
                  </th>
                  {row.cells.map((value, i) => (
                    <MatrixCell
                      key={matrix.months[i] ?? i}
                      value={value ?? 0}
                      max={max}
                      base={base}
                      dp={dp}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th
                  scope="row"
                  className="sticky left-0 bottom-0 z-30 bg-surface px-3 py-1.5 text-left align-top border-t border-r border-border"
                >
                  <span className="block font-medium text-ink">All holdings</span>
                  <span className="num block text-[11px] font-normal text-muted">
                    {cellText(matrix.grandTotal, base, dp)}
                  </span>
                </th>
                {matrix.columnTotals.map((total, i) => (
                  <td key={matrix.months[i] ?? i} className={`${FOOT_CELL} num whitespace-nowrap`}>
                    {Math.abs(total) < 0.005 ? '' : cellText(total, base, dp)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <HeatLegend base={base} max={max} dp={dp} />
    </Card>
  )
}

/**
 * The matrix on a phone: a window of months you page through, with no
 * horizontally scrolling element anywhere in it.
 *
 * This is not a styling preference, it is the only fix available. A touch
 * gesture locks to ONE AXIS as it begins, and a diagonal swipe that starts over
 * a horizontally scrollable element locks to horizontal — so the page does not
 * move at all until the finger lifts, and the tab feels frozen. Measured with
 * synthetic touch drags at 390px, starting in the middle of the old scroller:
 * pure vertical moved the page 356px, 30 degrees off vertical 310px, 45 degrees
 * 0px. The 45-degree swipe is not exotic; it is what a thumb does.
 *
 * Neither CSS lever helps. `overscroll-x-contain` fixes scroll CHAINING, a
 * different bug. `touch-action: pan-x pinch-zoom` reads like the fix and is not:
 * it does not hand the vertical component of the gesture to the page, it removes
 * vertical panning from the gesture — measured, and every angle then moved the
 * page 0px. There is no CSS that makes a nested horizontal scroller stop
 * capturing diagonal gestures, so on a phone there is no nested horizontal
 * scroller. Buttons move the window instead of the finger.
 */
function PhoneMatrix({
  base,
  matrix,
  max,
  dp,
  size,
  start,
  onStart,
}: {
  base: Currency
  matrix: PaymentsMatrix
  max: number
  dp: number
  size: number
  start: number
  onStart: (n: number) => void
}) {
  const columns = matrix.months.length
  const end = Math.min(columns, start + size)
  const months = matrix.months.slice(start, end)
  const first = months[0] ?? ''
  const last = months[months.length - 1] ?? ''
  const range = rangeLabel(first, last)
  const paged = columns > size

  return (
    <div className="sm:hidden">
      {paged && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onStart(Math.max(0, start - size))}
            disabled={start === 0}
            aria-label="Show earlier months"
            className={`min-h-[44px] min-w-[44px] px-2.5 rounded-lg border border-border text-xs text-ink disabled:opacity-40 ${FOCUS}`}
          >
            <span aria-hidden>&lsaquo;</span> Earlier
          </button>
          {/* Live, because the buttons change what the table says and a screen
              reader user has no other way to hear which months arrived. */}
          <p className="min-w-0 text-center" aria-live="polite">
            <span className="block text-xs font-medium text-ink">{range}</span>
            <span className="block text-[11px] text-muted">
              Showing {months.length} of {columns} months
            </span>
          </p>
          <button
            type="button"
            onClick={() => onStart(Math.min(Math.max(0, columns - size), start + size))}
            disabled={end >= columns}
            aria-label="Show later months"
            className={`min-h-[44px] min-w-[44px] px-2.5 rounded-lg border border-border text-xs text-ink disabled:opacity-40 ${FOCUS}`}
          >
            Later <span aria-hidden>&rsaquo;</span>
          </button>
        </div>
      )}

      {/* Labelled as a group so the pager and the table announce as one widget,
          and so the label names the months actually on screen. */}
      <div role="group" aria-label={`Payments matrix, ${range}`}>
        <table className="w-full border-separate border-spacing-0 text-xs">
          {/* Same bargain as the wide table: kept for the screen reader, off the
              card for everyone else. It is the phone that paid most for the
              prose — the paragraph was taller than the grid it described. The
              "All-time" label in the corner header carries the one thing a
              sighted user really does need from it, that the figure under each
              holding is a lifetime total and not a total of the months shown. */}
          <caption className="sr-only">
            <MatrixCaption base={base} windowed={paged} />
          </caption>
          <thead>
            <tr>
              {/* The number under each holding is its LIFETIME total, not the
                  total of the months on screen. Beside a four-month window an
                  unlabelled total would be read as that window's, so the column
                  says which it is rather than leaving it to the caption. */}
              <th
                scope="col"
                className="w-[104px] px-2 py-1.5 text-left text-[11px] font-medium text-muted border-b border-r border-border"
              >
                <span className="block">Holding</span>
                <span className="block text-[10px] font-normal opacity-80">All-time</span>
              </th>
              {months.map((m) => (
                <th
                  key={m}
                  scope="col"
                  className="px-1.5 py-1.5 text-right text-[11px] font-medium text-muted border-b border-border"
                >
                  <span className="block">{monthAbbr(m)}</span>
                  <span className="block text-[10px] font-normal opacity-80">
                    &rsquo;{m.slice(2, 4)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.instrumentKey ?? row.label}>
                <th
                  scope="row"
                  className="px-2 py-1.5 text-left align-top border-r border-border"
                >
                  <span className="block font-medium text-ink truncate max-w-[96px]">
                    {row.label}
                  </span>
                  <span className="num block text-[11px] font-normal text-muted whitespace-nowrap">
                    {cellText(row.total, base, dp)}
                  </span>
                </th>
                {row.cells.slice(start, end).map((value, i) => (
                  <MatrixCell
                    key={months[i] ?? i}
                    value={value ?? 0}
                    // The ramp is keyed to the all-time maximum, not the window's,
                    // so a quiet quarter does not repaint itself as a busy one
                    // when you page onto it — and so the legend below still says
                    // what the darkest step is worth.
                    max={max}
                    base={base}
                    dp={dp}
                    pad="px-1.5"
                  />
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th
                scope="row"
                className="px-2 py-1.5 text-left align-top border-t border-r border-border"
              >
                <span className="block font-medium text-ink">All holdings</span>
                <span className="num block text-[11px] font-normal text-muted whitespace-nowrap">
                  {cellText(matrix.grandTotal, base, dp)}
                </span>
              </th>
              {matrix.columnTotals.slice(start, end).map((total, i) => (
                <td
                  key={months[i] ?? i}
                  className="px-1.5 py-1.5 text-right num whitespace-nowrap border-t border-border"
                >
                  {Math.abs(total) < 0.005 ? '' : cellText(total, base, dp)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

/**
 * One caption, both layouts, so the two tables cannot drift into explaining
 * themselves differently. `windowed` adds the sentence the phone needs and the
 * desktop table does not.
 */
function MatrixCaption({ base, windowed = false }: { base: Currency; windowed?: boolean }) {
  return (
    <>
      Dividends paid by holding and month, in {base}, bucketed by pay date. A blank cell
      means no payment that month; shading shows the relative size and every cell that has
      one prints its amount. Regular dividends only.{' '}
      {windowed ? (
        <>
          The figure under each holding, and under All holdings, is its lifetime total
          across every month in your statements &mdash; not a total of the months shown.
        </>
      ) : (
        <>Each holding&rsquo;s lifetime total sits under its name.</>
      )}
    </>
  )
}

/**
 * Longest amount, in characters, that a month column may have to print. Drives
 * the phone window size; nothing is allowed to be ellipsised into "$1,2…", so
 * the count of columns gives way instead.
 */
function widestAmount(matrix: PaymentsMatrix, base: Currency, dp: number): number {
  let widest = 0
  const measure = (v: number) => {
    if (Math.abs(v) < 0.005) return
    const n = cellText(v, base, dp).length
    if (n > widest) widest = n
  }
  for (const row of matrix.rows) for (const cell of row.cells) measure(cell)
  for (const total of matrix.columnTotals) measure(total)
  return widest
}

/** 'Sep – Dec 2025', or 'Nov 2024 – Feb 2025' when the window straddles a year. */
function rangeLabel(from: string, to: string): string {
  if (from === '' || to === '') return ''
  if (from === to) return monthName(to)
  return from.slice(0, 4) === to.slice(0, 4)
    ? `${monthAbbr(from)} – ${monthAbbr(to)} ${to.slice(0, 4)}`
    : `${monthName(from)} – ${monthName(to)}`
}

/**
 * A payment that rounds away at the matrix's precision must not print as "0":
 * blank already means "no payment", so a printed zero is a lie about a real
 * payment. Such a cell falls back to two places instead.
 */
function cellText(value: number, base: Currency, dp: number): string {
  const roundsToZero = Math.abs(value) < 0.5 * 10 ** -dp
  return formatMoney(value, base, { dp: roundsToZero ? 2 : dp, compact: true })
}

function MatrixCell({
  value,
  max,
  base,
  dp,
  // The phone window has four columns to fit in 230px, so it buys itself a few
  // pixels here. Padding is the only thing that gives: the amount is never
  // truncated, wrapped or shrunk.
  pad = 'px-2',
}: {
  value: number
  max: number
  base: Currency
  dp: number
  pad?: string
}) {
  // Zero stays on the card surface: "no payment" must not read as "a very
  // small payment", which the palest ramp step would imply.
  if (Math.abs(value) < 0.005) return <td className={`${pad} py-1.5`} />

  if (value < 0) {
    // A reversal. No heat — the ramp only encodes magnitude of money received.
    return (
      <td className={`${pad} py-1.5 text-right num whitespace-nowrap text-neg`}>
        {cellText(value, base, dp)}
      </td>
    )
  }

  const background = heatColor(value, max)
  return (
    <td
      className={`${pad} py-1.5 text-right num whitespace-nowrap ${CELL_INK[background] ?? 'text-ink'}`}
      style={{ background }}
    >
      {cellText(value, base, dp)}
    </td>
  )
}

/**
 * The whole visible explanation of the matrix, now that the caption is read
 * rather than printed. Both halves earn the line they cost: nothing else says
 * that a blank cell is "no payment" rather than "a payment of zero", and
 * nothing else says what the darkest shade is worth, which is the only thing
 * that turns the ramp from decoration into a scale.
 */
function HeatLegend({ base, max, dp }: { base: Currency; max: number; dp: number }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
      <span>Blank = no payment</span>
      {max > 0 && (
        <span className="flex items-center gap-1">
          <span>smaller</span>
          <span aria-hidden className="flex">
            {SEQUENTIAL.map((c) => (
              <span key={c} className="w-5 h-3" style={{ background: c }} />
            ))}
          </span>
          <span>larger, up to {cellText(max, base, dp)}</span>
        </span>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Recent payments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rows in the first batch, and in every reveal after it.
 *
 * Twelve is a year of a monthly payer, which is the span someone glancing at
 * this wants. The three test statements come to 38 payments and a longer
 * history runs into the hundreds; as one list inside a card that caps at 75vh
 * on a phone, that is a scroll to nowhere.
 */
const BATCH = 12

function RecentPayments({
  distributions,
  symbols,
}: {
  distributions: readonly Distribution[]
  symbols: ReadonlyMap<string, string>
}) {
  const sorted = useMemo(() => {
    // `id` breaks the tie so two payments on the same day never reorder between
    // renders.
    return [...distributions].sort(
      (a, b) => b.payDate.localeCompare(a.payDate) || a.id.localeCompare(b.id),
    )
  }, [distributions])

  // A button, not an IntersectionObserver. This card caps at 75vh and scrolls
  // its own body on a phone, so an observer would be watching a sentinel inside
  // a nested scrollport — and it would never say how much is left, which is the
  // question someone twelve rows into thirty-eight is actually asking.
  const [shown, setShown] = useState(BATCH)

  // Keyed on the content of the list, not the identity of the array.
  // `usePortfolio` rebuilds every array it returns whenever anything in the
  // database changes, so the gross/net toggle and the background quote refresh
  // both hand this component a brand-new `distributions` — and resetting on
  // those would snatch rows back from someone mid-read. Measured in the
  // browser: expanded to 36 of 38, both of those leave it at 36, and retiring
  // one payment drops it back to 12 of 37, which is the case the reset is for.
  const signature = `${sorted.length}:${sorted[0]?.id ?? ''}`
  const [shownFor, setShownFor] = useState(signature)
  if (shownFor !== signature) {
    // Adjusted during render rather than in an effect: an effect paints one
    // frame of the old reveal against the new list first.
    setShownFor(signature)
    setShown(BATCH)
  }

  const rows = sorted.slice(0, shown).map((d) => ({
    d,
    label: labelOf(d, symbols),
    irregular: !isRegular(d.divType, d.description),
  }))
  // Of the rows on screen: the note explains badges the user can see, so it
  // must not appear before the badge it explains does.
  const anyIrregular = rows.some((r) => r.irregular)
  const remaining = sorted.length - rows.length
  const nextBatch = Math.min(BATCH, remaining)

  return (
    <Card
      title="Recent payments"
      subtitle={`Newest first · showing ${rows.length} of ${sorted.length}`}
    >
      {/* Below sm this is a stacked list, not a squeezed table: six columns of
          money at 360px is unreadable, and a sideways-scrolling ledger is worse. */}
      <ul className="sm:hidden space-y-2">
        {rows.map(({ d, label, irregular }) => (
          <PaymentCard key={d.id} d={d} label={label} irregular={irregular} />
        ))}
      </ul>

      <div className="hidden sm:block">
        <table className="w-full text-sm">
          <caption className="sr-only">
            The {rows.length} most recent of {sorted.length} dividend payments, newest
            first, each shown in the currency it was paid in.
          </caption>
          <thead>
            <tr className="text-xs text-muted">
              <th scope="col" className="text-left font-medium py-2">
                Pay date
              </th>
              <th scope="col" className="text-left font-medium py-2">
                Holding
              </th>
              <th scope="col" className="text-left font-medium py-2">
                Currency
              </th>
              <th scope="col" className="text-right font-medium py-2">
                Gross
              </th>
              <th scope="col" className="text-right font-medium py-2">
                Tax withheld
              </th>
              <th scope="col" className="text-right font-medium py-2">
                Net
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ d, label, irregular }) => (
              <tr key={d.id} className="border-t border-border">
                <td className="py-2 pr-2 whitespace-nowrap">
                  <time dateTime={d.payDate}>{formatDay(d.payDate)}</time>
                </td>
                <td className="py-2 pr-2">
                  <span className="inline-flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium">{label}</span>
                    {irregular && <Badge tone="muted">{typeLabel(d)}</Badge>}
                  </span>
                </td>
                <td className="py-2 pr-2 text-muted">{d.currency}</td>
                <td className="py-2 pl-2 text-right">
                  <Money value={d.gross} currency={d.currency} />
                </td>
                <td className="py-2 pl-2 text-right">
                  <Money value={d.tax} currency={d.currency} />
                </td>
                <td className="py-2 pl-2 text-right font-medium">
                  <Money value={d.net} currency={d.currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {remaining > 0 && (
        // Full width on a phone, where it is the thumb's target at the foot of
        // a scrolling card; centred and self-sized from sm up, where a
        // 1000px-wide button is a target nobody needs and a rule nobody drew.
        <div className="mt-3 sm:flex sm:justify-center">
          <button
            type="button"
            onClick={() => setShown((n) => n + BATCH)}
            className={`w-full sm:w-auto min-h-[44px] px-6 rounded-lg border border-border text-sm font-medium text-ink ${FOCUS}`}
          >
            Show {nextBatch} more of {remaining}
          </button>
        </div>
      )}
      {/* Outside the conditional above, and never unmounted: a live region only
          announces changes to a region that was already there, so folding this
          in with the button would silence the one reveal that matters most —
          the last, which takes the button away with it. */}
      <p aria-live="polite" className="sr-only">
        Showing {rows.length} of {sorted.length} payments.
      </p>

      {anyIrregular && (
        <p className="text-xs text-muted mt-3">
          Badged payments are returns of capital, payments in lieu or specials. They are
          listed here but excluded from the chart and matrix above.
        </p>
      )}
    </Card>
  )
}

function PaymentCard({
  d,
  label,
  irregular,
}: {
  d: Distribution
  label: string
  irregular: boolean
}) {
  return (
    <li className="border border-border rounded-lg p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium truncate">{label}</span>
        <time dateTime={d.payDate} className="text-xs text-muted shrink-0">
          {formatDay(d.payDate)}
        </time>
      </div>
      {irregular && (
        <div className="mt-1.5">
          <Badge tone="muted">{typeLabel(d)}</Badge>
        </div>
      )}
      {/* The desktop table has a Currency column; the card has to say it too,
          or a "$" is the only clue and CAD/AUD/SGD have no symbol at all. */}
      <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div className="col-span-3 flex items-baseline gap-1 text-muted">
          <dt>Paid in</dt>
          <dd className="num text-ink">{d.currency}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted">Gross</dt>
          <dd className="mt-0.5 truncate">
            <Money value={d.gross} currency={d.currency} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted">Tax withheld</dt>
          <dd className="mt-0.5 truncate">
            <Money value={d.tax} currency={d.currency} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted">Net</dt>
          <dd className="mt-0.5 truncate font-medium">
            <Money value={d.net} currency={d.currency} />
          </dd>
        </div>
      </dl>
    </li>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading dividend history
      </span>
      <div className="h-11 w-64 max-w-full rounded-lg bg-surface border border-border" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[84px] rounded-xl bg-surface border border-border" />
        ))}
      </div>
      <div className="h-[320px] rounded-xl bg-surface border border-border" />
      <div className="h-[240px] rounded-xl bg-surface border border-border" />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers — labels and sums over buckets the view model already produced
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** Takes any ISO-ish string whose characters 5..7 are the month. */
function monthAbbr(iso: string): string {
  return MONTH_ABBR[Number(iso.slice(5, 7)) - 1] ?? iso.slice(5, 7)
}

/** 'YYYY-MM' -> 'Mar 2024'. */
function monthName(key: string): string {
  return `${monthAbbr(key)} ${key.slice(0, 4)}`
}

function formatDay(iso: string): string {
  if (iso.length < 10) return iso
  return `${Number(iso.slice(8, 10))} ${monthAbbr(iso)} ${iso.slice(0, 4)}`
}

function bucketLabel(key: string, period: Period): string {
  if (period === 'year') return key
  const yy = key.slice(2, 4)
  // 'YYYY-Qn' for quarters, 'YYYY-MM' for months.
  return period === 'quarter' ? `Q${key.slice(6)} ${yy}` : `${monthAbbr(key)} ${yy}`
}

function periodNoun(period: Period): string {
  return period === 'month' ? 'Monthly' : period === 'quarter' ? 'Quarterly' : 'Yearly'
}

function typeLabel(d: Distribution): string {
  return d.divType ?? 'Not a regular dividend'
}

function labelOf(d: Distribution, symbols: ReadonlyMap<string, string>): string {
  const bySymbol = d.instrumentKey === null ? undefined : symbols.get(d.instrumentKey)
  if (bySymbol !== undefined && bySymbol !== '') return bySymbol
  if (d.isin !== null && d.isin !== '') return d.isin
  return 'Unmatched'
}

/**
 * Trailing twelve months of received dividends.
 *
 * The divisor is elapsed calendar months, not months that happen to carry a
 * bucket: `dividendsByPeriod` only spans first payment to last payment, so a
 * holder who has received nothing since spring would otherwise get an average
 * flattered by the missing zero months.
 */
function trailing12(monthly: readonly PeriodBucket[], today: ISODate): Trailing | null {
  const first = monthly[0]
  if (first === undefined) return null

  const endKey = monthKey(today)
  const startKey = monthKey(addMonths(firstOfMonth(today), -11))
  const total = monthly
    .filter((b) => b.key >= startKey && b.key <= endKey)
    .reduce((t, b) => t + b.amount, 0)

  const from = first.key > startKey ? first.key : startKey
  const months = Math.min(12, Math.max(1, monthsBetween(`${from}-01`, `${endKey}-01`) + 1))

  return {
    total,
    months,
    average: total / months,
    from: monthName(from),
    to: monthName(endKey),
  }
}

function bestMonth(monthly: readonly PeriodBucket[]): PeriodBucket | null {
  let best: PeriodBucket | null = null
  for (const b of monthly) {
    if (b.amount > 0 && (best === null || b.amount > best.amount)) best = b
  }
  return best
}
