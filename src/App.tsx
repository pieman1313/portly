import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useMarketDataSync } from './ui/useMarketDataSync'
import { ArrangeButton } from './ui/cards/ArrangeButton'
import { Logo } from './ui/components/Logo'
import { CardsProvider, useCards } from './ui/cards/useCardLayout'

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
 * Navigation is mobile-first: a thumb-reachable bar floating above the bottom
 * of the screen on small screens, a top bar from `sm` up. Both render the same
 * five destinations in the same order, so muscle memory survives a rotation.
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
          // `[data-no-swipe]` is carried by the arrange sheet's root. A reorder
          // drag is a horizontal drift on a button, which passes every threshold
          // below, and this listener is passive — so `touch-action: none` on the
          // grip cannot help. That governs whether the BROWSER pans, not whether
          // we measure. It states the broader rule correctly too: no swipe
          // inside a modal should change tabs.
          'input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="slider"], [data-no-swipe]',
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

/**
 * The provider renders no DOM, so it can sit here without becoming an element
 * between <main> and a tab root — which the mobile snap CSS would notice.
 */
export function App() {
  return (
    <CardsProvider>
      <AppShell />
    </CardsProvider>
  )
}

function AppShell() {
  const [tab, go] = useHashRoute()
  // Mounted once, here, so prices refresh on open and after every import
  // regardless of which tab the user happens to be looking at.
  const sync = useMarketDataSync()
  const { close } = useCards()

  useTabSwipe(tab, go)

  useEffect(() => {
    const active = TABS.find((t) => t.id === tab)
    document.title = active ? `${active.label} · Portly` : 'Portly'
  }, [tab])

  // A bottom-nav tap while the arrange sheet is open would otherwise leave it
  // describing a tab that is no longer rendered.
  useEffect(() => {
    close()
  }, [tab, close])

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

      {/* Desktop / tablet navigation. `sticky` is already a positioned
          ancestor, so RefreshLine can hang off the bottom edge of it — do not
          add `relative` here, it is the same CSS property and would unstick the
          bar. */}
      <header className="hidden sm:block sticky top-0 z-30 bg-bg/90 backdrop-blur border-b border-border">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-6">
          <span className="flex items-center gap-2 font-semibold tracking-tight">
            <Logo size={22} />
            Portly
          </span>
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
          {/* One right-hand group, not two `ml-auto` items: the group's right
              edge is the bar's right edge, so anything the status has to say
              grows leftwards and the gear does not move. */}
          <div className="ml-auto flex items-center gap-3">
            <SyncStatus sync={sync} />
            <ArrangeButton tab={tab} />
          </div>
        </div>
        <RefreshLine active={sync.running} />
      </header>

      {/* Mobile title bar */}
      <header className="sm:hidden sticky top-0 z-30 bg-bg/90 backdrop-blur border-b border-border">
        <div className="h-12 px-4 flex items-center gap-3">
          {/* `flex-1`, so the title takes the slack and the gear stays welded to
              the right edge whether or not the status has anything to say. */}
          <span className="flex-1 flex items-center gap-2 min-w-0 font-semibold tracking-tight">
            <Logo size={20} />
            <span className="truncate">{TABS.find((t) => t.id === tab)?.label ?? 'Portly'}</span>
          </span>
          <SyncStatus sync={sync} />
          <ArrangeButton tab={tab} />
        </div>
        <RefreshLine active={sync.running} />
      </header>

      <main
        id="main"
        // Bottom padding clears the floating mobile tab bar, the gap it floats
        // above the screen edge, and the iOS home indicator. 4.5rem is a
        // CONTRACT with `scroll-padding-bottom` in src/index.css, which has to
        // reserve exactly the same strip: it is what puts the end-aligned snap
        // position of the last card at the page's own maximum scroll. Change
        // one and the end of every tab goes a tab bar's height out of reach.
        // `flex flex-col` so a single child can ask to fill the remaining
        // height — the no-data hero centres itself in whatever is left. It
        // changes nothing for a tab with content: a column flex container with
        // one auto-height child lays out the same as a block, and the snap
        // selectors are all keyed on `main > div > *`, which is untouched.
        className="flex-1 flex flex-col w-full max-w-6xl mx-auto px-3 sm:px-4 py-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-8"
      >
        <Suspense fallback={<TabFallback />}>
          <TabContent tab={tab} />
        </Suspense>
      </main>

      {/*
        Mobile bottom navigation: a capsule floating clear of the screen edge
        rather than a slab welded to it.

        The strip AROUND the capsule is `pointer-events-none`. A full-width
        fixed element that reaches the bottom of the viewport eats every tap in
        the margin beside and below the pill, and on this app that margin sits
        over the last card of a scrolled page.

        Both insets are honoured rather than one: `pb` carries the iOS home
        indicator, which the capsule floats above rather than through, and the
        4.5rem `main` reserves above covers the capsule, the gap and 0.5rem of
        clearance so the last card stops short of it instead of under it.
      */}
      <nav
        aria-label="Sections"
        className="sm:hidden fixed bottom-0 inset-x-0 z-30 pointer-events-none px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
      >
        {/* `p-1`, so a current-tab capsule sits INSIDE the bar rather than
            butting up against its rim — the two radii are concentric that way
            and the ends of the bar stay clean. The item loses those 8px of
            height and not the bar, which is how the strip this reserves stays
            the 4.5rem `main` and the snap block both bank on. */}
        <ul
          className="pointer-events-auto mx-auto max-w-sm flex p-1 rounded-full border border-border
                     bg-surface/85 backdrop-blur-xl shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
        >
          {TABS.map((t) => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <li key={t.id} className="flex-1">
                <button
                  type="button"
                  onClick={() => go(t.id)}
                  aria-current={active ? 'page' : undefined}
                  // 48px tall inside the bar's 4px of padding: still clear of
                  // the 44px minimum touch target, and the bar comes to 56px
                  // between its rims.
                  //
                  // `rounded-full` on the button as well as on the bar, so the
                  // current-tab capsule and the focus ring follow the shape of
                  // the ends rather than squaring them off. The ring is INSET
                  // for the same reason: an outset one would draw outside the
                  // bar it belongs to.
                  //
                  // The current tab wears that capsule and INK text rather than
                  // accent-coloured text. Accent measures 4.90:1 on this bar
                  // over the page, and 3.99:1 where the blur picks up a chart
                  // behind it — under the 4.5:1 that 10px text needs, and it was
                  // only the old bar's opacity keeping it above the line. Ink on
                  // the capsule is 12.55:1 and 10.12:1 in those same two places,
                  // and the capsule says "you are here" by SHAPE, which colour
                  // alone never did.
                  className={`w-full h-12 rounded-full flex flex-col items-center justify-center gap-1
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                      active ? 'bg-accent/15 text-ink' : 'text-muted'
                    }`}
                >
                  <Icon />
                  {/* Never wraps. The bar's height is load-bearing — `main` and
                      the snap block both reserve 4.5rem for it — and a label
                      that took a second line would grow the bar into the strip
                      they reserved without either of them knowing. */}
                  <span className="text-[10px] leading-none whitespace-nowrap">{t.label}</span>
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
 * noise.
 *
 * A refresh in flight takes NO ROOM in the bar. It used to read "··· Updating
 * prices", which gave the header two layouts — one with the phrase and one
 * without — so the title lost a third of its width and the controls beside it
 * slid sideways twice a refresh, for a background job nobody asked to watch.
 * What is left here is the announcement; the visible half is <RefreshLine/>,
 * which is 2px tall and lays nothing out.
 *
 * A FAILURE still gets a control, because then some number on screen is older
 * than it looks and there is somewhere to go about it.
 */
function SyncStatus({ sync }: { sync: ReturnType<typeof useMarketDataSync> }) {
  // Mounted whether or not it has anything to say. A live region inserted at
  // the same moment its text appears is announced by some screen readers and
  // swallowed by others; one that is already sitting there is announced by all
  // of them. `sr-only` is out of flow, so an empty one costs no width.
  const status = (
    <span role="status" aria-live="polite" className="sr-only">
      {sync.running ? 'Updating prices' : ''}
    </span>
  )

  // Hidden while a refresh runs. `quotesFailed` survives from the previous run
  // into the next one, so without this the warning would sit there contradicting
  // the sweep of the refresh that is busy fixing it.
  const failed = !sync.running && (sync.error !== null || sync.quotesFailed > 0)
  if (!failed) return status

  return (
    <>
      {status}
      {/* Icon-only below `sm`, where the row is 48px and the title needs the
          width. The glyph, not the amber, is what carries the meaning — the
          colour is reinforcement, and the name says it in words. That name is
          exactly the visible label from `sm` up, so "tap Prices out of date"
          still works by voice. */}
      <a
        href="#/data"
        aria-label="Prices out of date"
        title={sync.error ?? `${sync.quotesFailed} price lookup(s) failed`}
        className="shrink-0 min-h-[44px] inline-flex items-center gap-1.5 text-[11px] text-warn hover:underline"
      >
        <WarnIcon />
        <span aria-hidden className="hidden sm:inline">
          Prices out of date
        </span>
      </a>
    </>
  )
}

/**
 * Prices are refreshing: a segment sweeping the bottom edge of the header.
 *
 * A line rather than a line of text. It occupies no row, so it cannot push a
 * control sideways as it comes and goes; it is legible from across the room on
 * a phone; and it is the shape every browser already uses for "fetching", so
 * there is nothing to learn. `transform` only, so it composites on its own and
 * never lays the header out again.
 *
 * `aria-hidden`: a moving rectangle is not worth describing, and SyncStatus's
 * live region has already said it in words.
 */
function RefreshLine({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
      <div
        data-sweep
        className="h-full w-2/5 rounded-full bg-accent animate-[price-sweep_1.5s_cubic-bezier(.4,0,.6,1)_infinite]"
      />
    </div>
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
   six glyphs do not justify an icon dependency in a PWA bundle. */

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

/** Smaller than the rest: it sits beside 11px text, not beside a tab label. */
function WarnIcon() {
  return (
    <svg {...ico} width={16} height={16}>
      <path d="M12 4.4 21 20H3L12 4.4Z" />
      <path d="M12 10.2v3.4M12 16.8h.01" />
    </svg>
  )
}
