import { lazy, Suspense, useEffect, useState } from 'react'

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

export function App() {
  const [tab, go] = useHashRoute()

  useEffect(() => {
    const active = TABS.find((t) => t.id === tab)
    document.title = active ? `${active.label} · Portly` : 'Portly'
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
        </div>
      </header>

      {/* Mobile title bar */}
      <header className="sm:hidden sticky top-0 z-30 bg-bg/90 backdrop-blur border-b border-border">
        <div className="h-12 px-4 flex items-center">
          <span className="font-semibold tracking-tight">
            {TABS.find((t) => t.id === tab)?.label ?? 'Portly'}
          </span>
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
