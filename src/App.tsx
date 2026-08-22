import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useMarketDataSync } from './ui/useMarketDataSync'

/*
 * Tabs are split per route. On a phone this matters: the Data tab alone pulls in
 * the importer, the parser and WebCrypto backup code that a user reading their
 * Overview has no use for. Overview stays the only tab in the first paint.
 */
const Overview = lazy(() => import('./ui/tabs/Overview').then((m) => ({ default: m.Overview })))
const Income = lazy(() => import('./ui/tabs/Income').then((m) => ({ default: m.Income })))
const Forecast = lazy(() => import('./ui/tabs/Forecast').then((m) => ({ default: m.Forecast })))
const Holdings = lazy(() => import('./ui/tabs/Holdings').then((m) => ({ default: m.Holdings })))
const Data = lazy(() => import('./ui/tabs/Data').then((m) => ({ default: m.Data })))

/**
 * App shell.
 *
 * Navigation is mobile-first: a thumb-reachable bottom bar on small screens,
 * a top bar from `sm` up. Both render the same five destinations in the same
 * order, so muscle memory survives a rotation.
 *
 * Routing is a hash router written by hand. A router dependency would buy us
 * nothing here — there are five static routes, no params, no nesting — and the
 * hash keeps deep links working on GitHub Pages, which cannot rewrite unknown
 * paths to index.html.
 */

export const TABS = [
  { id: 'overview', label: 'Overview', icon: PieIcon },
  { id: 'income', label: 'Income', icon: CoinsIcon },
  { id: 'forecast', label: 'Forecast', icon: CalendarIcon },
  { id: 'holdings', label: 'Holdings', icon: ListIcon },
  { id: 'data', label: 'Data', icon: DatabaseIcon },
] as const

export type TabId = (typeof TABS)[number]['id']

const isTabId = (v: string): v is TabId => TABS.some((t) => t.id === v)

function useHashRoute(): [TabId, (t: TabId) => void] {
  const read = (): TabId => {
    const raw = window.location.hash.replace(/^#\/?/, '')
    return isTabId(raw) ? raw : 'overview'
  }
  const [tab, setTab] = useState<TabId>(read)

  useEffect(() => {
    const onHash = () => setTab(read())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (t: TabId) => {
    window.location.hash = `/${t}`
    setTab(t)
  }
  return [tab, go]
}

/** Travel before a drag is read as navigation rather than a stray finger. */
const SWIPE_MIN_X = 60
/** How far x has to dominate y before the gesture counts as horizontal. */
const SWIPE_AXIS_RATIO = 1.5
/** Vertical travel after which the gesture is a scroll and can never be a swipe. */
const SWIPE_VERTICAL_LOCK = 12

/**
 * Does anything under the finger still have room to scroll sideways?
 *
 * Answered by measurement rather than by selector. The payments matrix is the
 * one horizontal scroller in the app today, but the next wide table someone
 * adds has to be safe without them knowing this file exists.
 *
 * Both directions are reported because the caller does not yet know which way
 * the finger will travel, and this has to be sampled at touchstart: ask again
 * at touchend and the scroller has already been dragged to its end, at which
 * point it looks exactly like an element that never wanted the gesture.
 */
function horizontalRoom(from: EventTarget | null): { back: boolean; forward: boolean } {
  let back = false
  let forward = false
  for (
    let el = from instanceof Element ? from : null;
    el !== null;
    el = el.parentElement
  ) {
    const max = el.scrollWidth - el.clientWidth
    if (max <= 1) continue
    if (!/auto|scroll|overlay/.test(getComputedStyle(el).overflowX)) continue
    const left = el.scrollLeft
    if (left > 1) back = true
    if (left < max - 1) forward = true
  }
  return { back, forward }
}

/**
 * Swipe left or right to move between tabs, on touch input only.
 *
 * The whole difficulty is knowing when the gesture is NOT ours. A horizontal
 * drag belongs to the content under it whenever that content can still scroll
 * the way the finger is going, and it belongs to the control under it whenever
 * dragging that control means something — a range thumb, a text selection. Only
 * what is left over is navigation.
 *
 * Buttons and links are deliberately not excluded: a phone's card lists are
 * mostly tappable rows, and refusing to swipe from one would make the gesture
 * work nowhere useful. Their taps survive because the browser cancels a tap
 * once the touch moves past its own slop, long before our 60px threshold.
 *
 * No transition: a tab switch is a navigation, and the app already jumps to the
 * top of the new tab instantly for exactly that reason. Nothing here animates,
 * so there is nothing for `prefers-reduced-motion` to turn off.
 */
function useTabSwipe(tab: TabId, go: (t: TabId) => void) {
  // Listeners are bound once. The current tab and `go` change on every render —
  // re-subscribing on each one would rebind the whole set mid-gesture.
  const nav = useRef({ tab, go })
  useEffect(() => {
    nav.current = { tab, go }
  })

  useEffect(() => {
    type Gesture = {
      x0: number
      y0: number
      room: ReturnType<typeof horizontalRoom>
      /** Set once the drag reads as a scroll; from then on it can never navigate. */
      scrolling: boolean
    }
    let gesture: Gesture | null = null

    const onStart = (e: TouchEvent) => {
      // A second finger means a pinch. Abandon whatever was in flight rather
      // than measuring from one finger and ending on another.
      if (e.touches.length !== 1) {
        gesture = null
        return
      }
      const target = e.target instanceof Element ? e.target : null
      if (
        target?.closest(
          'input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="slider"]',
        )
      ) {
        gesture = null
        return
      }
      const touch = e.touches[0]
      if (!touch) return
      gesture = {
        x0: touch.clientX,
        y0: touch.clientY,
        room: horizontalRoom(target),
        scrolling: false,
      }
    }

    const onMove = (e: TouchEvent) => {
      if (gesture === null) return
      if (e.touches.length !== 1) {
        gesture = null
        return
      }
      const touch = e.touches[0]
      if (!touch) return
      const dy = touch.clientY - gesture.y0
      const dx = touch.clientX - gesture.x0
      // Lock to vertical as soon as the gesture reads as a scroll, so a long
      // read that drifts sideways on the way up never lands on another tab.
      if (Math.abs(dy) > SWIPE_VERTICAL_LOCK && Math.abs(dy) > Math.abs(dx)) {
        gesture.scrolling = true
      }
    }

    const onEnd = (e: TouchEvent) => {
      const g = gesture
      gesture = null
      if (g === null || g.scrolling) return
      const touch = e.changedTouches[0]
      if (!touch) return

      const dx = touch.clientX - g.x0
      const dy = touch.clientY - g.y0
      if (Math.abs(dx) < SWIPE_MIN_X) return
      if (Math.abs(dx) <= SWIPE_AXIS_RATIO * Math.abs(dy)) return
      // Dragging left asks for content on the right, which is a scroller's
      // forward direction. If one under the finger still had room that way, the
      // gesture was scrolling it, not addressing the tab bar.
      if (dx < 0 ? g.room.forward : g.room.back) return

      const here = TABS.findIndex((t) => t.id === nav.current.tab)
      // No wrap. Running off either end should feel like a wall, not a
      // carousel — five tabs are a row, not a loop.
      const next = TABS[dx < 0 ? here + 1 : here - 1]
      if (next) nav.current.go(next.id)
    }

    const onCancel = () => {
      gesture = null
    }

    // Passive throughout: nothing here calls preventDefault, and a non-passive
    // touchmove listener would make every scroll on the page wait for it.
    const opts = { passive: true } as const
    window.addEventListener('touchstart', onStart, opts)
    window.addEventListener('touchmove', onMove, opts)
    window.addEventListener('touchend', onEnd, opts)
    window.addEventListener('touchcancel', onCancel, opts)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onCancel)
    }
  }, [])
}

export function App() {
  const [tab, go] = useHashRoute()
  // Mounted once, here, so prices refresh on open and after every import
  // regardless of which tab the user happens to be looking at.
  const sync = useMarketDataSync()

  useTabSwipe(tab, go)

  useEffect(() => {
    const active = TABS.find((t) => t.id === tab)
    document.title = active ? `${active.label} · Portly` : 'Portly'
  }, [tab])

  // Land at the top of every tab. Tabs are separate destinations, not one long
  // document, so carrying the scroll offset across drops the user into the
  // middle of a screen they have not seen — and with different content heights
  // the same offset means something different on each one.
  //
  // Instant, not smooth: this is a navigation, and animating it would make the
  // new tab arrive mid-flight.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior })
  }, [tab])

  // Warm the other route chunks once the first screen is painted and the main
  // thread is free, so tab switches feel instant without delaying first paint.
  useEffect(() => {
    const idle =
      window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 1200))
    const handle = idle(() => {
      void import('./ui/tabs/Income')
      void import('./ui/tabs/Forecast')
      void import('./ui/tabs/Holdings')
      void import('./ui/tabs/Data')
    })
    return () => {
      if (window.cancelIdleCallback && typeof handle === 'number') {
        window.cancelIdleCallback(handle)
      }
    }
  }, [])

  return (
    <div className="min-h-full flex flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:px-3 focus:py-2 focus:bg-accent focus:text-white focus:rounded"
      >
        Skip to content
      </a>

      {/* Desktop / tablet navigation */}
      <header className="hidden sm:block sticky top-0 z-30 bg-bg/90 backdrop-blur border-b border-border">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-6">
          <span className="font-semibold tracking-tight">Portly</span>
          <nav aria-label="Sections" className="flex items-center gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => go(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  tab === t.id ? 'bg-surface text-ink' : 'text-muted hover:text-ink'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <SyncStatus sync={sync} className="ml-auto" />
        </div>
      </header>

      {/* Mobile title bar */}
      <header className="sm:hidden sticky top-0 z-30 bg-bg/90 backdrop-blur border-b border-border">
        <div className="h-12 px-4 flex items-center gap-3">
          <span className="font-semibold tracking-tight">
            {TABS.find((t) => t.id === tab)?.label ?? 'Portly'}
          </span>
          <SyncStatus sync={sync} className="ml-auto" />
        </div>
      </header>

      <main
        id="main"
        // Bottom padding clears the mobile tab bar plus the iOS home indicator.
        className="flex-1 w-full max-w-6xl mx-auto px-3 sm:px-4 py-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-8"
      >
        <Suspense fallback={<TabFallback />}>
          <TabContent tab={tab} />
        </Suspense>
      </main>

      {/* Mobile bottom navigation */}
      <nav
        aria-label="Sections"
        className="sm:hidden fixed bottom-0 inset-x-0 z-30 bg-surface/95 backdrop-blur border-t border-border pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="grid grid-cols-5">
          {TABS.map((t) => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => go(t.id)}
                  aria-current={active ? 'page' : undefined}
                  // 56px tall: comfortably above the 44px minimum touch target.
                  className={`w-full h-14 flex flex-col items-center justify-center gap-0.5 ${
                    active ? 'text-accent' : 'text-muted'
                  }`}
                >
                  <Icon />
                  <span className="text-[10px] leading-none">{t.label}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}

/**
 * Refresh status. Silent when nothing is happening — a permanent green tick is
 * noise. Only speaks up while working, or when a provider failed and some
 * number on screen is therefore older than it looks.
 */
function SyncStatus({
  sync,
  className = '',
}: {
  sync: ReturnType<typeof useMarketDataSync>
  className?: string
}) {
  if (sync.running) {
    return (
      <span className={`text-[11px] text-muted ${className}`} role="status">
        <span aria-hidden>&#183;&#183;&#183;</span> Updating prices
      </span>
    )
  }
  const failed = sync.error !== null || sync.quotesFailed > 0
  if (!failed) return null
  return (
    <a
      href="#/data"
      className={`text-[11px] text-warn hover:underline ${className}`}
      title={sync.error ?? `${sync.quotesFailed} price lookup(s) failed`}
    >
      ! Prices out of date
    </a>
  )
}

function TabFallback() {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="h-28 rounded-xl border border-border bg-surface animate-pulse" />
      <div className="h-48 rounded-xl border border-border bg-surface animate-pulse" />
    </div>
  )
}

function TabContent({ tab }: { tab: TabId }) {
  switch (tab) {
    case 'overview':
      return <Overview />
    case 'income':
      return <Income />
    case 'forecast':
      return <Forecast />
    case 'holdings':
      return <Holdings />
    case 'data':
      return <Data />
  }
}

/* Icons: inline 20px strokes. Inlined rather than pulled from a package —
   five glyphs do not justify an icon dependency in a PWA bundle. */

const ico = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

function PieIcon() {
  return (
    <svg {...ico}>
      <path d="M12 3a9 9 0 1 0 9 9h-9V3Z" />
      <path d="M15.5 3.5A9 9 0 0 1 20.5 8.5L15.5 10V3.5Z" />
    </svg>
  )
}
function CoinsIcon() {
  return (
    <svg {...ico}>
      <ellipse cx="9" cy="6.5" rx="6" ry="2.8" />
      <path d="M3 6.5v4c0 1.5 2.7 2.8 6 2.8s6-1.3 6-2.8v-4" />
      <path d="M9 13.3v4c0 1.5 2.7 2.8 6 2.8s6-1.3 6-2.8v-6.4" />
      <ellipse cx="15" cy="10.9" rx="6" ry="2.8" />
    </svg>
  )
}
function CalendarIcon() {
  return (
    <svg {...ico}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  )
}
function ListIcon() {
  return (
    <svg {...ico}>
      <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  )
}
function DatabaseIcon() {
  return (
    <svg {...ico}>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  )
}
