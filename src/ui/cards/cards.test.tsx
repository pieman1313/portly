import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installBrowserStubs, renderTab } from '../../test/render'
import { importStatementText } from '../../db/import'
import { db } from '../../db/schema'
import { STORE_KEY } from './layout'
import { Card } from '../components/primitives'
import { App } from '../../App'
import type { TabId } from '../../App'

/**
 * Card arrangement, end to end through the real tabs.
 *
 * Everything here goes through <App /> rather than a harness, because the three
 * things this feature can break are all properties of the whole page and none
 * of them is visible from a component in isolation: the SHAPE of the tab root
 * (every card a direct child of `main > div`, which is what every mobile
 * scroll-snap rule in index.css is keyed on), the ISOLATION of a reorder drag
 * from the tab-swipe hook bound to window, and the SURVIVAL of state across a
 * collapse.
 *
 * Every one of those fails silently. A wrapper div around the cards costs
 * nothing visible on a laptop and takes the end of the page away on a phone; a
 * horizontal drift during a reorder navigates to another tab, at which point
 * the sheet is describing a tab that is no longer rendered; a `keepMounted`
 * dropped from the policy table rebuilds the payments matrix and seventeen
 * table rows on every expand, and nothing anywhere reports it.
 *
 * ── Not tested, and why ─────────────────────────────────────────────────────
 *
 *   - The pointer drag's GEOMETRY. jsdom reports every `getBoundingClientRect()`
 *     as zeros and never loads Tailwind, so a lifted row travels through a list
 *     whose rows are all at y=0 and whose box has height 0 — which also makes
 *     the auto-scroll edge band dead code here. That is exactly why `dropIndex`,
 *     `shiftFor` and `moveAt` are pure functions of (from, dy, count) and are
 *     tested in the node suite instead. `setPointerCapture` does not exist
 *     either; the code calls it optionally, so nothing needs stubbing, but a
 *     capture-retargeting bug cannot be caught from here.
 *
 *   - Whether a collapsed `keepMounted` body is actually INVISIBLE. That is
 *     `hidden` → `display: none`, which needs the stylesheet, so every role
 *     query below still sees straight through it. The two halves of collapse are
 *     therefore asserted differently: an unmounting card by its body element
 *     going empty, and a keepMounted one by its rows still being there while it
 *     is shut, plus the `hidden` class on the body.
 *
 *   - WHICH of the two Arrange buttons takes focus when the sheet closes. Both
 *     headers are in the DOM — one is `hidden sm:block`, the other `sm:hidden`
 *     — and with no CSS loaded both are focusable, so the later effect wins. In
 *     a browser `focus()` on a `display: none` element is a no-op and the
 *     visible one wins. The test asserts focus lands on one of them.
 *
 *   - An effect-based read in the PROVIDER, as opposed to in a tab. Under
 *     `act()` React flushes passive effects before render() returns, and the
 *     provider paints no DOM of its own while every tab is a lazy chunk — so
 *     that particular mistake lands before the first card exists and is
 *     invisible from here as well as, for the same reason, on a real phone. The
 *     first-render test below catches the version that does show: a stored
 *     layout applied from inside the tab.
 *
 *   - The `lockReason` "The last card on a tab cannot be hidden". It is
 *     unreachable while every tab ships at least one card that is not hideable
 *     at all, which is the invariant that belongs in the node suite. The floor
 *     itself is asserted below, from the other side: hide everything hideable
 *     and a card is still standing.
 */

// Resolved from the project root, not import.meta.url: under the jsdom
// environment import.meta.url is an http: URL and fileURLToPath rejects it.
const FIXTURE = readFileSync(
  resolve(process.cwd(), 'src/test/fixtures/activity-basic.csv'),
  'utf8',
)

/**
 * The shared fixture pays three dividends, and three rows never reach Recent
 * payments' 12-row batch — so the reveal count, which is one of the two pieces
 * of state `keepMounted` exists to protect, would have nothing to reveal. These
 * fourteen extra payments put it at 17, one full batch plus a remainder. They
 * break the statement's own dividend total, which is a reconciliation line on
 * the Data tab and nothing this file looks at.
 */
const ANCHOR =
  'Dividends,Data,USD,2025-10-10,ACME(US0000000002) Cash Dividend USD 0.35 per Share (Mixed Income),35.09'
const EXTRA = Array.from(
  { length: 14 },
  (_, i) =>
    `Dividends,Data,USD,2025-09-${String(i + 1).padStart(2, '0')},ACME(US0000000002) Cash Dividend USD 0.1${i} per Share (Ordinary Dividend),${10 + i}.00`,
).join('\n')
const STATEMENT = FIXTURE.replace(ANCHOR, `${ANCHOR}\n${EXTRA}`)

/** Anything that reaching the DOM means we have a bug, not a display choice. */
const POISON = /\bNaN\b|\bundefined\b|\bInfinity\b|\[object Object\]/

const TAB_IDS: TabId[] = ['overview', 'income', 'forecast', 'holdings', 'data']

function pageText(): string {
  return document.body.textContent ?? ''
}

function expectNoPoison(): void {
  const text = pageText()
  const hit = text.match(POISON)
  expect(hit ? `rendered ${hit[0]} in: ${text.slice(Math.max(0, (hit.index ?? 0) - 80), (hit.index ?? 0) + 80)}` : null).toBeNull()
}

/** jest-dom is not installed, so read the property the pager actually sets. */
function disabled(label: string): boolean {
  const el = screen.getByLabelText(label)
  return el instanceof HTMLButtonElement && el.disabled
}

/** The same question for a control named by an sr-only child rather than a label. */
const isDisabled = (el: Element): boolean => el instanceof HTMLButtonElement && el.disabled

beforeAll(() => {
  installBrowserStubs()
})

async function wipe(): Promise<void> {
  await Promise.all([
    db.rawFiles.clear(), db.rawRows.clear(), db.instruments.clear(),
    db.transactions.clear(), db.distributions.clear(), db.accruals.clear(),
    db.cashEvents.clear(), db.positions.clear(), db.fxRates.clear(), db.settings.clear(),
  ])
}

beforeEach(async () => {
  // jsdom does NOT reset localStorage between tests in a file, so without this
  // every test inherits the previous one's arrangement.
  localStorage.clear()
  // Cheap after the first test: a second import of the same bytes is answered
  // by the sha256 check before anything is parsed. Restores the database for
  // whichever test wiped it, whatever order they run in.
  await importStatementText(STATEMENT, 'activity-basic.csv')
  // The sheet's aria-hidden belt looks for #root, which index.html provides and
  // a test container does not.
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
})

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
  window.location.hash = ''
})

// ─────────────────────────────────────────────────────────────────────────────
// Page helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The header controls, not the "Arrange cards" link in the hidden-count row. */
const arrangeButtons = (): HTMLElement[] =>
  screen
    .getAllByRole('button', { name: /^Arrange cards/ })
    .filter((b) => b.getAttribute('aria-haspopup') === 'dialog')

/**
 * A mounted CardStack is what publishes the header button, so its presence is
 * the one readiness signal that means "this tab is past its skeleton and its
 * empty state" on all five tabs.
 */
/**
 * Testing Library's default `waitFor` budget is 1000ms, and that is not enough
 * here — not because anything is slow but because of what is being waited for:
 * a lazily imported route chunk, then fake-indexeddb, then a Dexie liveQuery,
 * then the derivation that liveQuery feeds. This file runs in about 7s on a
 * laptop and took 14s on the CI runner, and at 1s the first test in the file
 * (which pays every route chunk's import cost) failed there while passing
 * locally every time. Reproduced by starving this budget to 30ms, which
 * produces the identical "Unable to find role=button" error.
 *
 * So: a budget with real headroom over the observed 2x, and `testTimeout` in
 * vite.config.ts raised to match, because the five-tab loop below spends this
 * wait five times in one test.
 */
const READY_TIMEOUT = 5000

async function ready(tab: TabId): Promise<void> {
  await waitFor(() => expect(arrangeButtons().length).toBeGreaterThan(0), {
    timeout: READY_TIMEOUT,
  })
  if (tab === 'income') {
    // Income declares its FX warning from the first liveQuery emission, before
    // the statement's 794 derived FX rates have loaded, and drops it once they
    // have. Its card SET is only stable once that note has gone, and a test
    // that read the order in between would be reading a different tab.
    await waitFor(() => expect(screen.queryByText(/could not be converted/)).toBeNull(), {
      timeout: READY_TIMEOUT,
    })
  }
}

async function show(tab: TabId): Promise<void> {
  window.location.hash = `#/${tab}`
  renderTab(<App />)
  await ready(tab)
}

const tabRoot = (): HTMLElement => {
  const main = document.querySelector('main')
  const root = main?.firstElementChild
  if (!(root instanceof HTMLElement)) throw new Error('tab root not rendered')
  return root
}

/**
 * The tab root's children, identified well enough that a permutation of two
 * untitled blocks is visible. Headings first, because a collapse drops the
 * subtitle and would otherwise read as a reorder.
 */
const outline = (): string[] =>
  [...tabRoot().children].map((el) => {
    const heading = el.querySelector('h1,h2')?.textContent ?? ''
    return `${el.tagName}:${heading || (el.textContent ?? '').slice(0, 24)}`
  })

/** The cards themselves: not the sr-only lead heading, not the hidden-count row. */
const cardsOnPage = (): Element[] =>
  [...tabRoot().children].filter(
    (el) => el.tagName !== 'H1' && !/\d+ cards? hidden/.test(el.textContent ?? ''),
  )

// ─────────────────────────────────────────────────────────────────────────────
// Sheet helpers
// ─────────────────────────────────────────────────────────────────────────────

async function openSheet(): Promise<HTMLElement> {
  const button = arrangeButtons()[0]
  if (button === undefined) throw new Error('no Arrange button')
  fireEvent.click(button)
  // Lazy-loaded, so the dialog arrives a microtask later.
  return await screen.findByRole('dialog')
}

const sheetRoot = (): HTMLElement => {
  const dialog = screen.getByRole('dialog')
  const root = dialog.parentElement
  if (!(root instanceof HTMLElement)) throw new Error('sheet not portaled')
  return root
}

const eyes = (): HTMLElement[] =>
  within(screen.getByRole('dialog')).getAllByRole('button', { name: /^(Hide|Show) / })

const grips = (): HTMLElement[] =>
  within(screen.getByRole('dialog')).getAllByRole('button', { name: /^Reorder / })

const liveText = (): string =>
  within(screen.getByRole('dialog')).getByRole('status').textContent ?? ''

const eye = (label: string): HTMLElement =>
  within(screen.getByRole('dialog')).getByRole('button', {
    // Anchored at both ends, or "Import" also matches "Imported statements".
    name: new RegExp(`^(Hide|Show) ${label}(\\.|$)`),
  })

/** Select a row, which is what reveals the footer move buttons. */
const selectRow = (label: string): void => {
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: label }))
}

const move = (which: 'Up' | 'Down' | 'To top'): void => {
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: which }))
}

/**
 * A single-finger touch gesture. jsdom has no `Touch` constructor, so the
 * touch lists are hand-built plain objects — which is all `useTabSwipe` reads.
 */
function touch(
  target: Element,
  type: 'touchstart' | 'touchmove' | 'touchend',
  x: number,
  y: number,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const list = [{ clientX: x, clientY: y }]
  Object.assign(
    event,
    type === 'touchend' ? { touches: [], changedTouches: list } : { touches: list, changedTouches: list },
  )
  target.dispatchEvent(event)
}

/**
 * 100px of x against 50px of y, led with x. That passes every gate in
 * useTabSwipe — |dx| >= 60, |dx| > 1.5|dy|, and the vertical lock never trips
 * because y never dominated — so anywhere this does NOT navigate, something
 * deliberately stopped it.
 */
function drift(target: Element): void {
  touch(target, 'touchstart', 200, 300)
  touch(target, 'touchmove', 300, 350)
  touch(target, 'touchend', 300, 350)
}

const seed = (
  tabs: Partial<Record<TabId, { order?: string[]; collapsed?: string[]; hidden?: Record<string, string> }>>,
): void =>
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      v: 1,
      tabs: Object.fromEntries(
        Object.entries(tabs).map(([tab, t]) => [
          tab,
          { order: t?.order ?? [], collapsed: t?.collapsed ?? [], hidden: t?.hidden ?? {} },
        ]),
      ),
    }),
  )

const OVERVIEW_ORDER = [
  'portfolio-value',
  'key-figures',
  'allocation-holding',
  'allocation-currency',
  'dividends-12m',
  'data-quality',
]

// ─────────────────────────────────────────────────────────────────────────────

describe('scroll-snap structure', () => {
  it('keeps every card a direct child of the tab root, on all five tabs', async () => {
    // The whole mobile snap block in index.css is keyed on `main > div > *`. One
    // element between <main> and the card list re-points `main > div` at it, and
    // `main > div > :last-child section` (0,1,3) then beats
    // `main > div > * > section` (0,0,3) and sets scroll-snap-align: none on
    // every card in the app. Nothing else guards that, and it is invisible on a
    // laptop.
    for (const tab of TAB_IDS) {
      // Hash first, then mount — the order `show()` uses. Mounting first makes
      // the route depend on a `hashchange` that does not fire at all when the
      // hash already holds the value being assigned.
      window.location.hash = `#/${tab}`
      const { unmount } = renderTab(<App />)
      await ready(tab)
      const main = document.querySelector('main')
      expect(main).not.toBeNull()
      expect(main?.children.length).toBe(1)
      const root = tabRoot()
      expect(root.className).toContain('space-y-4')
      const strays = [...root.querySelectorAll('section')].filter((s) => s.parentElement !== root)
      expect(strays.map((s) => `${tab}: ${s.querySelector('h2')?.textContent ?? '(untitled)'}`)).toEqual([])
      expect(root.querySelectorAll('section').length).toBeGreaterThan(0)
      expectNoPoison()
      unmount()
    }
  })

  it('unmounts a hidden card rather than hiding it', async () => {
    // A boxless last child has no snap area, so the end of the page becomes
    // unreachable — measured on Forecast at 2031 of a possible 2103, a
    // permanent 72px short, which is the height of the tab bar the last card
    // then stayed behind.
    await show('income')
    const last = cardsOnPage().at(-1)
    expect(last?.querySelector('h2')?.textContent).toBe('Recent payments')

    await openSheet()
    fireEvent.click(eye('Recent payments'))

    expect(document.contains(last ?? null)).toBe(false)
    expect(screen.queryByRole('heading', { level: 2, name: 'Recent payments' })).toBeNull()
    const tail = tabRoot().lastElementChild
    expect(tail?.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    expect(tail instanceof HTMLElement ? tail.style.display : '').not.toBe('none')
  })

  it('keeps a collapsed card in the page, so the end-aligned snap point stays on it', async () => {
    await show('income')
    const last = cardsOnPage().at(-1)
    expect(last?.querySelector('h2')?.textContent).toBe('Recent payments')
    expect(last?.className).toContain('max-h-[75vh]')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Recent payments' }))

    expect(tabRoot().lastElementChild).toBe(last)
    // Collapsed there is no body to cap, and leaving the cap on would let a long
    // title wrap into a 75vh box with nothing under it.
    expect(last?.className).not.toContain('max-h-[75vh]')
  })

  it('portals the arrange sheet out of the card list', async () => {
    // A position: fixed element contributes no snap area but still matches
    // :last-child, so a sheet rendered in the list would silently demote the
    // real last card even while it was closed.
    await show('overview')
    const dialog = await openSheet()
    expect(dialog.closest('main')).toBeNull()
    const chain: Element[] = []
    for (let el = dialog.parentElement; el !== null; el = el.parentElement) chain.push(el)
    // Straight into body: the sheet's own root, then nothing. Not through #root
    // either, which the sheet marks aria-hidden while it is open.
    expect(chain[0]?.hasAttribute('data-no-swipe')).toBe(true)
    expect(chain[1]).toBe(document.body)
    expect(chain.some((el) => el.id === 'root')).toBe(false)
  })

  it('permutes the DOM to reorder, rather than reaching for CSS order', async () => {
    // `:last-child` reads DOM order, and so does `space-y-4`, which Tailwind
    // compiles to `& > * + * { margin-top }`. CSS order or column-reverse would
    // leave both reading the original sequence.
    await show('income')
    const before = outline()
    await openSheet()
    selectRow('Grouping and basis')
    move('Down')

    const after = outline()
    expect(after).not.toEqual(before)
    expect([...after].sort()).toEqual([...before].sort())
    for (const el of tabRoot().children) {
      expect(el.getAttribute('style') ?? '').not.toMatch(/(^|;|\s)order\s*:/)
      expect(el.className.toString()).not.toMatch(/(^|\s)order-/)
    }
  })

  it('keeps the sr-only heading first after a reorder and a hide', async () => {
    // The document outline, and the `:first-child` whose scroll-margin index.css
    // widens to pin the top of the page as a place you can stand.
    for (const [tab, heading] of [
      ['overview', 'Overview'],
      ['holdings', 'Holdings'],
      ['data', 'Data'],
    ] as const) {
      const { unmount } = renderTab(<App />)
      window.location.hash = `#/${tab}`
      await ready(tab)
      await openSheet()

      // Reorder before hiding: Holdings ships two cards, and hiding one first
      // would leave nothing to move it past.
      const label = (grips()[0]?.textContent ?? '')
        .replace(/^Reorder /, '')
        .replace(/, position.*$/, '')
      selectRow(label)
      move('Down')
      const openEye = eyes().find((e) => !isDisabled(e))
      expect(openEye).toBeDefined()
      if (openEye !== undefined) fireEvent.click(openEye)

      const lead = tabRoot().firstElementChild
      expect(lead?.tagName).toBe('H1')
      expect(lead?.textContent).toBe(heading)
      expect(lead?.className).toContain('sr-only')
      unmount()
    }
  })

  it('contains the sheet list on the vertical axis only', async () => {
    // `overscroll-contain` blocks scroll chaining on BOTH axes, which is the
    // exact mistake this codebase has already reverted twice — most recently on
    // the payments matrix, where it left a vertical swipe unable to reach the
    // page at all.
    await show('overview')
    await openSheet()
    const list = screen.getByRole('list', { name: 'Card order' })
    expect(list.className).toContain('overscroll-y-contain')
    expect(list.className).not.toMatch(/(^|\s)overscroll-contain(\s|$)/)
  })

  it('adds no horizontal scroller anywhere in the sheet', async () => {
    // A horizontal strip in here would be the first phone-visible horizontal
    // scroller in the app, and a 45-degree thumb drag over one moves the page
    // 0px until the finger lifts.
    await show('overview')
    await openSheet()
    const root = sheetRoot()
    const offenders = [root, ...root.querySelectorAll('*')].filter((el) =>
      /overflow-(x-)?(auto|scroll)/.test(el.className.toString()),
    )
    expect(offenders.map((el) => el.className.toString())).toEqual([])
    expect(screen.getByRole('list', { name: 'Card order' }).className).toContain('overflow-y-auto')
  })

  it('nests no card inside another block on Forecast', async () => {
    // Regression guard for the dissolved grid. Three cards inside one grid track
    // were one end-aligned snap point between them: `main > div > :last-child
    // section` zeroed all three at once, so the whole lower third of the tab had
    // a single resting position and Next payments could not be stopped on.
    await show('forecast')
    const root = tabRoot()
    expect(root.querySelectorAll('section section').length).toBe(0)
    expect([...root.children].filter((el) => el.querySelector('section') !== null)).toEqual([])
    expect(cardsOnPage().length).toBe(7)
  })
})

describe('tab-swipe isolation', () => {
  it('does not switch tabs when a reorder drag drifts sideways', async () => {
    // The gesture below passes every gate in useTabSwipe, and that hook is
    // passive and reads raw clientX/clientY — so `touch-action: none` on the
    // grip cannot help, because it governs whether the BROWSER pans, not whether
    // we measure. `[data-no-swipe]` on the sheet root is the whole fix.
    await show('income')
    await openSheet()
    const grip = grips()[0]
    expect(grip).toBeDefined()
    if (grip !== undefined) drift(grip)
    expect(window.location.hash).toBe('#/income')
    expect(screen.queryByRole('dialog')).not.toBeNull()
  })

  it('still switches tabs for the same drag over a card body', async () => {
    // The negative control, so the bail-out cannot be over-applied to the page.
    await show('income')
    drift(screen.getByRole('heading', { level: 2, name: 'Recent payments' }))
    // Dragging right asks for the tab to the left of Income.
    await waitFor(() => expect(window.location.hash).toBe('#/overview'))
  })

  it('marks the sheet and its touch targets', async () => {
    await show('overview')
    await openSheet()
    expect(sheetRoot().hasAttribute('data-no-swipe')).toBe(true)
    // Scoped to the 44px grip so the row and the list still scroll normally, and
    // to the scrim, which is the entire page-lock strategy.
    expect(grips()[0]?.className).toContain('touch-none')
    expect(screen.getByRole('button', { name: 'Close arrange cards' }).className).toContain(
      'touch-none',
    )
  })
})

describe('collapse', () => {
  it('collapses a card to its header and drops its body', async () => {
    await show('overview')
    const toggle = screen.getByRole('button', { name: 'Collapse Dividends received' })
    const bodyId = toggle.getAttribute('aria-controls')
    expect(bodyId).not.toBeNull()
    const body = bodyId === null ? null : document.getElementById(bodyId)
    expect(body?.childElementCount).toBeGreaterThan(0)

    fireEvent.click(toggle)

    const expand = screen.getByRole('button', { name: 'Expand Dividends received' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    // A dangling aria-controls is worse than none: the body is out of the
    // accessibility tree entirely.
    expect(expand.hasAttribute('aria-controls')).toBe(false)
    expect(body?.isConnected).toBe(true)
    expect(body?.childElementCount).toBe(0)
    // Collapsed, the header IS the card, and it still says what it is.
    expect(screen.getByRole('heading', { level: 2, name: 'Dividends received' })).toBeDefined()
  })

  it('keeps the reveal count in Recent payments across a collapse', async () => {
    // Collapse-then-expand is a routine navigation move on a phone — a way to
    // reach past a card, not a farewell — so the reveal count has to come back
    // the way it was left.
    //
    // The mid-collapse assertion is the one that pins `keepMounted`: with the
    // flag the body is still in the tree behind `hidden`, and without it the
    // rows are gone (measured: 18 rows against 0). The count on the way OUT
    // does not pin it, and it is worth knowing why — `shown` lives in
    // RecentPayments, which RENDERS the Card, so it sits above the body the
    // collapse drops and survives an unmount on its own.
    await show('income')
    const section = (): HTMLElement => {
      const el = screen.getByRole('heading', { level: 2, name: 'Recent payments' }).closest('section')
      if (!(el instanceof HTMLElement)) throw new Error('Recent payments not rendered')
      return el
    }
    const rows = (): number => within(section()).getAllByRole('row').length
    const batch = rows()

    fireEvent.click(screen.getByRole('button', { name: /^Show \d+ more of \d+$/ }))
    const revealed = rows()
    expect(revealed).toBeGreaterThan(batch)

    const toggle = screen.getByRole('button', { name: 'Collapse Recent payments' })
    const bodyId = toggle.getAttribute('aria-controls')
    fireEvent.click(toggle)
    expect(rows()).toBe(revealed)
    expect(bodyId === null ? '' : document.getElementById(bodyId)?.className).toMatch(
      /(^|\s)hidden(\s|$)/,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand Recent payments' }))
    expect(rows()).toBe(revealed)
    expectNoPoison()
  })

  it('keeps the paged month window in the payments matrix across a collapse', async () => {
    await show('income')
    const monthWindow = (): string => {
      const group = [...document.querySelectorAll('[role="group"]')].find((el) =>
        (el.getAttribute('aria-label') ?? '').startsWith('Payments matrix,'),
      )
      return group?.getAttribute('aria-label') ?? ''
    }
    // Opens on the most recent months; there is somewhere to page back to.
    const landed = monthWindow()
    expect(landed).toMatch(/^Payments matrix, /)
    expect(disabled('Show earlier months')).toBe(false)

    fireEvent.click(screen.getByLabelText('Show earlier months'))
    const paged = monthWindow()
    expect(paged).not.toBe(landed)

    // Collapsed, the window is still in the tree rather than rebuilt on the way
    // back — the `keepMounted` half of this. `start` itself lives in MatrixCard,
    // which renders the Card, so it is above the body either way.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Payments matrix' }))
    expect(monthWindow()).toBe(paged)
    fireEvent.click(screen.getByRole('button', { name: 'Expand Payments matrix' }))
    expect(monthWindow()).toBe(paged)
  })

  it('clears the Positions search when that card collapses', async () => {
    // A collapsed card holding a live filter is an invisible filter, and
    // expanding it weeks later shows a three-row list with nothing on screen
    // explaining where the other positions went.
    const LABEL = 'Search holdings by symbol, name, ISIN or a previous ticker'
    await show('holdings')
    const input = screen.getByLabelText(LABEL)
    fireEvent.change(input, { target: { value: 'ACME' } })
    expect(input instanceof HTMLInputElement ? input.value : '').toBe('ACME')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Positions' }))
    expect(screen.queryByLabelText(LABEL)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand Positions' }))

    const again = screen.getByLabelText(LABEL)
    expect(again instanceof HTMLInputElement ? again.value : '').toBe('')
  })

  it('offers no collapse control on a card with no title', async () => {
    // There is no header to hang a chevron on, and the hero already owns its
    // top-left corner.
    for (const tab of ['overview', 'forecast'] as const) {
      const { unmount } = renderTab(<App />)
      window.location.hash = `#/${tab}`
      await ready(tab)
      const hero = cardsOnPage()[0]
      expect(hero?.textContent).toMatch(/(Portfolio|Projected income)/)
      expect(hero?.querySelector('header')).toBeNull()
      expect(
        within(hero as HTMLElement).queryAllByRole('button', { name: /^(Collapse|Expand) / }),
      ).toEqual([])
      unmount()
    }
  })

  it('offers no collapse control on a Card rendered outside a CardStack', () => {
    // Guards the SlotContext default directly, on the component rather than
    // through whichever screen happens to render a bare Card this month. It used
    // to go via Income's no-data state, which was a titled Card until that
    // screen became the NoData hero — the invariant did not change, only the
    // route to it, which is exactly why it is asserted at the source now.
    render(
      <Card title="Loose card" subtitle="Rendered with no provider above it">
        <p>body</p>
      </Card>,
    )
    expect(screen.getByRole('heading', { level: 2, name: 'Loose card' })).toBeDefined()
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(screen.getByText('body')).toBeDefined()
  })

  it('offers nothing to arrange on a tab with no data', async () => {
    // The other half: no stack is mounted, so the header button is absent rather
    // than present and dead, and the hero carries no card chrome at all.
    await wipe()
    window.location.hash = '#/income'
    renderTab(<App />)
    await waitFor(() => expect(pageText()).toMatch(/No dividends yet/), {
      timeout: READY_TIMEOUT,
    })
    expect(screen.queryAllByRole('button', { name: /^(Collapse|Expand) / })).toEqual([])
    expect(screen.queryAllByRole('button', { name: /^Arrange cards/ })).toEqual([])
    // The one thing it does offer.
    expect(screen.getByRole('link', { name: /Add data/ })).toBeDefined()
  })

  it('names the card in the collapse control', async () => {
    // "Collapse", alone, is what six identical buttons on one tab announce as.
    await show('overview')
    expect(screen.getByRole('button', { name: 'Collapse Allocation by holding' })).toBeDefined()
  })
})

describe('hide and restore', () => {
  it('hides a card and offers it back at its original position', async () => {
    await show('overview')
    const before = outline()
    await openSheet()

    fireEvent.click(eye('Key figures'))
    expect(screen.queryByText('Passive income')).toBeNull()
    expect(outline()).not.toEqual(before)

    fireEvent.click(eye('Key figures'))
    expect(outline()).toEqual(before)
    expectNoPoison()
  })

  it('says on the page itself that something is hidden', async () => {
    // A hidden card with no route back from the page is a bug report waiting to
    // happen: the count on the header button is easy to miss three weeks later.
    await show('overview')
    expect(screen.queryByText(/cards? hidden/)).toBeNull()
    await openSheet()

    fireEvent.click(eye('Key figures'))
    expect(screen.getByText('1 card hidden')).toBeDefined()
    fireEvent.click(eye('Allocation by currency'))
    expect(screen.getByText('2 cards hidden')).toBeDefined()

    fireEvent.click(eye('Key figures'))
    fireEvent.click(eye('Allocation by currency'))
    expect(screen.queryByText(/cards? hidden/)).toBeNull()
  })

  it('refuses to hide the only import path', async () => {
    // Disabled with a reason, rather than absent: an absent control reads as a
    // bug, and the reason is the only place "this is the only way to import a
    // statement" gets said.
    await show('data')
    await openSheet()
    const importEye = eye('Import')
    expect(isDisabled(importEye)).toBe(true)
    expect(importEye.textContent).toContain('This is the only place to do this')
    // Storage merely reports, so it is the one section on the tab that may go.
    expect(isDisabled(eye('Storage'))).toBe(false)
  })

  it('leaves a card standing when everything hideable is hidden', async () => {
    await show('overview')
    await openSheet()
    for (;;) {
      const open = eyes().find((e) => !isDisabled(e) && e.textContent?.startsWith('Hide'))
      if (open === undefined) break
      fireEvent.click(open)
    }
    // Portfolio value is not hideable at all — it is the only place that
    // explains why a total could not be worked out.
    expect(cardsOnPage().length).toBe(1)
    expect(cardsOnPage()[0]?.textContent).toMatch(/Portfolio value/)
    expect(eyes().filter((e) => e.textContent?.startsWith('Hide')).every(isDisabled)).toBe(true)
    expectNoPoison()
  })

  it('arms Reset this tab before it fires, and changes nothing on the first tap', async () => {
    // Reset is the only irreversible control in the sheet — the arrangement it
    // throws away is not recoverable — and it sits a thumb's width from the
    // move buttons. So it takes two taps, and the first one must be inert.
    await show('overview')
    await openSheet()
    fireEvent.click(eye('Key figures'))
    const arranged = outline()

    fireEvent.click(screen.getByRole('button', { name: 'Reset this tab' }))

    expect(outline()).toEqual(arranged)
    expect(screen.getByRole('button', { name: 'Tap again to reset' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Reset this tab' })).toBeNull()
    expectNoPoison()
  })

  it('restores everything on the second tap of Reset this tab', async () => {
    await show('overview')
    const before = outline()
    await openSheet()
    fireEvent.click(eye('Key figures'))
    selectRow('Allocation by holding')
    move('To top')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Dividends received' }))
    expect(outline()).not.toEqual(before)

    fireEvent.click(screen.getByRole('button', { name: 'Reset this tab' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to reset' }))

    expect(outline()).toEqual(before)
    expect(screen.getByRole('button', { name: 'Collapse Dividends received' })).toBeDefined()
    expect(screen.queryByText(/cards? hidden/)).toBeNull()
    // Disarmed again, so the next tap in that corner cannot wipe a fresh layout.
    expect(screen.getByRole('button', { name: 'Reset this tab' })).toBeDefined()
  })
})

describe('persistence', () => {
  it('persists order, collapse and hidden across a remount', async () => {
    await show('overview')
    await openSheet()
    fireEvent.click(eye('Key figures'))
    selectRow('Allocation by currency')
    move('To top')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Dividends received' }))
    const arranged = outline()

    cleanup()
    renderTab(<App />)
    await ready('overview')

    expect(outline()).toEqual(arranged)
    expect(screen.getByRole('button', { name: 'Expand Dividends received' })).toBeDefined()
    expect(screen.queryByText('Passive income')).toBeNull()
  })

  it('applies a stored layout on the first render, with no second pass', async () => {
    // The store is read synchronously in a useState initializer above <Suspense>
    // for exactly this reason: applied from an effect, a tab paints at full
    // length and then shrinks, and on a deep link there is no tab-change
    // scrollTo to hide the jump. So the assertion is not "it ends up hidden" —
    // it is that the hidden card's tree NEVER reaches the document.
    //
    // Asserted as a pair, because "it is hidden now" is exactly what a second
    // pass also looks like once it has settled: nothing containing Key figures'
    // marker is on the page at the end, AND nothing containing it was ever
    // DETACHED from the page on the way there. Together those say it was never
    // mounted at all. The detachment half is the one that bites: a detached node
    // keeps its own subtree, so its text is still readable at assert time,
    // whereas an insertion arrives as one subtree root whose text has already
    // changed by then.
    seed({ overview: { hidden: { 'key-figures': '' } } })
    const detached: string[] = []
    const record = (records: MutationRecord[]): void => {
      for (const r of records) for (const n of r.removedNodes) detached.push(n.textContent ?? '')
    }
    const observer = new MutationObserver(record)
    observer.observe(document.body, { childList: true, subtree: true })

    window.location.hash = '#/overview'
    renderTab(<App />)
    await ready('overview')
    record(observer.takeRecords())
    observer.disconnect()

    expect(screen.queryByText('Passive income')).toBeNull()
    expect(detached.filter((t) => t.includes('Passive income'))).toEqual([])
  })

  it('ignores a corrupt stored value and renders the default order', async () => {
    await show('overview')
    const fresh = outline()
    cleanup()

    // A half-written blob throws on parse; a blob from another schema is dropped
    // whole rather than half-read. A wrong arrangement is a two-tap fix; a throw
    // during render is a white screen on a tab the user cannot get off.
    for (const corrupt of ['{"v":1,"tabs":', 'null', '{"v":99,"tabs":{"overview":{"order":["dividends-12m"]}}}', '[]']) {
      localStorage.setItem(STORE_KEY, corrupt)
      renderTab(<App />)
      await ready('overview')
      expect(outline()).toEqual(fresh)
      cleanup()
    }
  })

  it('writes nothing until the user changes something', async () => {
    expect(STORE_KEY).toBe('portly.cards.v1')
    for (const tab of TAB_IDS) {
      // Hash first, then mount — the order `show()` uses. Mounting first makes
      // the route depend on a `hashchange` that does not fire at all when the
      // hash already holds the value being assigned.
      window.location.hash = `#/${tab}`
      const { unmount } = renderTab(<App />)
      await ready(tab)
      unmount()
    }
    // Reconciliation is a pure render-time function. Writing on read would mean
    // an older installed build could persist its own idea of the layout over a
    // newer one's simply by being opened.
    expect(localStorage.getItem(STORE_KEY)).toBeNull()
  })

  it('picks up a layout written by another window', async () => {
    // Two installed windows on one device would otherwise diverge until a
    // reload, with the second writer clobbering the first.
    await show('overview')
    expect(outline()[1]).toMatch(/Portfolio value/)

    seed({ overview: { order: [...OVERVIEW_ORDER].reverse() } })
    window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY }))

    await waitFor(() => expect(outline()[1]).toBe('SECTION:Data quality'))
    expect(outline()[0]).toBe('H1:Overview')
  })
})

describe('keyboard and assistive tech', () => {
  it('lifts a card, moves it, and announces each position', async () => {
    await show('overview')
    await openSheet()
    const grip = (): HTMLElement => {
      const el = grips().find((g) => g.textContent?.startsWith('Reorder Portfolio value'))
      if (el === undefined) throw new Error('grip not rendered')
      return el
    }
    grip().focus()

    fireEvent.keyDown(grip(), { key: ' ' })
    expect(liveText()).toMatch(/Position \d+ of \d+/)
    // The instructions are in the announcement, not only in the help text: a
    // lifted card is the one moment they are needed.
    expect(liveText()).toMatch(/up and down arrow keys to move, space to drop, escape to cancel/)

    fireEvent.keyDown(grip(), { key: 'ArrowDown' })
    expect(liveText()).toBe('Position 2 of 6.')

    fireEvent.keyDown(grip(), { key: ' ' })
    expect(liveText()).toMatch(/dropped at position 2 of 6/)
  })

  it('cancels a lift with Escape and keeps the sheet open', async () => {
    await show('overview')
    const before = outline()
    await openSheet()
    const grip = grips()[0]
    expect(grip).toBeDefined()
    if (grip === undefined) return

    fireEvent.keyDown(grip, { key: ' ' })
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(outline()).not.toEqual(before)

    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    // Precedence is explicit: without it, Escape mid-lift closes the sheet and
    // commits the move the user was in the middle of abandoning.
    expect(outline()).toEqual(before)
    expect(screen.queryByRole('dialog')).not.toBeNull()
    expect(liveText()).toMatch(/Reorder cancelled/)

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('moves a card with the footer buttons', async () => {
    // Not a fallback nobody uses: this is the only mechanism available to switch
    // access, voice control and touch screen-reader users, who navigate by
    // virtual cursor and cannot perform a drag at all.
    await show('overview')
    const before = outline()
    await openSheet()
    selectRow('Portfolio value')
    move('Down')

    expect(outline()).not.toEqual(before)
    expect(liveText()).toMatch(/Portfolio value moved to position 2 of 6/)
    move('To top')
    expect(outline()).toEqual(before)
  })

  it('disables Up on the first row', async () => {
    await show('overview')
    await openSheet()
    selectRow('Portfolio value')
    const dialog = screen.getByRole('dialog')
    expect(isDisabled(within(dialog).getByRole('button', { name: 'Up' }))).toBe(true)
    expect(isDisabled(within(dialog).getByRole('button', { name: 'To top' }))).toBe(true)
    expect(isDisabled(within(dialog).getByRole('button', { name: 'Down' }))).toBe(false)
  })

  it('mounts the live region empty', async () => {
    // A live region added at the same time as its content is not announced.
    await show('overview')
    await openSheet()
    expect(liveText()).toBe('')
  })

  it('labels the dialog and hides the app while it is open', async () => {
    const root = document.getElementById('root')
    expect(root).not.toBeNull()
    if (root === null) return
    window.location.hash = '#/overview'
    // Rendered into #root, so the aria-hidden belt has the subtree it is aimed
    // at. VoiceOver's virtual cursor has historically leaked past aria-modal.
    render(<App />, { container: root })
    await ready('overview')

    fireEvent.click(arrangeButtons()[0] as HTMLElement)
    await screen.findByRole('dialog', { name: 'Arrange cards' })
    expect(root.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Removed on unmount, which is before focus returns to the Arrange button: a
    // focused element inside an aria-hidden subtree is a worse bug than the one
    // the belt fixes.
    expect(root.hasAttribute('aria-hidden')).toBe(false)
  })

  it('returns focus to the Arrange button on close', async () => {
    await show('overview')
    await openSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(arrangeButtons()).toContain(document.activeElement)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Review regressions
//
// Each of these pins a defect an adversarial review found and this change
// fixed. They are grouped rather than scattered because they share one
// property: every one of them was invisible to the suite that shipped with the
// feature, and every one of them would come back silently.
// ─────────────────────────────────────────────────────────────────────────────

describe('review regressions', () => {
  it('leaves no row gap on the sheet list, so the rendered pitch is ROW_H', async () => {
    // `dropIndex` and `shiftFor` both divide travel by ROW_H, so a margin
    // between rows makes every drag land short and the neighbours drift further
    // out of true down the list. The gap has to be padding INSIDE the row.
    // Geometry is unmeasurable in jsdom, so this asserts the mechanism instead.
    await show('overview')
    const list = within(await openSheet()).getByRole('list', { name: 'Card order' })
    expect(list.className).not.toMatch(/(^|\s)space-y-/)
    expect(list.className).not.toMatch(/(^|\s)gap-/)
    const row = list.querySelector('li')
    expect(row?.style.height).toBe('56px')
  })

  it('refuses to pan when the list has nothing to scroll, and never contains both axes', async () => {
    // `overscroll-behavior` only governs chaining OUT of a scroller that
    // actually scrolls. With 2-7 cards the list never overflows, so it is not a
    // scroll container at all and a drag on a row panned the document behind
    // the open sheet instead — which then scroll-snapped to a card the user
    // never navigated to.
    await show('overview')
    const list = within(await openSheet()).getByRole('list', { name: 'Card order' })
    expect(list.className).toContain('overscroll-y-contain')
    expect(list.className).not.toMatch(/(^|\s)overscroll-contain(\s|$)/)
    // jsdom lays everything out at zero, so scrollHeight === clientHeight and
    // the measuring effect settles on "cannot scroll" — the state under test.
    await waitFor(() => expect(list.className).toContain('touch-none'))
  })

  it('declares touch-action none on every non-scrolling box in the sheet', async () => {
    // The scrim alone was not enough: a drag beginning on the grabber, the
    // title row, the help text or the footer chained straight to the document.
    const dialog = await show('overview').then(openSheet)
    const chrome = [
      sheetRoot().querySelector('button[aria-label="Close arrange cards"]'),
      ...[...dialog.children].filter(
        (el) => el.getAttribute('role') !== 'list' && el.tagName !== 'UL',
      ),
    ]
    const naked = chrome.filter(
      (el) => el !== null && !el.className.toString().includes('touch-none'),
    )
    expect(naked.map((el) => el?.className.toString())).toEqual([])
  })

  it('keeps focus inside the dialog when a move disables the button that was pressed', async () => {
    // Pressing Down until the card reaches the bottom disables Down, and a
    // disabled control that just took a press drops focus to <body> — outside
    // the trap, where the sheet can no longer be operated by keyboard at all.
    await show('overview')
    const dialog = await openSheet()
    selectRow('Portfolio value')
    const rows = grips().length
    for (let i = 0; i < rows; i++) move('Down')
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(document.body)
    expect(isDisabled(document.activeElement as Element)).toBe(false)
  })

  it('keeps the move buttons present at all times, so selecting a row cannot shift the list', async () => {
    // Rendered only once something was selected, the footer grew the sheet
    // upward by more than one row pitch the instant a row was tapped — so the
    // list jumped under the finger and the follow-up tap hit the wrong card.
    await show('overview')
    const dialog = await openSheet()
    const q = within(dialog)
    expect(isDisabled(q.getByRole('button', { name: 'Up' }))).toBe(true)
    expect(isDisabled(q.getByRole('button', { name: 'Down' }))).toBe(true)
    expect(isDisabled(q.getByRole('button', { name: 'To top' }))).toBe(true)

    selectRow('Dividends received')
    // Same three controls, now live. Nothing appeared, so nothing moved.
    expect(isDisabled(q.getByRole('button', { name: 'Up' }))).toBe(false)
    expect(isDisabled(q.getByRole('button', { name: 'To top' }))).toBe(false)
  })

  it('commits a keyboard lift on Tab and reverts it on Escape', async () => {
    // Both exits used to announce "Reorder cancelled" and then do opposite
    // things — Tab kept every arrow-key move, Escape undid them.
    await show('overview')
    const dialog = await openSheet()
    const order = () => grips().map((g) => g.textContent)

    const before = order()
    const first = grips()[0]
    if (first === undefined) throw new Error('no grips')
    first.focus()
    fireEvent.keyDown(first, { key: ' ' })
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(order()).not.toEqual(before)
    const moved = order()

    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(order()).toEqual(moved)
    expect(liveText()).toMatch(/dropped at position/)
    expect(liveText()).not.toMatch(/cancelled/)

    // And now the other exit, from the row's new home.
    const again = grips().find((g) => g.textContent === moved[1])
    if (again === undefined) throw new Error('moved row not found')
    again.focus()
    fireEvent.keyDown(again, { key: ' ' })
    fireEvent.keyDown(again, { key: 'ArrowUp' })
    expect(order()).not.toEqual(moved)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(order()).toEqual(moved)
    expect(screen.queryByRole('dialog')).not.toBeNull()
    expect(liveText()).toMatch(/cancelled/)
  })

  it('centres a collapsed header instead of stacking padding on the 44px chevron', async () => {
    // Reported from a screenshot: a collapsed card looked like it had an empty
    // second row under the title. Cause: `items-start` plus pt-4/pb-4 around a
    // 44px control, so a 20px title sat at the top of a 70px box. Measured in
    // real Chrome after the fix: 58px, title exactly on the chevron's axis.
    // jsdom cannot measure, so the class contract is what is pinned here.
    await show('overview')
    const toggle = screen.getByRole('button', { name: 'Collapse Allocation by holding' })
    const header = toggle.closest('header')
    if (header === null) throw new Error('no header')
    expect(header.className).toContain('items-start')
    expect(toggle.className).toContain('-mt-2')

    fireEvent.click(toggle)
    const collapsed = screen
      .getByRole('button', { name: 'Expand Allocation by holding' })
      .closest('header')
    if (collapsed === null) throw new Error('no collapsed header')
    expect(collapsed.className).toContain('items-center')
    expect(collapsed.className).not.toContain('items-start')
    // The padding that produced the phantom row.
    expect(collapsed.className).not.toMatch(/(^|\s)pt-4/)
    expect(collapsed.className).not.toMatch(/(^|\s)pb-4/)
    // And the negative pull that only makes sense against a top-aligned row.
    expect(
      screen.getByRole('button', { name: 'Expand Allocation by holding' }).className,
    ).not.toContain('-mt-2')
  })

  it('names the collapse control with the title on screen, not the sheet label', async () => {
    // The control is icon-only beside a visible title, so that title is its
    // label: a spoken name that is not the words next to it cannot be operated
    // by voice and trips WCAG 2.5.3. The policy label stays short for the
    // sheet's narrow rows, so on three cards the two genuinely differ.
    await show('forecast')
    // Policy label is "Projected by month"; the card says this.
    expect(screen.getByRole('button', { name: 'Collapse Projected income by month' })).toBeDefined()

    // And the sheet still uses the short label for its own row.
    await openSheet()
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Projected by month' }),
    ).toBeDefined()
    expectNoPoison()
  })

  it('tracks a title that changes, so the name follows the gross/net toggle', async () => {
    // Income's chart is titled "Net dividends paid" or "Gross dividends paid"
    // depending on the basis toggle. A fixed label can never match both.
    await show('income')
    expect(screen.getByRole('button', { name: /^Collapse (Net|Gross) dividends paid$/ })).toBeDefined()
    const before = screen
      .getByRole('button', { name: /^Collapse (Net|Gross) dividends paid$/ })
      .textContent
    fireEvent.click(screen.getByRole('button', { name: 'Gross' }))
    await waitFor(() => {
      const after = screen
        .getByRole('button', { name: /^Collapse (Net|Gross) dividends paid$/ })
        .textContent
      expect(after).not.toBe(before)
    })
  })

  it('marks a picked-up row with an ARIA state and a word, not only a colour', async () => {
    // The keyboard path applies no transform and no scale, so an accent border
    // and a shadow on a near-black surface were the entire cue — and the house
    // rule is that nothing carries meaning by colour alone.
    await show('overview')
    const dialog = await openSheet()
    const grip = grips()[0]
    if (grip === undefined) throw new Error('no grips')
    expect(grip.getAttribute('aria-pressed')).toBe('false')
    grip.focus()
    fireEvent.keyDown(grip, { key: ' ' })
    expect(grip.getAttribute('aria-pressed')).toBe('true')
    expect(within(dialog).getByText('Moving')).toBeDefined()
  })
})
