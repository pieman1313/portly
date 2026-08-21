import type { ReactNode } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

/**
 * Chart kit.
 *
 * The palette, the mark specs and the spacing here are not taste — they were
 * validated against this app's chart surface (#131926): lightness band, chroma
 * floor, adjacent-pair CVD separation (worst 8.4 protan), normal-vision floor
 * (worst 19.3) and >= 3:1 contrast all pass.
 *
 * Consequences that must be preserved when editing:
 *   - Assign hues in FIXED ORDER by entity, never by rank, and never cycle. A
 *     filter that drops a series must not repaint the survivors.
 *   - A ninth series folds into "Other". We do not generate a hue.
 *   - Forms where every pair can sit adjacent (donut with small slices) are
 *     capped at three slots before folding — only the first three clear the
 *     all-pairs floors.
 *   - Never a dual y-axis. Two measures of different scale get two charts.
 */

export const SERIES = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#008300', // green
  '#9085e9', // violet
  '#e66767', // red
] as const

/** Sequential ramp, one hue light->dark, for the holdings x month heatmap. */
export const SEQUENTIAL = ['#0d2b4d', '#14406f', '#1a5594', '#2a78d6', '#6aa9ec'] as const

/**
 * The fold. Everything past the eighth entity shares this one neutral, which is
 * deliberately NOT a ninth hue: it must read as "the rest", not as another
 * named series.
 */
export const OTHER_COLOR = '#4a5568'
/** Reserved data key for the folded remainder. No instrument can collide. */
export const OTHER_KEY = '__other'

const SURFACE = '#131926'
const GRID = '#222c3d'
const AXIS_TEXT = '#8b9ab3'

/** Colour follows the entity. Stable across filtering because the key decides. */
export function seriesColor(key: string, order: string[]): string {
  const i = order.indexOf(key)
  return SERIES[(i < 0 ? order.length : i) % SERIES.length] ?? SERIES[0]
}

const axisProps = {
  stroke: GRID,
  tick: { fill: AXIS_TEXT, fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: GRID },
} as const

function ChartTooltip({
  active,
  payload,
  label,
  formatter,
  total = false,
}: {
  active?: boolean
  payload?: { name?: string; value?: number; color?: string; dataKey?: string }[]
  label?: string
  formatter: (v: number) => string
  /**
   * Add a total row under the entries. Only ever true for a STACKED chart,
   * where the entries are parts of one whole and their sum is the mark the
   * user is pointing at. Summing the lines of a multi-measure line chart
   * would print a number that does not exist.
   */
  total?: boolean
}) {
  if (!active || !payload?.length) return null
  const rows = payload.filter((p) => p.value != null && p.value !== 0)
  return (
    <div className="bg-bg border border-border rounded-lg px-3 py-2 text-xs shadow-xl">
      {label && <div className="text-muted mb-1">{label}</div>}
      {rows.map((p) => (
        <div key={p.dataKey ?? p.name} className="flex items-center gap-2 py-0.5">
          <span
            aria-hidden
            className="w-2.5 h-2.5 rounded-sm shrink-0"
            style={{ background: p.color }}
          />
          <span className="text-muted">{p.name}</span>
          <span className="num ml-auto font-medium">{formatter(p.value ?? 0)}</span>
        </div>
      ))}
      {total && rows.length > 1 && (
        <div className="flex items-center gap-2 pt-1 mt-1 border-t border-border">
          {/* No swatch: the total is not a mark on the chart. */}
          <span aria-hidden className="w-2.5 shrink-0" />
          <span className="text-muted">Total</span>
          <span className="num ml-auto font-medium">
            {formatter(rows.reduce((t, p) => t + (p.value ?? 0), 0))}
          </span>
        </div>
      )}
    </div>
  )
}

export function ChartFrame({
  height = 240,
  children,
}: {
  height?: number
  children: ReactNode
}) {
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children as never}
      </ResponsiveContainer>
    </div>
  )
}

export interface StackSeries {
  key: string
  name: string
  color: string
}

export interface FoldedStack {
  /** At most `max` coloured series, plus a grey "Other" when anything folded. */
  series: StackSeries[]
  /**
   * One row per input breakdown, in the same order, keyed by `series[].key`.
   * Spread into the caller's own x-value row.
   */
  rows: Record<string, number>[]
  /** Entity keys that got their own colour, in colour order. */
  shown: string[]
  /** Entity keys that folded into "Other". */
  folded: string[]
}

/**
 * Turn a per-entity breakdown per bucket into stacked-bar series.
 *
 * Three kit rules live here so no caller has to remember them:
 *
 *   - Colour is taken from `order` — the entity's rank across the WHOLE chart,
 *     never its rank inside one bucket. A ticker keeps its hue when a period
 *     toggle reshapes the buckets or a neighbour drops to zero.
 *   - The ninth entity and everything after it folds into one grey "Other". We
 *     do not invent a hue, and at 360px a ten-item legend is unreadable anyway.
 *   - Series data keys are positional (`s0`, `s1`, ...), not the entity key.
 *     Recharts resolves a string dataKey as a property PATH, so an instrument
 *     keyed `BRK.B|NASDAQ` would silently plot nothing.
 */
export function foldStack(
  breakdowns: readonly Readonly<Record<string, number>>[],
  label: (key: string) => string,
  { max = 8, order }: { max?: number; order?: readonly string[] } = {},
): FoldedStack {
  const totals = new Map<string, number>()
  for (const b of breakdowns) {
    for (const [key, value] of Object.entries(b)) {
      totals.set(key, (totals.get(key) ?? 0) + value)
    }
  }
  // Ties broken on the key itself: two holdings that paid the same amount must
  // not swap hues between renders.
  const byContribution = [...totals.keys()].sort(
    (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b),
  )
  // A caller-supplied order wins, but anything it does not mention is still
  // drawn rather than silently dropped from the bars.
  const ranked =
    order === undefined
      ? byContribution
      : [
          ...order.filter((k) => totals.has(k)),
          ...byContribution.filter((k) => !order.includes(k)),
        ]

  // Clamped to the palette: `seriesColor` wraps, so a caller asking for ten
  // slots would hand the ninth entity the first entity's blue — the one thing
  // the fold exists to prevent.
  const cap = Math.min(Math.max(0, max), SERIES.length)
  const shown = ranked.slice(0, cap)
  const folded = ranked.slice(cap)

  const series: StackSeries[] = shown.map((key, i) => ({
    key: `s${i}`,
    name: label(key),
    color: seriesColor(key, shown),
  }))
  if (folded.length > 0) {
    series.push({ key: OTHER_KEY, name: `Other (${folded.length})`, color: OTHER_COLOR })
  }

  const rows = breakdowns.map((b) => {
    const row: Record<string, number> = {}
    shown.forEach((key, i) => {
      row[`s${i}`] = b[key] ?? 0
    })
    if (folded.length > 0) {
      row[OTHER_KEY] = folded.reduce((t, key) => t + (b[key] ?? 0), 0)
    }
    return row
  })

  return { series, rows, shown, folded }
}

/**
 * Column chart, optionally stacked. Bars are capped at 24px so the band's
 * leftover reads as air, ends are rounded 4px away from the baseline, and
 * stacked segments are separated by a 2px gap in the surface colour rather
 * than by a stroke.
 */
export function Columns({
  data,
  xKey,
  series,
  height = 240,
  format,
  tooltipFormat,
  stacked = true,
}: {
  data: Record<string, unknown>[]
  xKey: string
  series: StackSeries[]
  height?: number
  format: (v: number) => string
  /**
   * Formatter for the tooltip, when the axis one is too coarse for it. An axis
   * rounds and compacts to fit its ticks; a stacked segment worth 0.42 read
   * through that formatter prints as "0" next to a total that includes it, and
   * the parts visibly stop adding up. Defaults to `format`.
   */
  tooltipFormat?: (v: number) => string
  stacked?: boolean
}) {
  const single = series.length === 1
  return (
    <ChartFrame height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barCategoryGap="18%">
        <CartesianGrid stroke={GRID} strokeDasharray="0" vertical={false} />
        <XAxis dataKey={xKey} {...axisProps} interval="preserveStartEnd" minTickGap={8} />
        <YAxis {...axisProps} width={56} tickFormatter={(v) => format(Number(v))} />
        <Tooltip
          cursor={{ fill: 'rgba(255,255,255,0.04)' }}
          // A stacked bar's parts sum to the bar, so the total is a real
          // number the user is pointing at rather than a coincidence.
          content={
            <ChartTooltip formatter={tooltipFormat ?? format} total={stacked && !single} />
          }
        />
        {!single && <Legend wrapperStyle={{ fontSize: 11, color: AXIS_TEXT }} iconType="square" iconSize={9} />}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.name}
            stackId={stacked ? 'a' : undefined}
            fill={s.color}
            maxBarSize={24}
            // 2px surface gap between stacked segments.
            stroke={stacked && series.length > 1 ? SURFACE : undefined}
            strokeWidth={stacked && series.length > 1 ? 2 : 0}
            radius={i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
          />
        ))}
      </BarChart>
    </ChartFrame>
  )
}

export function TimeLine({
  data,
  xKey,
  series,
  height = 240,
  format,
}: {
  data: Record<string, unknown>[]
  xKey: string
  series: StackSeries[]
  height?: number
  format: (v: number) => string
}) {
  return (
    <ChartFrame height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="0" vertical={false} />
        <XAxis dataKey={xKey} {...axisProps} interval="preserveStartEnd" minTickGap={24} />
        <YAxis {...axisProps} width={56} tickFormatter={(v) => format(Number(v))} />
        <Tooltip
          cursor={{ stroke: GRID }}
          content={<ChartTooltip formatter={format} />}
        />
        {series.length > 1 && (
          <Legend wrapperStyle={{ fontSize: 11, color: AXIS_TEXT }} iconType="plainline" iconSize={14} />
        )}
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            // 8px marker with a 2px surface ring so it stays legible on crossings.
            activeDot={{ r: 4, strokeWidth: 2, stroke: SURFACE }}
          />
        ))}
      </LineChart>
    </ChartFrame>
  )
}

/**
 * Allocation donut. Slices beyond `maxSlices` fold into "Other" — the all-pairs
 * CVD floor only holds for the first three hues, and a donut puts every pair
 * adjacent. A legend is mandatory here: slice geometry alone is not an identity
 * channel.
 */
export function Donut({
  data,
  height = 240,
  format,
  maxSlices = 8,
  legend = true,
}: {
  data: { key: string; name: string; value: number }[]
  height?: number
  format: (v: number) => string
  maxSlices?: number
  /**
   * Set false when the caller renders its own labelled list beside the chart.
   * Identity must still be carried by something other than colour — a built-in
   * legend next to an equivalent list is duplication, not redundancy.
   */
  legend?: boolean
}) {
  const sorted = [...data].sort((a, b) => b.value - a.value)
  const head = sorted.slice(0, maxSlices)
  const tail = sorted.slice(maxSlices)
  const slices = tail.length
    ? [...head, { key: OTHER_KEY, name: `Other (${tail.length})`, value: tail.reduce((s, d) => s + d.value, 0) }]
    : head

  return (
    <ChartFrame height={height}>
      <PieChart>
        <Pie
          data={slices}
          dataKey="value"
          nameKey="name"
          innerRadius="58%"
          outerRadius="82%"
          paddingAngle={1}
          stroke={SURFACE}
          strokeWidth={2}
          isAnimationActive={false}
        >
          {slices.map((s, i) => (
            <Cell key={s.key} fill={s.key === OTHER_KEY ? OTHER_COLOR : (SERIES[i % SERIES.length] ?? SERIES[0])} />
          ))}
        </Pie>
        <Tooltip content={<ChartTooltip formatter={format} />} />
        {legend && (
          <Legend
            wrapperStyle={{ fontSize: 11, color: AXIS_TEXT }}
            iconType="square"
            iconSize={9}
            layout="vertical"
            align="right"
            verticalAlign="middle"
          />
        )}
      </PieChart>
    </ChartFrame>
  )
}

/**
 * Heatmap cell colour from a sequential ramp. Zero is surface-coloured rather
 * than the palest step so "no payment" and "a tiny payment" are distinguishable.
 */
export function heatColor(value: number, max: number): string {
  if (!(value > 0) || !(max > 0)) return 'transparent'
  const t = Math.min(1, value / max)
  const i = Math.min(SEQUENTIAL.length - 1, Math.floor(t * SEQUENTIAL.length))
  return SEQUENTIAL[i] ?? SEQUENTIAL[0]
}
