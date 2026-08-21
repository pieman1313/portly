import { useMemo, useState } from 'react'
import {
  Badge,
  Card,
  EmptyState,
  Hero,
  Money,
  Pct,
  StatTile,
  Toggle,
  formatMoney,
  formatPct,
} from '../components/primitives'
import { Columns, Donut, seriesColor } from '../components/charts'
import { usePortfolio } from '../usePortfolio'
import { sum, sumBy } from '../../metrics/money'
import { isExternalFlow } from '../../metrics/returns'
import type { Holding } from '../../metrics/holdings'
import type { Currency } from '../../domain/types'

/**
 * Overview — "how am I doing", answered above the fold.
 *
 * Every figure here is read from `usePortfolio()`. The only arithmetic in this
 * file is grouping already-computed per-holding numbers into allocation slices;
 * nothing is re-derived, so this screen cannot disagree with Holdings or Income.
 *
 * The recurring judgement call is zero versus unknown. An unpriced holding, a
 * portfolio with no dividend history and an account with no deposit rows all
 * produce a legitimate-looking 0 from the maths, and rendering that 0 tells the
 * user something false. Each of those cases is narrowed to null so the
 * primitives render an em dash, and the data-quality strip explains why.
 */

type Grouping = 'holding' | 'currency' | 'category'

const GROUPINGS: { value: Grouping; label: string }[] = [
  { value: 'holding', label: 'Holding' },
  { value: 'currency', label: 'Currency' },
  { value: 'category', label: 'Category' },
]

const GROUP_NOUN: Record<Grouping, string> = {
  holding: 'holding',
  currency: 'currency',
  category: 'asset category',
}

/**
 * Mirrors the donut's own fold so the list beside it names exactly the slices
 * that were drawn. Passed to `Donut` explicitly rather than relying on its
 * default, because the two must move together.
 *
 * The kit caps all-pairs-adjacent forms at three hues. Eight is defensible here
 * only because colour is NOT the identity channel on this card: every drawn
 * slice also appears in the list beside it, named, with its value and weight,
 * and the swatch is redundant reinforcement. Drop to three the moment that list
 * is removed.
 */
const MAX_SLICES = 8

export function Overview() {
  const view = usePortfolio()
  // Currency, not holding: the fixed donut above already answers "by holding",
  // so the toggle opens on the view that adds something.
  const [grouping, setGrouping] = useState<Grouping>('currency')

  const { portfolio, yields, forecast, settings } = view
  const base = settings.baseCurrency

  const byHolding = useMemo(() => allocate(portfolio.holdings, 'holding'), [portfolio.holdings])
  const grouped = useMemo(() => allocate(portfolio.holdings, grouping), [portfolio.holdings, grouping])
  const monthly = useMemo(() => view.incomeBy('month'), [view])

  const open = portfolio.holdings.filter((h) => !h.excluded && !h.closed)
  const valued = open.filter((h) => h.marketValueBase !== null)
  // An all-unpriced portfolio totals zero. That is an absence of prices, not an
  // empty account — but a fully sold-out account really is worth nothing.
  const valueKnown = open.length === 0 || valued.length > 0
  // Same symptom, two different cures: a missing price is fixed on Holdings, a
  // missing rate on Data. Saying "no price" when every price is present and it
  // is the FX leg that failed sends the user to the wrong screen.
  const blockedByFx = !valueKnown && portfolio.missingFx.length > 0

  const cashFlows = view.cashEvents.filter((c) => isExternalFlow(c.kind))
  const investedKnown = cashFlows.length > 0

  // Forward income of zero is only true if we looked. With no provider profile
  // and no open accrual for a position, we have not looked.
  const forecastHasItems = forecast.months.some((m) => m.items.length > 0)
  const forwardKnown = forecastHasItems || forecast.coverage.missing.length === 0
  const forwardIncome = forwardKnown ? yields.forwardIncomeBase : null
  const forwardYield = forwardKnown ? yields.forwardYieldExCashPct : null
  const yieldOnCost = forwardKnown ? yields.yieldOnCostPct : null

  const last12 = monthly.slice(-12)
  const chartData = last12.map((b) => ({ month: shortMonth(b.key), amount: b.amount }))
  const firstBucket = last12[0]
  const lastBucket = last12[last12.length - 1]

  const issues = collectIssues(view, monthly)
  const statementPrices = snapshotNote(open, portfolio.asOf)

  if (view.loading) return <Skeleton />

  if (!view.hasData) {
    return (
      <>
        <h1 className="sr-only">Overview</h1>
        <EmptyState
          title="No statements imported yet"
          action={
            <a
              href="#/data"
              className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-lg bg-accent text-white text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
            >
              Go to the Data tab
            </a>
          }
        >
          Import an Interactive Brokers Activity Statement CSV and Portly works out what the
          portfolio is worth, what it has paid you and what the next twelve months should pay.
          Everything stays on this device.
        </EmptyState>
      </>
    )
  }

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Overview</h1>
      <Card>
        <Hero
          label={`Portfolio value (${base})`}
          value={valueKnown ? portfolio.marketValueBase : null}
          delta={valueKnown ? view.totalPnlBase : null}
          deltaPct={valueKnown ? view.totalPnlPct : null}
          currency={base}
        />
        <p className="text-xs text-muted mt-2">
          {valueKnown
            ? `Securities only — cash balances are not counted. Profit is unrealised plus realised plus dividends received, against the cost of shares still held.`
            : blockedByFx
              ? `No open position could be converted to ${base}, so the total cannot be worked out. Refresh FX rates on the Data tab.`
              : 'No open position has a usable price yet, so the total cannot be worked out. Refresh market data, or set a price on the Holdings tab.'}
        </p>
        {/* Said once, near the number it qualifies, rather than badged per row. */}
        {statementPrices !== null && (
          <p className="text-xs text-muted mt-1">{statementPrices}</p>
        )}
      </Card>

      <section aria-labelledby="ov-figures">
        <h2 id="ov-figures" className="sr-only">
          Key figures
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile
            label="Passive income"
            value={formatPct(forwardYield, 2, false)}
            hint={forwardKnown ? 'next 12m ÷ value' : 'needs dividend data'}
          />
          <StatTile
            label="Forward income"
            value={<Money value={forwardIncome} currency={base} dp={0} />}
            hint={
              forwardIncome === null
                ? 'needs dividend data'
                : `next 12m, ≈ ${formatMoney(forwardIncome / 12, base, { dp: 0 })}/mo`
            }
          />
          <StatTile
            label="Yield on cost"
            value={formatPct(yieldOnCost, 2, false)}
            hint={forwardKnown ? 'next 12m ÷ cost' : 'needs dividend data'}
          />
          <StatTile
            label="XIRR"
            value={<Pct value={view.xirrPct} />}
            hint={
              view.xirrPct !== null
                ? 'money-weighted'
                : !investedKnown
                  ? 'needs deposit history'
                  : !valueKnown
                    ? 'needs a current value'
                    : 'needs 90+ days'
            }
          />
          <StatTile
            label="Invested"
            value={<Money value={investedKnown ? view.investedBase : null} currency={base} dp={0} />}
            hint={investedKnown ? 'net deposits' : 'no deposits recorded'}
          />
          <StatTile
            label="Dividends received"
            value={<Money value={view.totalDividendsBase} currency={base} dp={0} />}
            hint={view.distributions.length > 0 ? 'all time' : 'none recorded yet'}
          />
        </div>
        {/* Said once for the four dividend figures above rather than crammed
            into four truncating hints. */}
        <p className="text-xs text-muted mt-2">
          All amounts in {base}. Dividend figures are{' '}
          {settings.showNetDividends ? 'net of withholding tax' : 'gross, before withholding tax'}.
        </p>
      </section>

      <Card
        title="Allocation by holding"
        subtitle={`Share of ${base} market value · open, priced positions only`}
      >
        <Allocation slices={byHolding} currency={base} label="Allocation by holding" />
      </Card>

      <Card
        title={`Allocation by ${GROUP_NOUN[grouping]}`}
        subtitle={`Share of ${base} market value · open, priced positions only`}
      >
        {/* The kit's Toggle buttons are min-h-[32px], under the 44px touch
            minimum. Raising them here rather than in primitives.tsx because
            that file is owned elsewhere; the arbitrary variant only reaches the
            buttons inside this wrapper. */}
        <div className="mb-3 [&>div]:flex-wrap [&_button]:min-h-[44px]">
          <Toggle
            label="Group by"
            options={GROUPINGS}
            value={grouping}
            onChange={(v) => setGrouping(asGrouping(v))}
          />
        </div>
        <Allocation
          slices={grouped}
          currency={base}
          label={`Allocation by ${GROUP_NOUN[grouping]}`}
        />
      </Card>

      <Card
        title="Dividends received"
        subtitle={
          firstBucket && lastBucket
            ? `${longMonth(firstBucket.key)} – ${longMonth(lastBucket.key)} · ${base} · ${
                settings.showNetDividends ? 'net of withholding' : 'gross'
              } · regular payments only, so the total above can be higher`
            : undefined
        }
      >
        {chartData.length === 0 ? (
          <p className="text-sm text-muted">
            No dividends have been paid into the account yet. They appear here as soon as a
            statement covering a payment is imported.
          </p>
        ) : (
          <>
            <p className="sr-only">
              Monthly bar chart of dividends received, one bar per month. Per-payment detail is on
              the Income tab.
            </p>
            <Columns
              data={chartData}
              xKey="month"
              stacked={false}
              height={220}
              format={(v) => formatMoney(v, base, { dp: 0, compact: true })}
              series={[
                {
                  key: 'amount',
                  name: 'Dividends received',
                  color: seriesColor('dividends', ['dividends']),
                },
              ]}
            />
          </>
        )}
      </Card>

      {issues.length > 0 && (
        <Card title="Data quality" subtitle="What is missing, and what it does to the numbers above">
          <ul className="space-y-2.5">
            {issues.map((issue) => (
              <li key={issue.badge} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Badge tone={issue.tone}>{issue.badge}</Badge>
                <span className="text-xs text-muted flex-1 min-w-[12rem]">{issue.text}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Allocation
// ─────────────────────────────────────────────────────────────────────────────

interface Slice {
  key: string
  name: string
  value: number
  /** Sum of the members' own `weightPct`. Null if any member's is unknown. */
  weightPct: number | null
}

/**
 * Group open, priced positions into donut slices.
 *
 * Weights are summed from each holding's `weightPct` rather than recomputed
 * against a denominator of this file's own choosing — that keeps every
 * grouping consistent with the by-holding view and with the Holdings tab.
 */
function allocate(holdings: readonly Holding[], by: Grouping): Slice[] {
  const groups = new Map<string, { name: string; values: number[]; weights: (number | null)[] }>()
  for (const h of holdings) {
    // Closed positions have no weight, and unpriced ones would be drawn as a
    // zero-width slice that silently understates everything beside it.
    if (h.excluded || h.closed) continue
    const value = h.marketValueBase
    if (value === null || !(value > 0)) continue

    const key = by === 'currency' ? h.currency : by === 'category' ? h.assetCategory : h.instrumentKey
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, {
        name: by === 'holding' ? h.symbol : key,
        values: [value],
        weights: [h.weightPct],
      })
    } else {
      group.values.push(value)
      group.weights.push(h.weightPct)
    }
  }

  return [...groups.entries()].map(([key, g]) => ({
    key,
    name: g.name,
    value: sum(g.values),
    weightPct: g.weights.some((w) => w === null)
      ? null
      : sum(g.weights.filter((w): w is number => w !== null)),
  }))
}

/**
 * Donut plus a text list of the same slices. The list is the accessible and
 * touch-friendly channel: no tooltip is needed to read a value or a weight,
 * and it survives at 360px where slice geometry alone does not.
 */
function Allocation({
  slices,
  currency,
  label,
}: {
  slices: Slice[]
  currency: Currency
  label: string
}) {
  const sorted = [...slices].sort((a, b) => b.value - a.value)
  const head = sorted.slice(0, MAX_SLICES)
  const tail = sorted.slice(MAX_SLICES)
  const order = head.map((s) => s.key)

  if (sorted.length === 0) {
    return (
      <p className="text-sm text-muted">
        Nothing to allocate: no open position currently has a usable price.
      </p>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2 lg:items-center">
      {/* min-w-0: a grid item defaults to min-width:auto, which lets the chart's
          measured width ratchet the track wider than 360px and never shrink back. */}
      <div className="min-w-0">
        <Donut
          data={sorted}
          maxSlices={MAX_SLICES}
          format={(v) => formatMoney(v, currency, { dp: 0 })}
        />
      </div>
      <ul className="text-sm divide-y divide-border min-w-0" aria-label={`${label}, largest first`}>
        {head.map((s) => (
          <li key={s.key} className="flex items-center gap-2 py-1.5">
            <span
              aria-hidden
              className="w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ background: seriesColor(s.key, order) }}
            />
            <span className="truncate min-w-0">{s.name}</span>
            <Money value={s.value} currency={currency} dp={0} className="ml-auto shrink-0" />
            <span className="num text-muted w-14 text-right shrink-0">
              {formatPct(s.weightPct, 1, false)}
            </span>
          </li>
        ))}
        {tail.length > 0 && (
          <li className="flex items-center gap-2 py-1.5 text-muted">
            {/* No swatch: the donut folds these into one grey "Other" slice. */}
            <span aria-hidden className="w-2.5 shrink-0" />
            <span className="truncate min-w-0">Other ({tail.length} smaller)</span>
            <Money
              value={sum(tail.map((s) => s.value))}
              currency={currency}
              dp={0}
              className="ml-auto shrink-0"
            />
            <span className="num w-14 text-right shrink-0">
              {formatPct(
                tail.some((s) => s.weightPct === null)
                  ? null
                  : sum(tail.map((s) => s.weightPct ?? 0)),
                1,
                false,
              )}
            </span>
          </li>
        )}
      </ul>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Data quality
// ─────────────────────────────────────────────────────────────────────────────

interface Issue {
  tone: 'warn' | 'serious' | 'crit' | 'muted'
  badge: string
  text: string
}

/**
 * Only things that change how the numbers above should be read. Each one says
 * what it does to them, because "2 unpriced" on its own is not actionable.
 */
function collectIssues(
  view: ReturnType<typeof usePortfolio>,
  monthly: ReturnType<ReturnType<typeof usePortfolio>['incomeBy']>,
): Issue[] {
  const { portfolio, forecast, settings } = view
  const base = settings.baseCurrency
  const issues: Issue[] = []

  if (portfolio.discrepancies.length > 0) {
    const n = portfolio.discrepancies.length
    issues.push({
      tone: 'crit',
      badge: `${n} quantity mismatch${n === 1 ? '' : 'es'}`,
      text: `The trade ledger disagrees with the broker's own position report, so quantities and value may be wrong. A statement covering the missing trades is probably not imported.`,
    })
  }

  if (portfolio.missingFx.length > 0) {
    const n = portfolio.missingFx.length
    issues.push({
      tone: 'serious',
      badge: `${n} without an FX rate`,
      text: `${n === 1 ? 'One holding' : `${n} holdings`} could not be converted to ${base} and ${
        n === 1 ? 'is' : 'are'
      } missing from the total, the profit figure and every weight.`,
    })
  }

  if (portfolio.unpriced.length > 0) {
    const n = portfolio.unpriced.length
    issues.push({
      tone: 'warn',
      badge: `${n} unpriced`,
      text: `${n === 1 ? 'One holding has' : `${n} holdings have`} no price, so total value is understated and the allocation leaves ${
        n === 1 ? 'it' : 'them'
      } out.`,
    })
  }

  const dividendFxGaps = sumBy(monthly, (b) => b.missingFx)
  if (dividendFxGaps > 0) {
    issues.push({
      tone: 'warn',
      badge: `${dividendFxGaps} payment${dividendFxGaps === 1 ? '' : 's'} unconverted`,
      text: `No ${base} rate was available on the pay date, so dividends received are understated by ${
        dividendFxGaps === 1 ? 'that payment' : 'those payments'
      }.`,
    })
  }

  const coverage = forecast.coverage
  if (coverage.missing.length > 0) {
    const n = coverage.missing.length
    issues.push({
      tone: 'warn',
      badge: `${n} without dividend history`,
      text: `Forward income, passive income % and yield on cost exclude ${
        n === 1 ? 'this position' : 'these positions'
      }. Refresh market data on the Data tab to fill the gap.`,
    })
  } else if (coverage.positions > 0 && coverage.ratio === 0) {
    issues.push({
      tone: 'muted',
      badge: 'Declared only',
      text: `Forward income counts declared accruals only — roughly four weeks of visibility, not a full year.`,
    })
  }

  if (coverage.staleHistory.length > 0) {
    const n = coverage.staleHistory.length
    issues.push({
      tone: 'warn',
      badge: `${n} stale dividend history`,
      text: `The most recent payment history for ${
        n === 1 ? 'one position' : `${n} positions`
      } is over a year old, so its share of the forecast is a guess from old data.`,
    })
  }

  return issues
}

// ─────────────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────────────

/** Non-null only when there is something to disclose. */
function snapshotNote(open: readonly Holding[], asOf: string): string | null {
  const priced = open.filter((h) => h.priceSource !== null)
  const fromStatement = priced.filter((h) => h.priceSource === 'snapshot')
  if (fromStatement.length === 0) return null
  const when = longDay(asOf)
  return fromStatement.length === priced.length
    ? `Valued at the statement's closing prices${when === null ? '' : ` (${when})`}.`
    : `${fromStatement.length} of ${priced.length} holdings valued at the statement's closing prices${
        when === null ? '' : ` (${when})`
      }.`
}

function Skeleton() {
  const block = 'rounded-xl bg-surface border border-border animate-pulse'
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only">Loading your portfolio</span>
      <div className={`h-28 ${block}`} />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className={`h-[4.5rem] ${block}`} />
        ))}
      </div>
      <div className={`h-72 ${block}`} />
      <div className={`h-64 ${block}`} />
    </div>
  )
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

function monthName(mm: string): string | null {
  const n = Number(mm)
  return Number.isInteger(n) ? MONTH_NAMES[n - 1] ?? null : null
}

/** 'YYYY-MM' -> 'Aug'. Unique inside a 12-bucket window, so no year needed. */
function shortMonth(key: string): string {
  return monthName(key.slice(5, 7)) ?? key
}

/** 'YYYY-MM' -> 'Aug 2025'. */
function longMonth(key: string): string {
  const name = monthName(key.slice(5, 7))
  return name === null ? key : `${name} ${key.slice(0, 4)}`
}

/** 'YYYY-MM-DD' -> '31 Jul 2025'. Null rather than a mangled date. */
function longDay(date: string): string | null {
  const name = monthName(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  if (name === null || !Number.isInteger(day) || day < 1) return null
  return `${day} ${name} ${date.slice(0, 4)}`
}

function asGrouping(value: string): Grouping {
  return value === 'currency' || value === 'category' ? value : 'holding'
}
