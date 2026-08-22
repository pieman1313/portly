import { useId, useMemo, useState } from 'react'
import type { Currency } from '../../domain/types'
import type { ForecastBasis, ForecastCoverage, ForecastItem, ForecastMonth } from '../../metrics/forecast'
import { Columns, Donut, seriesColor, type StackSeries } from '../components/charts'
import {
  Badge,
  Card,
  EmptyState,
  formatMoney,
  formatPct,
  Hero,
  Money,
  StatTile,
} from '../components/primitives'
import { NoData } from '../components/NoData'
import { CardStack } from '../cards/CardStack'
import { card } from '../cards/useCardLayout'
import type { CardSpec } from '../cards/layout'
import { usePortfolio } from '../usePortfolio'

/**
 * Forecast — the next twelve months of dividend income.
 *
 * This is the only screen in the app that predicts rather than reports, so the
 * split between DECLARED (an open accrual on the statement — exact) and
 * ESTIMATED (the provider's trailing-12-month rate at today's share count) is
 * rendered next to every number: hero, bars, month rows, table. A projection
 * whose provenance is invisible is indistinguishable from a made-up number.
 *
 * The other honesty rule here is that nothing is ever coerced to zero. IBKR
 * posts an accrual at ex-date minus one day, so a statement alone sees about
 * four weeks ahead; with no provider history the remaining eleven months are
 * UNKNOWN, not empty, and every affected figure renders as "—" and says why.
 */

/** Colour by entity in a fixed order, so a rerender can never repaint a series. */
const BASIS_ORDER = ['declared', 'estimated']

const BASIS_SERIES: StackSeries[] = [
  { key: 'declared', name: 'Declared', color: seriesColor('declared', BASIS_ORDER) },
  { key: 'estimated', name: 'Estimated', color: seriesColor('estimated', BASIS_ORDER) },
]

/** Rows in the upcoming-payments table. Enough to plan a month or two ahead. */
const UPCOMING = 10

/** Donut slices before folding, mirrored by the list beneath it. */
const DONUT_SLICES = 6

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const QTY = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 4 })

/** Works for 'YYYY-MM' and 'YYYY-MM-DD' alike — both hold the month at 5..7. */
function monthShort(key: string): string {
  return MONTH_SHORT[Number(key.slice(5, 7)) - 1] ?? key
}

function monthLong(key: string): string {
  return `${monthShort(key)} ${key.slice(0, 4)}`
}

function dayLabel(iso: string): string {
  const day = Number(iso.slice(8, 10))
  return Number.isFinite(day) && day > 0 ? `${day} ${monthShort(iso)} ${iso.slice(0, 4)}` : iso
}

/** The figure the toggle asked for. Null means "no FX rate" — never zero. */
function baseAmount(item: ForecastItem, net: boolean): number | null {
  return net ? item.netBase : item.grossBase
}

/**
 * An estimate knows its month but not its day, so it sorts after the dated
 * accruals of that same month rather than inventing a date to sort by.
 */
function whenKey(item: ForecastItem): string {
  return item.payDate ?? `${item.month}-99`
}

function byWhen(a: ForecastItem, b: ForecastItem): number {
  const order = whenKey(a).localeCompare(whenKey(b))
  return order !== 0 ? order : (b.grossBase ?? 0) - (a.grossBase ?? 0)
}

function namesOf(keys: readonly string[], labelOf: (key: string) => string, max = 3): string {
  const shown = keys.slice(0, max).map(labelOf)
  const extra = keys.length - shown.length
  return extra > 0 ? `${shown.join(', ')} +${extra}` : shown.join(', ')
}

export function Forecast() {
  const view = usePortfolio()
  const { forecast, settings } = view
  const base = settings.baseCurrency
  const net = forecast.net
  const coverage = forecast.coverage

  // Symbols for the coverage lists, which carry instrument keys. Holdings win:
  // they hold the most recently seen ticker for the same instrument.
  const labelOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const instrument of view.instruments) map.set(instrument.key, instrument.symbol)
    for (const holding of view.portfolio.holdings) map.set(holding.instrumentKey, holding.symbol)
    return (key: string) => map.get(key) ?? key
  }, [view.instruments, view.portfolio])

  // Aggregations of the forecast module's OWN per-month figures — no metric is
  // redefined here, the totals are simply not exported at this granularity.
  const declaredTotal = useMemo(
    () => forecast.months.reduce((total, month) => total + month.declaredBase, 0),
    [forecast],
  )
  const estimatedTotal = useMemo(
    () => forecast.months.reduce((total, month) => total + month.estimatedBase, 0),
    [forecast],
  )

  const items = useMemo(() => forecast.months.flatMap((month) => month.items), [forecast])

  // The forecast anchors on the 1st of the current month so the total is stable
  // within a month, which means a declared accrual that already paid on the 3rd
  // is still in it. It belongs in the total; it does not belong under "next".
  const future = useMemo(
    () => items.filter((item) => item.payDate === null || item.payDate >= view.today),
    [items, view.today],
  )
  const upcoming = useMemo(() => [...future].sort(byWhen).slice(0, UPCOMING), [future])

  const chartData = useMemo(
    () =>
      forecast.months.map((month) => ({
        month: monthShort(month.month),
        declared: month.declaredBase,
        estimated: month.estimatedBase,
      })),
    [forecast],
  )

  // Per-instrument forward income comes from the yield set, which is built from
  // this very forecast upstream. Recomputing it here could only disagree.
  const concentration = useMemo(() => {
    const rows = view.yields.byInstrument
      .filter((row) => row.forwardIncomeBase > 0)
      .map((row) => ({ key: row.instrumentKey, name: labelOf(row.instrumentKey), value: row.forwardIncomeBase }))
      .sort((a, b) => b.value - a.value)
    return { rows, total: rows.reduce((sum, row) => sum + row.value, 0) }
  }, [view.yields, labelOf])

  if (view.loading) return <ForecastSkeleton />

  if (!view.hasData) {
    return (
      <NoData title="Nothing to project yet">
        Add an IBKR Activity Statement and Portly projects the next twelve months of income from
        your positions and declared accruals.
      </NoData>
    )
  }

  // No open positions AND nothing already declared. An accrual can outlive the
  // position that earned it, and that money is still coming, so the "nothing to
  // see" screen must not swallow it.
  if (coverage.positions === 0 && items.length === 0) {
    return (
      <Card title="Forecast">
        <EmptyState title="No open positions">
          Your statement has no open positions, so there is no future income to project. Import a
          more recent statement on the Data tab if that looks wrong.
        </EmptyState>
      </Card>
    )
  }

  // Zero estimated positions means no provider history at all: the twelve-month
  // number would be a four-week number wearing a year's label.
  const projected = coverage.estimated > 0

  /**
   * ...with one exception. A position whose profile is missing lands in
   * `coverage.missing`, and one visible only through an accrual in
   * `coverage.declaredOnly`. If both lists are empty and nothing landed in a
   * bucket, every open position HAS provider history and that history says it
   * does not distribute. Zero is then the answer, not the absence of one, and
   * "turn on market data" would be advice for a problem the user does not have.
   */
  const noDistributors =
    !projected &&
    items.length === 0 &&
    coverage.positions > 0 &&
    coverage.missing.length === 0 &&
    coverage.declaredOnly.length === 0

  // Both branches of "we can say something about the whole year".
  const known = projected || noDistributors

  /**
   * A total is a real zero only when there was nothing to add up. If items of
   * this basis exist but NONE of them converted to base, their `?? 0` sum is
   * zero-shaped and completely uninformative, so it renders as "—" and the
   * "No FX rate" badge below says why.
   */
  const totalOf = (basis: ForecastBasis, total: number): number | null => {
    const own = items.filter((item) => item.basis === basis)
    if (own.length === 0) return 0
    return own.some((item) => baseAmount(item, net) !== null) ? total : null
  }
  const declaredValue = totalOf('declared', declaredTotal)
  const estimatedValue = totalOf('estimated', estimatedTotal)

  const valued = items.some((item) => baseAmount(item, net) !== null)
  const heroValue = noDistributors ? 0 : projected && valued ? forecast.totalBase : null
  const window = `${monthLong(forecast.anchor)} – ${monthLong(forecast.end)}`

  /*
   * The two-column pair that used to sit at the bottom of this tab — a
   * `lg:grid-cols-2` grid holding Month by month, Next payments and Income
   * concentration — is gone, and Forecast is now single-column like the other
   * four tabs. That cost a little desktop density and bought three things.
   *
   * The first is that the bottom third stops being ONE end-aligned snap point.
   * `main > div > :last-child section` in index.css sets
   * `scroll-snap-align: none`, and with three real cards nested inside that
   * last child it was zeroing all three of them at once — so on a phone the
   * whole lower third of Forecast had a single resting position, and you could
   * not stop on Next payments at all. The second is that the three become
   * individually collapsible and re-orderable, which a card inside a grid
   * track cannot be. The third is that "every card is a direct child of the tab
   * root" becomes an invariant with no exceptions left, which is exactly what
   * the snap regression test asserts.
   */
  const cards: CardSpec[] = [
    card('forecast-hero', () => (
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Hero label="Projected income · next 12 months" value={heroValue} currency={base} />
          <Badge tone="muted">{net ? 'Net of withholding' : 'Gross of withholding'}</Badge>
        </div>
        <p className="text-sm text-muted mt-2">
          {heroValue === null ? (
            <>A full year cannot be projected from what is loaded — see below.</>
          ) : noDistributors ? (
            <>None of your open positions distribute, so {window} is genuinely empty.</>
          ) : (
            <>
              Averages <Money value={heroValue / 12} currency={base} className="text-ink" /> a month
              over {window}, though the months are nowhere near even.
            </>
          )}
        </p>
      </Card>
    )),
    card('forecast-split', () => (
      <div className="grid grid-cols-2 gap-3">
        <StatTile
          label="Declared"
          value={<Money value={declaredValue} currency={base} />}
          hint="Open accruals — about four weeks out"
        />
        <StatTile
          label="Estimated"
          value={<Money value={known ? estimatedValue : null} currency={base} />}
          hint={
            projected
              ? `${coverage.estimated} of ${coverage.positions} positions`
              : noDistributors
                ? 'No distributing holdings'
                : 'Needs market data'
          }
        />
      </div>
    )),
    card('forecast-coverage', () => (
      <CoverageNote
        coverage={coverage}
        declared={declaredValue}
        estimated={estimatedValue}
        currency={base}
        projected={projected}
        noDistributors={noDistributors}
        marketDataOn={settings.enableMarketData}
        unpriced={view.portfolio.unpriced.length}
        labelOf={labelOf}
      />
    )),
    card('forecast-by-month', () => (
      <Card title="Projected income by month" subtitle={window}>
        {items.length === 0 ? (
          <p className="text-sm text-muted">
            {noDistributors
              ? 'Nothing to plot: none of your open positions pay a distribution.'
              : 'Nothing to plot yet: no open accruals and no dividend history for these holdings.'}
          </p>
        ) : (
          <>
            <Columns
              data={chartData}
              xKey="month"
              series={BASIS_SERIES}
              format={(value) => formatMoney(value, base, { dp: 0, compact: true })}
            />
            <p className="text-xs text-muted mt-3">
              Distributions are seasonal. Many UCITS ETFs pay most of the year in one or two months,
              so a quiet month here is the shape of the funds you hold, not missing data.
            </p>
          </>
        )}
      </Card>
    )),
    card('forecast-months', () => (
      <Card title="Month by month" subtitle="Tap a month for the payments behind it">
        <MonthList months={forecast.months} currency={base} net={net} projected={known} />
      </Card>
    )),
    card('forecast-upcoming', () => (
      <Card
        title="Next payments"
        subtitle={
          future.length > upcoming.length ? `Soonest ${upcoming.length} of ${future.length}` : undefined
        }
      >
        <UpcomingPayments items={upcoming} currency={base} net={net} />
      </Card>
    )),
    card('forecast-concentration', () => (
      <Card
        title="Income concentration"
        subtitle={
          projected
            ? 'Share of the projected 12 months by holding'
            : 'Share of the declared accruals only — not yet a full year'
        }
      >
        <Concentration rows={concentration.rows} total={concentration.total} currency={base} />
      </Card>
    )),
  ]

  return <CardStack tab="forecast" cards={cards} />
}

// ─────────────────────────────────────────────────────────────────────────────
// Honesty banner
// ─────────────────────────────────────────────────────────────────────────────

function CoverageNote({
  coverage,
  declared,
  estimated,
  currency,
  projected,
  noDistributors,
  marketDataOn,
  unpriced,
  labelOf,
}: {
  coverage: ForecastCoverage
  /** Null when items of that basis exist but none converted to base. */
  declared: number | null
  estimated: number | null
  currency: Currency
  projected: boolean
  noDistributors: boolean
  marketDataOn: boolean
  unpriced: number
  labelOf: (key: string) => string
}) {
  const known = projected || noDistributors
  const hasDeclared = declared !== null && declared > 0
  // A share of the split only means anything when BOTH halves are known.
  const total = declared !== null && estimated !== null ? declared + estimated : null
  const declaredPct = total !== null && total > 0 && declared !== null ? (declared / total) * 100 : null

  return (
    <div
      className={`rounded-xl border p-3 sm:p-4 ${
        known ? 'border-border bg-surface' : 'border-warn/40 bg-warn/10'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={known ? 'muted' : 'warn'}>
          {projected
            ? hasDeclared
              ? 'Part declared, part estimated'
              : 'Estimated'
            : noDistributors
              ? 'Nothing to distribute'
              : 'Declared only'}
        </Badge>
        {coverage.positions > 0 && (
          <span className="text-xs text-muted">
            {noDistributors
              ? `None of your ${coverage.positions} open positions pay a distribution`
              : `${coverage.estimated} of ${coverage.positions} positions have dividend history`}
          </span>
        )}
      </div>

      <p className="text-sm text-muted mt-2">
        {projected ? (
          <>
            {hasDeclared ? (
              <>
                <Money value={declared} currency={currency} className="text-ink" />
                {declaredPct !== null && <> ({formatPct(declaredPct, 0, false)})</>} of the
                projection is <strong className="font-medium text-ink">declared</strong> — real
                accruals from your statement, exact to the cent. The remaining{' '}
                <Money value={estimated} currency={currency} className="text-ink" /> is{' '}
              </>
            ) : (
              <>
                No accrual is open right now, so the whole{' '}
                <Money value={estimated} currency={currency} className="text-ink" /> is{' '}
              </>
            )}
            <strong className="font-medium text-ink">estimated</strong> from each holding’s last
            twelve months of distributions at today’s share count. IBKR posts an accrual the day
            before the ex-date, so declared figures never reach more than about four weeks out.
          </>
        ) : noDistributors ? (
          <>
            Every open position has dividend history, and none of it shows a payment — these are
            accumulating funds, so the year ahead is{' '}
            <strong className="font-medium text-ink">zero, not unknown</strong>. Accumulating ETFs
            reinvest their income inside the fund; it shows up in the price, not as cash.
          </>
        ) : (
          <>
            Only declared accruals are available, and IBKR posts an accrual the day before the
            ex-date — so this covers roughly the next four weeks. The other eleven months are{' '}
            <strong className="font-medium text-ink">unknown, not zero</strong>.{' '}
            {marketDataOn
              ? 'No dividend history could be fetched for these holdings; a refresh on the Data tab may fix it.'
              : 'Turn on market data to project the full year.'}
          </>
        )}
      </p>

      {!known && (
        <a
          href="#/data"
          className="inline-flex items-center justify-center min-h-[44px] mt-2 px-4 rounded-lg bg-accent text-white text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Open the Data tab
        </a>
      )}

      {(coverage.missing.length > 0 ||
        coverage.declaredOnly.length > 0 ||
        coverage.staleHistory.length > 0 ||
        coverage.missingFx.length > 0) && (
        <ul className="flex flex-wrap gap-2 mt-3">
          {coverage.missing.length > 0 && (
            <li>
              <Badge tone="warn">Not in the total: {namesOf(coverage.missing, labelOf)}</Badge>
            </li>
          )}
          {coverage.declaredOnly.length > 0 && (
            <li>
              <Badge tone="warn">Accrual only: {namesOf(coverage.declaredOnly, labelOf)}</Badge>
            </li>
          )}
          {coverage.staleHistory.length > 0 && (
            <li>
              <Badge tone="warn">History over a year old: {namesOf(coverage.staleHistory, labelOf)}</Badge>
            </li>
          )}
          {coverage.missingFx.length > 0 && (
            <li>
              <Badge tone="serious">No FX rate: {namesOf(coverage.missingFx, labelOf)}</Badge>
            </li>
          )}
        </ul>
      )}

      {unpriced > 0 && (
        <p className="text-xs text-muted mt-3">
          {unpriced} holding{unpriced === 1 ? ' has' : 's have'} no current price. That does not
          affect this screen — projected income is per-share income times shares held, not a
          function of price.
        </p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Month detail
// ─────────────────────────────────────────────────────────────────────────────

function MonthList({
  months,
  currency,
  net,
  projected,
}: {
  months: readonly ForecastMonth[]
  currency: Currency
  net: boolean
  projected: boolean
}) {
  // Open the first month that actually has something in it, so the pattern is
  // visible without a tap — an accordion of twelve closed rows teaches nothing.
  const [open, setOpen] = useState<string | null>(
    () => months.find((month) => month.items.length > 0)?.month ?? null,
  )
  const idBase = useId()

  return (
    <ul className="divide-y divide-border">
      {months.map((month) => (
        <MonthRow
          key={month.month}
          month={month}
          currency={currency}
          net={net}
          projected={projected}
          id={`${idBase}-${month.month}`}
          expanded={open === month.month}
          onToggle={() => setOpen(open === month.month ? null : month.month)}
        />
      ))}
    </ul>
  )
}

function MonthRow({
  month,
  currency,
  net,
  projected,
  id,
  expanded,
  onToggle,
}: {
  month: ForecastMonth
  currency: Currency
  net: boolean
  projected: boolean
  id: string
  expanded: boolean
  onToggle: () => void
}) {
  if (month.items.length === 0) {
    return (
      <li className="flex items-center justify-between gap-3 py-3 min-h-[44px]">
        <h3 className="text-sm text-muted">{monthLong(month.month)}</h3>
        {/* Nothing expected is a fact; not projected is an absence of one. */}
        <span className="text-xs text-muted">
          {projected ? 'None expected' : 'Not projected'}
        </span>
      </li>
    )
  }

  const declared = month.items.filter((item) => item.basis === 'declared').length
  const estimated = month.items.length - declared
  const composition = [
    declared > 0 ? `${declared} declared` : null,
    estimated > 0 ? `${estimated} estimated` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')

  return (
    <li>
      <h3>
        <button
          type="button"
          id={`${id}-button`}
          aria-expanded={expanded}
          aria-controls={`${id}-panel`}
          onClick={onToggle}
          className="w-full flex items-center gap-3 py-3 min-h-[44px] text-left rounded-lg hover:bg-white/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Chevron expanded={expanded} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{monthLong(month.month)}</span>
            <span className="block text-xs text-muted">{composition}</span>
          </span>
          {/* The month totals sum unconvertible items as zero. If NOTHING in
              the month converted, that zero is not a figure — show "—". */}
          <Money
            value={
              month.items.some((item) => baseAmount(item, net) !== null)
                ? net
                  ? month.netBase
                  : month.grossBase
                : null
            }
            currency={currency}
            className="text-sm font-medium"
          />
        </button>
      </h3>
      {expanded && (
        <div
          id={`${id}-panel`}
          role="region"
          aria-labelledby={`${id}-button`}
          className="pb-3 pl-7 space-y-3"
        >
          {month.items.map((item, i) => (
            <ItemLine key={`${item.instrumentKey}|${item.basis}|${i}`} item={item} currency={currency} net={net} />
          ))}
        </div>
      )}
    </li>
  )
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

/** One forecast item, used in the month panels and in the mobile payment list. */
function ItemLine({
  item,
  currency,
  net,
}: {
  item: ForecastItem
  currency: Currency
  net: boolean
}) {
  const amount = baseAmount(item, net)
  const native = net ? item.net : item.gross
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate">{item.symbol}</span>
          <BasisBadge basis={item.basis} />
        </div>
        <div className="text-xs text-muted mt-0.5 break-words">
          {item.payDate === null ? `Expected in ${monthLong(item.month)}` : `Pays ${dayLabel(item.payDate)}`}
          {item.perShare !== null && (
            <>
              {' · '}
              {/* `perShare` is the GROSS rate on both bases, so in net mode the
                  multiplication would not reconcile with the amount beside it
                  unless it says which figure it is. */}
              {formatMoney(item.perShare, item.currency, { dp: 4 })} × {QTY.format(item.quantity)}
              {net ? ' gross' : ''}
            </>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <Money value={amount} currency={currency} className="text-sm" />
        {item.currency !== currency && (
          <div className="num text-[11px] text-muted">{formatMoney(native, item.currency)}</div>
        )}
      </div>
    </div>
  )
}

function BasisBadge({ basis }: { basis: ForecastBasis }) {
  return basis === 'declared' ? (
    <Badge tone="good">Declared</Badge>
  ) : (
    <Badge tone="muted">Estimated</Badge>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Upcoming payments
// ─────────────────────────────────────────────────────────────────────────────

function UpcomingPayments({
  items,
  currency,
  net,
}: {
  items: readonly ForecastItem[]
  currency: Currency
  net: boolean
}) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted">
        Nothing further is expected between today and the end of the window.
      </p>
    )
  }

  return (
    <>
      {/* Below sm the same rows stack as cards. Both trees are display:none at
          the other breakpoint, so assistive tech only ever sees one of them. */}
      <ul className="sm:hidden divide-y divide-border">
        {items.map((item, i) => (
          <li key={`${item.instrumentKey}|${whenKey(item)}|${i}`} className="py-3">
            <ItemLine item={item} currency={currency} net={net} />
          </li>
        ))}
      </ul>

      <div className="hidden sm:block">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Next {items.length} expected dividend payments, soonest first
          </caption>
          <thead>
            <tr className="text-xs text-muted">
              <th scope="col" className="text-left font-normal pb-2">Pay date</th>
              <th scope="col" className="text-left font-normal pb-2">Symbol</th>
              <th scope="col" className="text-left font-normal pb-2">Basis</th>
              <th scope="col" className="text-right font-normal pb-2">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((item, i) => (
              <tr key={`${item.instrumentKey}|${whenKey(item)}|${i}`}>
                {/* nowrap on each fragment, not the cell: at ~640px the two
                    halves must be allowed to break onto separate lines rather
                    than push the table past the viewport. */}
                <td className="py-2.5 pr-3">
                  {item.payDate === null ? (
                    <>
                      <span className="whitespace-nowrap">{monthLong(item.month)}</span>{' '}
                      <span className="text-muted text-xs whitespace-nowrap">· day TBC</span>
                    </>
                  ) : (
                    <span className="whitespace-nowrap">{dayLabel(item.payDate)}</span>
                  )}
                </td>
                <th scope="row" className="py-2.5 pr-3 text-left font-medium break-words">
                  {item.symbol}
                </th>
                <td className="py-2.5 pr-3">
                  <BasisBadge basis={item.basis} />
                </td>
                <td className="py-2.5 text-right">
                  <Money value={baseAmount(item, net)} currency={currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Income concentration
// ─────────────────────────────────────────────────────────────────────────────

function Concentration({
  rows,
  total,
  currency,
}: {
  rows: readonly { key: string; name: string; value: number }[]
  total: number
  currency: Currency
}) {
  if (rows.length === 0 || total <= 0) {
    return (
      <p className="text-sm text-muted">
        No projected income to split yet, so there is nothing to concentrate.
      </p>
    )
  }

  const head = rows.slice(0, DONUT_SLICES)
  const tail = rows.slice(DONUT_SLICES)
  const tailValue = tail.reduce((sum, row) => sum + row.value, 0)
  const top = head[0]

  return (
    <>
      <Donut
        data={rows.map((row) => ({ key: row.key, name: row.name, value: row.value }))}
        maxSlices={DONUT_SLICES}
        height={260}
        format={(value) => formatMoney(value, currency, { dp: 0, compact: true })}
      />
      {/* The donut needs a hover to give a number; this list gives the same
          numbers at rest, which is the only version a touch screen gets. */}
      <ul className="mt-2 divide-y divide-border">
        {head.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="truncate">{row.name}</span>
            <span className="shrink-0 num text-muted">
              {formatMoney(row.value, currency)} · {formatPct((row.value / total) * 100, 1, false)}
            </span>
          </li>
        ))}
        {tail.length > 0 && (
          <li className="flex items-center justify-between gap-3 py-2 text-sm text-muted">
            <span className="truncate">Other ({tail.length})</span>
            <span className="shrink-0 num">
              {formatMoney(tailValue, currency)} · {formatPct((tailValue / total) * 100, 1, false)}
            </span>
          </li>
        )}
      </ul>
      {top && (
        <p className="text-xs text-muted mt-2">
          {top.name} alone pays {formatPct((top.value / total) * 100, 0, false)} of the{' '}
          <Money value={total} currency={currency} className="text-ink" /> above, across{' '}
          {rows.length} paying holding{rows.length === 1 ? '' : 's'}.
        </p>
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

function ForecastSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <span className="sr-only">Loading forecast</span>
      <div className="h-28 rounded-xl border border-border bg-surface animate-pulse" />
      <div className="grid grid-cols-2 gap-3">
        <div className="h-20 rounded-xl border border-border bg-surface animate-pulse" />
        <div className="h-20 rounded-xl border border-border bg-surface animate-pulse" />
      </div>
      <div className="h-72 rounded-xl border border-border bg-surface animate-pulse" />
    </div>
  )
}
