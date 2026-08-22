import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { TabId } from '../../App'
import type { CardChrome } from './slot'
import {
  EMPTY_TAB,
  STORE_KEY,
  mergeOrder,
  readStore,
  resolveHidden,
  resolveSpec,
  spliceOrder,
  writeStore,
} from './layout'
import type { CardId, CardSpec, ResolvedCard, Stored, StoredTab } from './layout'

/**
 * Card layout: the React half.
 *
 * The store is read ONCE, synchronously, in a useState initializer in a
 * provider mounted above <Suspense> — so no tab ever paints at a length the
 * user did not ask for. Nothing is written on read: reconciliation is a pure
 * render-time function, and only a user action touches localStorage.
 */

interface StackInfo {
  tab: TabId
  hidden: number
}

interface CardsApi {
  store: Stored
  patch: (tab: TabId, fn: (t: StoredTab) => StoredTab) => void
  reset: (tab: TabId) => void
  /** Which tab's arrange sheet is open, if any. */
  openFor: TabId | null
  open: (tab: TabId) => void
  close: () => void
  /**
   * Published by the mounted CardStack. Absent on a skeleton or an empty state,
   * so the header's Arrange button is absent too rather than present and dead.
   */
  stack: StackInfo | null
  setStack: Dispatch<SetStateAction<StackInfo | null>>
}

const CardsContext = createContext<CardsApi | null>(null)

export function useCards(): CardsApi {
  const api = useContext(CardsContext)
  if (api === null) throw new Error('useCards outside CardsProvider')
  return api
}

/**
 * Renders NO DOM, deliberately. One element between <main> and the tab root
 * would re-point `main > div` at it, and `main > div > :last-child section`
 * (specificity 0,1,3) would then beat `main > div > * > section` (0,0,3) and set
 * `scroll-snap-align: none` on every card in the app.
 */
export function CardsProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<Stored>(() => readStore())
  const [openFor, setOpenFor] = useState<TabId | null>(null)
  const [stack, setStack] = useState<StackInfo | null>(null)

  // Two installed windows on one device would otherwise diverge until a reload,
  // with the second writer clobbering the first. The storage event fires only in
  // OTHER documents, so re-reading here cannot loop.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== STORE_KEY) return
      setStore(readStore())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const patch = useCallback((tab: TabId, fn: (t: StoredTab) => StoredTab) => {
    setStore((prev) => {
      const next: Stored = {
        v: prev.v,
        tabs: { ...prev.tabs, [tab]: fn(prev.tabs[tab] ?? EMPTY_TAB) },
      }
      writeStore(next)
      return next
    })
  }, [])

  const reset = useCallback((tab: TabId) => {
    setStore((prev) => {
      const tabs = { ...prev.tabs }
      delete tabs[tab]
      const next: Stored = { v: prev.v, tabs }
      writeStore(next)
      return next
    })
  }, [])

  const open = useCallback((tab: TabId) => setOpenFor(tab), [])
  const close = useCallback(() => setOpenFor(null), [])

  const api = useMemo<CardsApi>(
    () => ({ store, patch, reset, openFor, open, close, stack, setStack }),
    [store, patch, reset, openFor, open, close, stack],
  )

  return <CardsContext.Provider value={api}>{children}</CardsContext.Provider>
}

export interface CardRow {
  spec: ResolvedCard
  hidden: boolean
  collapsed: boolean
  canHide: boolean
  /** Why the eye is disabled, for the screen reader. Empty when it is not. */
  lockReason: string
}

export interface CardLayout {
  tab: TabId
  /**
   * Every declared card, in the user's order, hidden ones included — this is
   * what the sheet lists, so the sheet's row order IS the page's order.
   */
  rows: CardRow[]
  /** What the page renders, in order. */
  visible: ResolvedCard[]
  hiddenCount: number
  chromeFor: (spec: ResolvedCard) => CardChrome
  /** `next` must be a permutation of the currently visible ids. */
  setOrder: (next: string[]) => void
  toggleCollapsed: (id: string) => void
  setHidden: (id: string, hidden: boolean) => void
  resetTab: () => void
}

export function useCardLayout(tab: TabId, specs: readonly CardSpec[]): CardLayout {
  const { store, patch, reset } = useCards()
  const stored = store.tabs[tab] ?? EMPTY_TAB

  // Joined into a string so the memo key is the declared SET, not the array
  // identity: every tab rebuilds its spec array with fresh render thunks on
  // every render, so depending on that identity would recompute the order — and
  // rerun every memo below it — on every keystroke in the Holdings search.
  const declaredKey = specs.map((s) => s.id).join(' ')
  const order = useMemo(
    () => mergeOrder(declaredKey === '' ? [] : declaredKey.split(' '), stored.order),
    [declaredKey, stored.order],
  )

  const resolved = specs.map(resolveSpec)
  const byId = new Map<string, ResolvedCard>(resolved.map((s) => [s.id, s]))
  const hidden = resolveHidden(stored.hidden, resolved)

  const collapsed = useMemo(() => new Set(stored.collapsed), [stored.collapsed])

  const ordered = order.flatMap((id) => {
    const spec = byId.get(id)
    return spec === undefined ? [] : [spec]
  })
  const visible = ordered.filter((s) => !hidden.has(s.id))

  const rows: CardRow[] = ordered.map((spec) => {
    const isHidden = hidden.has(spec.id)
    // The floor: a tab can never end up with nothing in it. Unreachable while
    // every tab ships at least one card that is not hideable at all (asserted
    // in layout.test.ts), and enforced here anyway so it stays unreachable if
    // some future tab forgets.
    const canHide = spec.hideable && (isHidden || visible.length > 1)
    return {
      spec,
      hidden: isHidden,
      // Collapse is honoured only while the code still says the card may
      // collapse. Read, never written back, so a card that becomes collapsible
      // again remembers that it was collapsed.
      collapsed: spec.collapsible && collapsed.has(spec.id),
      canHide,
      lockReason: canHide
        ? ''
        : spec.hideable
          ? 'The last card on a tab cannot be hidden'
          : 'This is the only place to do this',
    }
  })

  const setHidden = useCallback(
    (id: string, next: boolean) => {
      const signature = specs.find((s) => s.id === id)?.signature ?? ''
      patch(tab, (t) => {
        const nextHidden = { ...t.hidden }
        if (next) nextHidden[id] = signature
        else delete nextHidden[id]
        return { ...t, hidden: nextHidden }
      })
    },
    [patch, specs, tab],
  )

  const toggleCollapsed = useCallback(
    (id: string) => {
      const wasCollapsed = collapsed.has(id)
      patch(tab, (t) => ({
        ...t,
        collapsed: wasCollapsed ? t.collapsed.filter((x) => x !== id) : [...t.collapsed, id],
      }))
      specs.find((s) => s.id === id)?.onCollapsedChange?.(!wasCollapsed)
    },
    [collapsed, patch, specs, tab],
  )

  const setOrder = useCallback(
    (next: string[]) => {
      // Splice against the MERGED order, which contains the ids offstage this
      // render as well as any the store has never seen. Splicing against the
      // raw stored array silently discards the drag of a card that is not in
      // storage yet — permanently, since it then never gets written and so
      // never enters storage.
      patch(tab, (t) => ({ ...t, order: spliceOrder(mergeOrder(next, t.order), next) }))
    },
    [patch, tab],
  )

  const chromeFor = useCallback(
    (spec: ResolvedCard): CardChrome => ({
      id: spec.id,
      label: spec.label,
      collapsible: spec.collapsible,
      collapsed: spec.collapsible && collapsed.has(spec.id),
      keepMounted: spec.keepMounted,
      toggle: () => toggleCollapsed(spec.id),
    }),
    [collapsed, toggleCollapsed],
  )

  return {
    tab,
    rows,
    visible,
    hiddenCount: rows.filter((r) => r.hidden).length,
    chromeFor,
    setOrder,
    toggleCollapsed,
    setHidden,
    resetTab: useCallback(() => reset(tab), [reset, tab]),
  }
}

/**
 * Spec constructor. Exists so a tab can build its array with the id checked
 * against the policy table — a typo is a type error rather than a card that
 * silently never appears.
 */
export const card = (
  id: CardId,
  render: () => ReactNode,
  extra: Omit<CardSpec, 'id' | 'render'> = {},
): CardSpec => ({ id, render, ...extra })
