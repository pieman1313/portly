import type { ReactNode } from 'react'
import type { TabId } from '../../App'

/**
 * Card layout: the pure half. No React runtime import, so this file is testable
 * under the node environment where the drag arithmetic and the reconciliation
 * actually belong — jsdom reports every `getBoundingClientRect()` as zeros and
 * never loads Tailwind, so geometry cannot be exercised there at all.
 *
 * localStorage rather than the Dexie `settings` table, for two reasons that are
 * both load-bearing. It has to be read SYNCHRONOUSLY, in a useState
 * initializer, before any tab paints: applied from an effect, a tab paints at
 * full length and then shrinks, and on a deep link (#/income) there is no
 * tab-change `scrollTo` to hide the jump. And `settings` travels inside the
 * encrypted backup (src/db/backup.ts), where a phone's card arrangement has no
 * business landing on a laptop alongside the figures.
 *
 * This is the first localStorage use in src/.
 */

/**
 * Version lives in the KEY, not only in the blob. This is a vite-plugin-pwa app
 * with `registerType: 'autoUpdate'`, so an installed older build can keep
 * running for a while after a newer one ships; two builds sharing one key means
 * the older one silently overwrites the newer one's layout on its first write.
 * Separate keys cannot collide.
 */
export const STORE_KEY = 'portly.cards.v1'
const SCHEMA = 1

/**
 * Ceiling on remembered ids per tab. Every tab ships between 2 and 8 cards, so
 * this is three times the headroom anything needs; it exists so a hand-edited
 * blob with ten thousand ids cannot become a rendering cost, and so ids retired
 * by a rename eventually age out on their own.
 */
const MAX_IDS = 64

/**
 * Row pitch in the arrange sheet. Uniform rows turn every piece of drag geometry
 * into integer arithmetic, which deletes the whole variable-height bug class —
 * a measured row is a row whose height changed while you were dragging it.
 *
 * PITCH, not height: this is the distance from one row's top to the next, so the
 * sheet's list must carry no row gap of its own. `space-y-1` on that list put
 * the real pitch at 60 against this 56, and since `dropIndex` and `shiftFor`
 * both divide by it, a four-row drag landed three-and-a-bit rows down and the
 * neighbours sat progressively further out of true. The 4px gap between rows is
 * padding INSIDE the 56px row for exactly that reason.
 */
export const ROW_H = 56

export interface StoredTab {
  /** Every id this tab has ever shown on this device, in the user's order. */
  order: string[]
  collapsed: string[]
  /**
   * id -> the card's content signature at the moment it was hidden, or ''. A
   * card whose signature has since changed is a different card, and re-shows
   * itself rather than hiding news behind an old dismissal.
   */
  hidden: Record<string, string>
}

export interface Stored {
  v: number
  tabs: Partial<Record<TabId, StoredTab>>
}

export const EMPTY_TAB: StoredTab = { order: [], collapsed: [], hidden: {} }
export const EMPTY_STORE: Stored = { v: SCHEMA, tabs: {} }

// ─────────────────────────────────────────────────────────────────────────────
// Policy — one table, so the flags are assertable without a DOM
// ─────────────────────────────────────────────────────────────────────────────

interface Policy {
  tab: TabId
  /** Short name, for the sheet and for an announcement. */
  label: string
  /**
   * Opt IN. A card added without thinking about it cannot be hidden: a
   * forgotten `true` is a cosmetic gap, a forgotten `false` on the only route
   * to the importer is a bug report.
   */
  hideable?: boolean
  /** Opt IN, and only meaningful for a block that renders a titled `Card`. */
  collapsible?: boolean
  /**
   * Render the collapsed body with `hidden` instead of unmounting it.
   *
   * Read what this does and does not buy before setting it, because the
   * obvious reading is wrong. `Card` unmounts only its CHILDREN, so state held
   * by the component that renders the Card sits above the body and survives a
   * collapse either way — RecentPayments' `shown` reveal count and MatrixCard's
   * `start` month window are both in that position, and both come back intact
   * with this flag off (measured). What the flag actually protects is state
   * held by a component INSIDE the body, DOM state the body owns, and the cost
   * of rebuilding a large subtree on every expand.
   *
   * The one genuinely load-bearing case in the app today is Data's Backup card:
   * ExportBlock and RestoreBlock are children of that Card, and they hold a
   * typed passphrase, a picked File and a merge/replace choice that nothing
   * else remembers.
   *
   * Deliberately NOT set on a chart card. A Recharts ResponsiveContainer inside
   * `display: none` measures its parent as 0x0 and warns on every render, so a
   * chart is better rebuilt than kept.
   */
  keepMounted?: boolean
}

/**
 * Every manageable block in the app, in one table.
 *
 * The flags live here rather than beside each `render` for three reasons: the
 * invariants below ("every tab keeps one card that cannot be hidden") become
 * node-testable without rendering anything; `CardId` becomes a union, so a typo
 * at a call site is a type error rather than a card that silently never
 * appears; and one screen shows the whole app's policy, which is how you notice
 * that a tab has quietly become entirely hideable.
 *
 * Ids are STABLE FOREVER. Renaming one resets that card's layout for every
 * existing user. They are deliberately not derived from the rendered title,
 * which interpolates the base currency and a date range.
 */
export const CARDS = {
  // ── Overview ───────────────────────────────────────────────────────────────
  // No title, so there is no header to hang a chevron on, and the hero already
  // owns its top-left corner. It is also the only place that explains why a
  // total could not be worked out.
  'portfolio-value': { tab: 'overview', label: 'Portfolio value' },
  'key-figures': { tab: 'overview', label: 'Key figures', hideable: true },
  'allocation-holding': { tab: 'overview', label: 'Allocation by holding', hideable: true, collapsible: true },
  'allocation-currency': { tab: 'overview', label: 'Allocation by currency', hideable: true, collapsible: true },
  'dividends-12m': { tab: 'overview', label: 'Dividends received', hideable: true, collapsible: true },
  'data-quality': { tab: 'overview', label: 'Data quality', hideable: true, collapsible: true },

  // ── Income ─────────────────────────────────────────────────────────────────
  // The controls are the only grouping and gross/net switch on the tab.
  'income-controls': { tab: 'income', label: 'Grouping and basis' },
  'income-basis-note': { tab: 'income', label: 'Basis note', hideable: true },
  'income-tiles': { tab: 'income', label: 'Income totals', hideable: true },
  // Not hideable: it says every figure on the screen is understated.
  'income-fx-warning': { tab: 'income', label: 'FX warning' },
  'income-irregular-note': { tab: 'income', label: 'Specials note', hideable: true },
  'income-chart': { tab: 'income', label: 'Dividends chart', hideable: true, collapsible: true },
  'payments-matrix': { tab: 'income', label: 'Payments matrix', hideable: true, collapsible: true, keepMounted: true },
  'recent-payments': { tab: 'income', label: 'Recent payments', hideable: true, collapsible: true, keepMounted: true },

  // ── Forecast ───────────────────────────────────────────────────────────────
  'forecast-hero': { tab: 'forecast', label: 'Projected income' },
  'forecast-split': { tab: 'forecast', label: 'Declared and estimated', hideable: true },
  // Not hideable: it is the tab's honesty banner, and says what the numbers
  // above it do NOT cover.
  'forecast-coverage': { tab: 'forecast', label: 'Coverage note' },
  'forecast-by-month': { tab: 'forecast', label: 'Projected by month', hideable: true, collapsible: true },
  'forecast-months': { tab: 'forecast', label: 'Month by month', hideable: true, collapsible: true },
  'forecast-upcoming': { tab: 'forecast', label: 'Next payments', hideable: true, collapsible: true },
  'forecast-concentration': { tab: 'forecast', label: 'Income concentration', hideable: true, collapsible: true },

  // ── Holdings ───────────────────────────────────────────────────────────────
  'holdings-kpis': { tab: 'holdings', label: 'Portfolio totals', hideable: true },
  'positions': { tab: 'holdings', label: 'Positions', collapsible: true },

  // ── Data ───────────────────────────────────────────────────────────────────
  // keepMounted across the whole tab, uniformly. `backup` needs it outright —
  // the typed passphrase and the picked restore file live in ExportBlock and
  // RestoreBlock, which are children of that Card and so are exactly what a
  // collapse would drop. The other six do not need it today, because each keeps
  // its state in the section component above the body; they carry it anyway so
  // that the rule on this tab is "a Data card never loses work when you fold
  // it", rather than a per-card judgement that the next person to pull a block
  // out into its own component has to make correctly without being told.
  //
  // Nothing here is hideable except Storage: every other section is the only
  // route to what it does.
  'import': { tab: 'data', label: 'Import', collapsible: true, keepMounted: true },
  'statements': { tab: 'data', label: 'Imported statements', collapsible: true, keepMounted: true },
  'market-data': { tab: 'data', label: 'Market data', collapsible: true, keepMounted: true },
  'settings': { tab: 'data', label: 'Settings', collapsible: true, keepMounted: true },
  'backup': { tab: 'data', label: 'Backup', collapsible: true, keepMounted: true },
  'storage': { tab: 'data', label: 'Storage', hideable: true, collapsible: true, keepMounted: true },
  'danger': { tab: 'data', label: 'Rebuild and erase', collapsible: true, keepMounted: true },
} as const satisfies Record<string, Policy>

export type CardId = keyof typeof CARDS

export const policyOf = (id: CardId): Policy => CARDS[id]

/** One manageable block of a tab, declared where it is rendered. */
export interface CardSpec {
  id: CardId
  render: () => ReactNode
  /**
   * A dismissal lasts only as long as the content dismissed. When this string
   * changes, a hidden card comes back — the same trick as RecentPayments'
   * `shownFor` guard.
   */
  signature?: string
  /**
   * Fired when this card collapses or expands, so a tab can clear state that
   * would otherwise become invisible — Holdings' search query is the case.
   */
  onCollapsedChange?: (collapsed: boolean) => void
}

/** A spec plus its policy, which is what the renderer and the sheet both want. */
export interface ResolvedCard extends CardSpec {
  label: string
  hideable: boolean
  collapsible: boolean
  keepMounted: boolean
}

export function resolveSpec(spec: CardSpec): ResolvedCard {
  const p = CARDS[spec.id] as Policy
  return {
    ...spec,
    label: p.label,
    hideable: p.hideable === true,
    collapsible: p.collapsible === true,
    keepMounted: p.keepMounted === true,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage IO — total functions; neither one ever throws
// ─────────────────────────────────────────────────────────────────────────────

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')

function parseTab(v: unknown): StoredTab | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const raw = v as Record<string, unknown>
  const order = isStringArray(raw.order) ? dedupe(raw.order).slice(0, MAX_IDS) : []
  const collapsed = isStringArray(raw.collapsed) ? dedupe(raw.collapsed).slice(0, MAX_IDS) : []
  const hidden: Record<string, string> = {}
  if (typeof raw.hidden === 'object' && raw.hidden !== null && !Array.isArray(raw.hidden)) {
    for (const [id, sig] of Object.entries(raw.hidden as Record<string, unknown>)) {
      if (Object.keys(hidden).length >= MAX_IDS) break
      if (typeof sig === 'string') hidden[id] = sig
    }
  }
  return { order, collapsed, hidden }
}

export function readStore(): Stored {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw === null) return EMPTY_STORE
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_STORE
    const blob = parsed as Record<string, unknown>
    // A blob from another schema is dropped whole rather than half-read. A
    // wrong arrangement is a two-tap fix; a throw during render is a white
    // screen on a tab the user cannot get off.
    if (blob.v !== SCHEMA) return EMPTY_STORE
    if (typeof blob.tabs !== 'object' || blob.tabs === null) return EMPTY_STORE
    const tabs: Stored['tabs'] = {}
    for (const [tab, value] of Object.entries(blob.tabs as Record<string, unknown>)) {
      const parsedTab = parseTab(value)
      if (parsedTab !== null) tabs[tab as TabId] = parsedTab
    }
    return { v: SCHEMA, tabs }
  } catch {
    // Safari in private mode throws on access; a half-written blob throws on
    // parse. Either way the default layout is a working screen.
    return EMPTY_STORE
  }
}

export function writeStore(next: Stored): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next))
  } catch {
    // Quota exhausted, or private mode. The provider keeps the value in React
    // state, so rearranging still works for this session and simply will not
    // survive a reload — a better failure than refusing to rearrange at all.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation
// ─────────────────────────────────────────────────────────────────────────────

export const dedupe = (ids: readonly string[]): string[] => [...new Set(ids)]

/**
 * Merge the ids the code declares this render into the order the user arranged.
 *
 * An id the store has never seen is inserted after the nearest EARLIER declared
 * id that is already placed — so a card shipped in a later release appears next
 * to the card its author put it next to, wherever the user has since dragged
 * that sibling, rather than exiled to the bottom of an arrangement they had
 * already finished making.
 *
 * Stored ids that are NOT declared this render are KEPT, in place. They are
 * indistinguishable from ids retired by a rename, and the offstage case is the
 * one that matters: Overview's Data quality card renders only when there are
 * issues, and two of Income's warnings only when the data warrants them.
 * Dropping them would lose the user's explicit placement of a card that is
 * merely absent today. A genuinely retired id costs one remembered slot until
 * MAX_IDS prunes it on read, and renders nothing and appears nowhere meanwhile.
 *
 * Never truncates: a declared id must always reach the DOM.
 */
export function mergeOrder(declared: readonly string[], stored: readonly string[]): string[] {
  const out = dedupe(stored)
  const placed = new Set(out)
  declared.forEach((id, i) => {
    if (placed.has(id)) return
    // Anchor to the nearest already-placed predecessor rather than to a running
    // cursor: a cursor carries the previous insertion's position forward, which
    // is wrong the moment two new cards are separated by an old one.
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const prev = declared[j]
      if (prev === undefined) continue
      const k = out.indexOf(prev)
      if (k >= 0) {
        at = k + 1
        break
      }
    }
    out.splice(at, 0, id)
    placed.add(id)
  })
  return out
}

/**
 * Write a reordered on-screen sequence back into the full remembered order.
 *
 * `full` is the merged order — every id this tab remembers, including the ones
 * offstage this render. `next` is the new order of just the visible ids. Every
 * position in `full` that held a visible id is a slot; the slots are refilled in
 * `next` order and everything else stays exactly where it was.
 *
 * This is the direction that is easy to get wrong. Rebuilding the order from
 * the visible set alone drops the offstage ids or migrates them to the end — so
 * reordering Income while its FX warning happens to be absent would move that
 * warning away from the tiles it explains, and a card the store has not seen
 * yet would never persist its position at all.
 */
export function spliceOrder(full: readonly string[], next: readonly string[]): string[] {
  const wanted = new Set(next)
  const slots = full.filter((id) => wanted.has(id))
  // Precondition: `next` is a permutation of the visible projection of `full`.
  // If it is not, the caller has a bug, and the safe answer is to change
  // nothing rather than to invent a position for the difference.
  if (slots.length !== next.length) return [...full]
  const queue = [...next]
  const out: string[] = []
  for (const id of full) {
    if (wanted.has(id)) {
      const take = queue.shift()
      if (take !== undefined) out.push(take)
    } else {
      out.push(id)
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag arithmetic
// ─────────────────────────────────────────────────────────────────────────────

export function moveAt(order: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= order.length) return [...order]
  const out = [...order]
  const [id] = out.splice(from, 1)
  if (id === undefined) return [...order]
  out.splice(Math.max(0, Math.min(out.length, to)), 0, id)
  return out
}

/**
 * Where the lifted row would land, from its travel alone.
 *
 * Measured against the row's ORIGINAL static slots, never against its live
 * neighbours: a neighbour you have just passed moves toward you, so comparing
 * against it is exactly what makes the index oscillate on the boundary. Static
 * slots put the flip in one place — half a row of travel — and it flips once.
 */
export const dropIndex = (from: number, dy: number, count: number): number =>
  Math.max(0, Math.min(count - 1, from + Math.round(dy / ROW_H)))

/**
 * How far row `i` steps aside to open the gap. Only the rows between the lift
 * and the drop move, and only ever by one pitch.
 */
export const shiftFor = (i: number, from: number, to: number): number =>
  from < to && i > from && i <= to
    ? -ROW_H
    : from > to && i >= to && i < from
      ? ROW_H
      : 0

// ─────────────────────────────────────────────────────────────────────────────
// Resolution — storage plus policy, at render time, never written back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which ids are actually hidden.
 *
 * Policy wins over storage, and only at render time. A card the user hid while
 * it was optional shows up again the moment the code says it is essential, and
 * a dismissed warning comes back when its signature changes — and because none
 * of that is written back, the user's intent survives for whenever the card
 * becomes optional, or unchanged, again.
 */
export function resolveHidden(
  stored: Readonly<Record<string, string>>,
  specs: readonly ResolvedCard[],
): Set<string> {
  const byId = new Map(specs.map((s) => [s.id as string, s]))
  const out = new Set<string>()
  for (const [id, sig] of Object.entries(stored)) {
    const spec = byId.get(id)
    // Offstage this render: keep the dismissal for when the card comes back.
    if (spec === undefined) {
      out.add(id)
      continue
    }
    if (!spec.hideable) continue
    if (spec.signature !== undefined && spec.signature !== sig) continue
    out.add(id)
  }
  return out
}
