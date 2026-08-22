import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Currency, Provenance } from '../../domain/types'

/**
 * Shared UI kit. Every tab is built from these so the app reads as one system.
 *
 * Two rules that are load-bearing rather than decorative:
 *   - Money and percentages never carry meaning by colour alone. A sign is
 *     always rendered, so red/green is redundant reinforcement, not the signal.
 *   - Anything sourced from outside the statement carries visible provenance.
 *     A number with no `asOf` is indistinguishable from a stale one otherwise.
 */

export function Card({
  title,
  subtitle,
  right,
  children,
  className = '',
  cap = true,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  children: ReactNode
  className?: string
  /**
   * Cap the card at 75vh on a phone and scroll its body. Set false for a card
   * that is meant to grow with the page — a long list reads better as part of
   * the page than as a small window onto itself, and nesting a scroller inside
   * the page scroller costs the user a gesture every time.
   */
  cap?: boolean
}) {
  // Only on mobile: on a laptop a tall card is just a tall card, and capping it
  // there would introduce a scrollbar nobody asked for.
  //
  // Note there is no `overscroll-contain` here, deliberately. Containing the
  // vertical axis would stop a swipe that starts inside a capped card from ever
  // reaching the page once the card hits its own scroll limit, which is exactly
  // the trap the payments matrix used to have.
  const body = cap
    ? 'max-h-[75vh] overflow-y-auto sm:max-h-none sm:overflow-visible'
    : ''

  return (
    <section
      className={`bg-surface border border-border rounded-xl flex flex-col ${cap ? 'max-h-[75vh] sm:max-h-none' : ''} ${className}`}
    >
      {(title || right) && (
        // Sticky so the card keeps saying what it is while its body scrolls
        // underneath. Matches the card's own background so rows slide behind it
        // rather than showing through.
        <header className="flex items-start justify-between gap-3 shrink-0 bg-surface rounded-t-xl px-4 pt-4 pb-3 sm:px-5 sm:pt-5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink truncate">{title}</h2>}
            {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </header>
      )}
      {/* `relative` is load-bearing when this body scrolls. An absolutely
          positioned descendant resolves its containing block to the nearest
          POSITIONED ancestor, and an overflow box only clips what it contains —
          so with no positioning here, an `sr-only` live region (Tailwind's
          sr-only is position:absolute) escapes the card entirely and is laid
          out against the page. On the Income tab that stretched the document
          898px past the end of its own content: a screenful of blank space
          below the last card, scrollable and empty. */}
      <div
        className={`relative min-h-0 px-4 pb-4 sm:px-5 sm:pb-5 ${!(title || right) ? 'pt-4 sm:pt-5' : ''} ${body}`}
      >
        {children}
      </div>
    </section>
  )
}

const CCY_SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' }

export function formatMoney(
  value: number | null | undefined,
  currency: Currency,
  opts: { dp?: number; compact?: boolean; signed?: boolean } = {},
): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const { dp = 2, compact = false, signed = false } = opts
  const abs = Math.abs(value)
  const sym = CCY_SYMBOL[currency] ?? ''
  const body = compact && abs >= 10_000
    ? new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(abs)
    : new Intl.NumberFormat('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(abs)
  const sign = value < 0 ? '−' : signed ? '+' : ''
  return `${sign}${sym}${body}${sym ? '' : ` ${currency}`}`
}

export function formatPct(value: number | null | undefined, dp = 2, signed = true): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value < 0 ? '−' : signed ? '+' : ''
  return `${sign}${Math.abs(value).toFixed(dp)}%`
}

/** Money with a sign. Colour is reinforcement; the sign is the actual signal. */
export function Money({
  value,
  currency,
  signed = false,
  colored = false,
  dp = 2,
  compact = false,
  className = '',
}: {
  value: number | null | undefined
  currency: Currency
  signed?: boolean
  colored?: boolean
  dp?: number
  compact?: boolean
  className?: string
}) {
  const tone =
    !colored || value == null || value === 0 ? '' : value > 0 ? 'text-pos' : 'text-neg'
  return (
    <span className={`num ${tone} ${className}`}>
      {formatMoney(value, currency, { dp, compact, signed })}
    </span>
  )
}

export function Pct({
  value,
  colored = true,
  dp = 2,
  className = '',
}: {
  value: number | null | undefined
  colored?: boolean
  dp?: number
  className?: string
}) {
  const tone =
    !colored || value == null || value === 0 ? '' : value > 0 ? 'text-pos' : 'text-neg'
  return <span className={`num ${tone} ${className}`}>{formatPct(value, dp)}</span>
}

/** The big number at the top of a tab. One per screen, at most. */
export function Hero({
  label,
  value,
  delta,
  deltaPct,
  currency,
  provenance,
}: {
  label: string
  value: number | null
  delta?: number | null
  deltaPct?: number | null
  currency: Currency
  provenance?: Provenance | null
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="num text-3xl sm:text-4xl font-semibold mt-1 tabular-nums">
        {formatMoney(value, currency)}
      </div>
      {(delta != null || deltaPct != null) && (
        <div className="mt-1 text-sm flex items-center gap-2 flex-wrap">
          {delta != null && <Money value={delta} currency={currency} signed colored />}
          {deltaPct != null && <Pct value={deltaPct} />}
        </div>
      )}
      {provenance && <Staleness provenance={provenance} className="mt-2" />}
    </div>
  )
}

export function StatTile({
  label,
  value,
  hint,
  provenance,
}: {
  label: string
  value: ReactNode
  hint?: string
  provenance?: Provenance | null
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-3 sm:p-4 min-w-0">
      <div className="text-xs text-muted truncate">{label}</div>
      <div className="num text-lg sm:text-xl font-semibold mt-1 truncate">{value}</div>
      {hint && <div className="text-xs text-muted mt-1 truncate">{hint}</div>}
      {provenance && <Staleness provenance={provenance} className="mt-1.5" />}
    </div>
  )
}

const SOURCE_LABEL: Record<string, string> = {
  statement: 'from statement',
  manual: 'manual',
  stockanalysis: 'live',
  extraetf: 'extraETF',
  frankfurter: 'ECB',
  euronext: 'Euronext',
}

/**
 * Age badge. Amber past 24h, red past 72h. Users tolerate stale data; they do
 * not tolerate a number that silently stopped updating.
 */
export function Staleness({
  provenance,
  className = '',
}: {
  provenance: Provenance
  className?: string
}) {
  const ageMs = Date.now() - new Date(provenance.asOf).getTime()
  const hours = ageMs / 3_600_000
  const tone =
    provenance.source === 'manual' || provenance.source === 'statement'
      ? 'text-muted'
      : hours > 72
        ? 'text-crit'
        : hours > 24
          ? 'text-warn'
          : 'text-muted'
  const age =
    hours < 1 ? 'just now' : hours < 24 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`
  return (
    <div className={`text-[11px] ${tone} ${className}`}>
      {SOURCE_LABEL[provenance.source] ?? provenance.source} · {age}
    </div>
  )
}

/** Status chip. Always icon + text — never colour alone. */
export function Badge({
  tone = 'muted',
  children,
}: {
  tone?: 'good' | 'warn' | 'serious' | 'crit' | 'muted'
  children: ReactNode
}) {
  const map = {
    good: 'text-good border-good/40 bg-good/10',
    warn: 'text-warn border-warn/40 bg-warn/10',
    serious: 'text-serious border-serious/40 bg-serious/10',
    crit: 'text-crit border-crit/40 bg-crit/10',
    muted: 'text-muted border-border bg-white/5',
  }
  const icon = { good: '✓', warn: '!', serious: '!', crit: '×', muted: '·' }[tone]
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border ${map[tone]}`}
    >
      <span aria-hidden>{icon}</span>
      {children}
    </span>
  )
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="text-center py-12 px-4">
      <h3 className="text-base font-semibold">{title}</h3>
      {children && <p className="text-sm text-muted mt-2 max-w-md mx-auto">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

let toggleSeq = 0

export function Toggle({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
  label?: string
}) {
  // The group needs an accessible NAME, not just a nearby span: a screen reader
  // landing on the third button otherwise announces "November, pressed" with no
  // hint that it belongs to a "Group by" control.
  const [id] = useState(() => `toggle-${++toggleSeq}`)
  return (
    <div className="inline-flex items-center gap-2 flex-wrap">
      {label && (
        <span id={id} className="text-xs text-muted">
          {label}
        </span>
      )}
      <div
        role="group"
        aria-labelledby={label ? id : undefined}
        className="inline-flex rounded-lg border border-border overflow-hidden"
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
            // 44px: the minimum comfortable touch target. Tabs were previously
            // patching this from the outside with an arbitrary variant.
            className={`px-3 min-h-[44px] text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
              o.value === value ? 'bg-accent text-white' : 'text-muted hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
