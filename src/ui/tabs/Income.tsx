import { useEffect, useMemo, useRef, useState } from 'react'
import type { Currency, Distribution, ISODate } from '../../domain/types'
import {
  addMonths,
  firstOfMonth,
  isValidISODate,
  monthKey,
  monthsBetween,
} from '../../metrics/fx'
import { isRegular } from '../../metrics/income'
import type { PaymentsMatrix, Period, PeriodBucket } from '../../metrics/income'
import { saveSettings } from '../../db/schema'
import { Columns, SEQUENTIAL, heatColor, seriesColor } from '../components/charts'
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

/**
 * Colour is assigned by entity, from a fixed order, so the bar keeps its hue
 * no matter what else ends up on the screen.
 */
const INCOME_ENTITIES = ['dividends']

const isPeriod = (v: string): v is Period =>
  v === 'month' || v === 'quarter' || v === 'year'

export function Income() {
  const view = usePortfolio()
  const [period, setPeriod] = useState<Period>('month')

  const base = view.settings.baseCurrency
  const net = view.settings.showNetDividends

  const buckets = useMemo(() => view.incomeBy(period), [view.incomeBy, period])
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

  // instrumentKey -> ticker. The view model hands distributions over with the
  // key only; labelling is presentation, not a metric.
  const symbols = useMemo(
    () => new Map(view.instruments.map((i) => [i.key, i.symbol])),
    [view.instruments],
  )

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
        buckets={buckets}
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
  buckets,
  trailing,
  missingFx,
}: {
  base: Currency
  net: boolean
  period: Period
  buckets: PeriodBucket[]
  trailing: Trailing | null
  missingFx: number
}) {
  const data = useMemo(
    () => buckets.map((b) => ({ label: bucketLabel(b.key, period), amount: b.amount })),
    [buckets, period],
  )

  let peak = 0
  for (const b of buckets) if (b.amount > peak) peak = b.amount
  // Small portfolios pay tens, not thousands: rounding those to whole units
  // would flatten the whole axis to one tick.
  const dp = peak > 0 && peak < 100 ? 2 : 0
  const format = (v: number) => formatMoney(v, base, { dp, compact: true })

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
        <Columns
          data={data}
          xKey="label"
          height={260}
          stacked={false}
          format={format}
          series={[
            {
              key: 'amount',
              name: title,
              color: seriesColor('dividends', INCOME_ENTITIES),
            },
          ]}
        />
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

  // Land on the most recent months. A user opening this on a phone wants last
  // month, not the first month they ever held anything.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [columns])

  let max = 0
  for (const row of matrix.rows) {
    for (const cell of row.cells) if (cell > max) max = cell
  }
  // Same rule as the chart axis: a portfolio paying tens rather than thousands
  // must not have every cell rounded to a whole unit.
  const dp = max > 0 && max < 100 ? 2 : 0

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
      title="Payments matrix"
      subtitle={`Each holding, each month, ${net ? 'net of withholding' : 'before withholding'}`}
      right={
        matrix.missingFx > 0 ? (
          <Badge tone="warn">{matrix.missingFx} without an FX rate</Badge>
        ) : undefined
      }
    >
      {/* The one table in the app allowed to scroll sideways: it is genuinely
          2-D, and stacking it into cards would destroy the month comparison
          that is the whole point of it. */}
      <div
        ref={scroller}
        tabIndex={0}
        role="region"
        aria-label="Payments matrix, scrolls horizontally"
        className="-mx-4 sm:-mx-5 max-h-[70vh] overflow-auto overscroll-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <table className="border-separate border-spacing-0 text-xs">
          <caption className="px-4 sm:px-5 pb-3 text-left">
            <span className="sticky left-0 inline-block text-xs text-muted max-w-[min(100%,44rem)]">
              Dividends paid by holding and month, in {base}, bucketed by pay date. A
              blank cell means no payment that month; shading shows the relative size and
              every cell that has one prints its amount. Regular dividends only. Each holding&rsquo;s
              lifetime total sits under its name.
            </span>
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
      <HeatLegend base={base} max={max} dp={dp} />
    </Card>
  )
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
}: {
  value: number
  max: number
  base: Currency
  dp: number
}) {
  // Zero stays on the card surface: "no payment" must not read as "a very
  // small payment", which the palest ramp step would imply.
  if (Math.abs(value) < 0.005) return <td className="px-2 py-1.5" />

  if (value < 0) {
    // A reversal. No heat — the ramp only encodes magnitude of money received.
    return (
      <td className="px-2 py-1.5 text-right num whitespace-nowrap text-neg">
        {cellText(value, base, dp)}
      </td>
    )
  }

  const background = heatColor(value, max)
  return (
    <td
      className={`px-2 py-1.5 text-right num whitespace-nowrap ${CELL_INK[background] ?? 'text-ink'}`}
      style={{ background }}
    >
      {cellText(value, base, dp)}
    </td>
  )
}

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

const RECENT_LIMIT = 25

function RecentPayments({
  distributions,
  symbols,
}: {
  distributions: readonly Distribution[]
  symbols: ReadonlyMap<string, string>
}) {
  const recent = useMemo(() => {
    // `id` breaks the tie so two payments on the same day never reorder between
    // renders.
    const sorted = [...distributions].sort(
      (a, b) => b.payDate.localeCompare(a.payDate) || a.id.localeCompare(b.id),
    )
    return sorted.slice(0, RECENT_LIMIT)
  }, [distributions])

  const rows = recent.map((d) => ({
    d,
    label: labelOf(d, symbols),
    irregular: !isRegular(d.divType, d.description),
  }))
  const anyIrregular = rows.some((r) => r.irregular)

  return (
    <Card
      title="Recent payments"
      subtitle={`Newest first · showing ${recent.length} of ${distributions.length}`}
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
            The {recent.length} most recent dividend payments, newest first, each shown in
            the currency it was paid in.
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
