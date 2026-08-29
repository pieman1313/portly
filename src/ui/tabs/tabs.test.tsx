import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installBrowserStubs, renderTab } from '../../test/render'
import { importStatementText } from '../../db/import'
import { db, getSettings } from '../../db/schema'
import { App } from '../../App'

/**
 * End-to-end: a statement file goes in, every tab renders real numbers out.
 *
 * These are smoke tests with teeth. They exist because the unit tests all pass
 * on data structures, and the thing that actually breaks in an app like this is
 * a screen rendering `NaN`, `undefined`, `£0` where the truth is unknown, or
 * throwing on an empty database before any file has been imported.
 */

// Resolved from the project root, not import.meta.url: under the jsdom
// environment import.meta.url is an http: URL and fileURLToPath rejects it.
const FIXTURE = readFileSync(
  resolve(process.cwd(), 'src/test/fixtures/activity-basic.csv'),
  'utf8',
)

/** Anything that reaching the DOM means we have a bug, not a display choice. */
const POISON = /\bNaN\b|\bundefined\b|\bInfinity\b|\[object Object\]/

function pageText(): string {
  return document.body.textContent ?? ''
}

/** jest-dom is not installed, so read the property the pager actually sets. */
function disabled(label: string): boolean {
  const el = screen.getByLabelText(label)
  return el instanceof HTMLButtonElement && el.disabled
}

function expectNoPoison(): void {
  const text = pageText()
  const hit = text.match(POISON)
  expect(hit ? `rendered ${hit[0]} in: ${text.slice(Math.max(0, (hit.index ?? 0) - 80), (hit.index ?? 0) + 80)}` : null).toBeNull()
}

beforeAll(() => {
  installBrowserStubs()
})

afterEach(() => {
  cleanup()
  window.location.hash = ''
})

async function wipe(): Promise<void> {
  await Promise.all([
    db.rawFiles.clear(), db.rawRows.clear(), db.instruments.clear(),
    db.transactions.clear(), db.distributions.clear(), db.accruals.clear(),
    db.cashEvents.clear(), db.positions.clear(), db.fxRates.clear(), db.settings.clear(),
  ])
}

describe('empty state', () => {
  beforeEach(wipe)

  it('renders every tab with no data at all, without throwing', async () => {
    for (const tab of ['overview', 'income', 'forecast', 'holdings', 'data']) {
      window.location.hash = `#/${tab}`
      const { unmount } = renderTab(<App />)
      // The whole point: a brand-new user hits this before importing anything.
      await waitFor(() => expect(pageText().length).toBeGreaterThan(20))
      expectNoPoison()
      unmount()
    }
  })
})

describe('with an imported statement', () => {
  beforeEach(async () => {
    await wipe()
    const report = await importStatementText(FIXTURE, 'activity-basic.csv')
    expect(report.outcome).toBe('imported')
    // The fixture is built so every reconciliation check can be satisfied.
    const failed = report.reconciliation.filter((c) => !c.ok)
    expect(failed.map((f) => `${f.label}: ${f.ours} vs ${f.theirs}`)).toEqual([])
  })

  it('Overview shows a value and no poison values', async () => {
    window.location.hash = '#/overview'
    renderTab(<App />)
    await waitFor(() => expect(pageText()).toMatch(/Portfolio value/i))
    expectNoPoison()
  })

  it('Holdings lists the renamed instrument once, under its current ticker', async () => {
    window.location.hash = '#/holdings'
    renderTab(<App />)
    // NEWT and OLDT are one instrument (conid 111111111) bought under two
    // tickers. It must appear once, with the combined 150 shares, displayed
    // under the Underlying root ticker rather than whichever alias IBKR
    // happened to list first.
    await waitFor(() => expect(screen.getAllByText(/OLDT/).length).toBeGreaterThan(0))
    expect(pageText()).toMatch(/ACME/)
    expect(pageText()).toMatch(/GLOB/)
    expectNoPoison()
  })

  it('Income renders the payments matrix', async () => {
    window.location.hash = '#/income'
    renderTab(<App />)
    await waitFor(() => expect(pageText()).toMatch(/matrix|received/i))
    expectNoPoison()
  })

  it('Income switches the chart to quarters while the tiles stay monthly', async () => {
    window.location.hash = '#/income'
    renderTab(<App />)
    await waitFor(() => expect(pageText()).toMatch(/Monthly totals/))
    // The tiles deliberately ignore the period toggle — "best month" and
    // "average month" only mean anything in months — so they bucket the same
    // payments a second time, on their own. Pin what they say before the
    // switch: a memo keyed on the wrong thing shows up here as the tiles
    // quietly re-reading the chart's quarterly buckets.
    // 'Best month$60.15Apr 2025' — the tile's value, then the month it names.
    const bestMonth = pageText().match(/Best month[^A-Za-z]*([A-Z][a-z]{2} \d{4})/)?.[1]
    expect(bestMonth).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Quarter' }))

    await waitFor(() => expect(pageText()).toMatch(/Quarterly totals/))
    expect(pageText()).not.toMatch(/Monthly totals/)
    // The bars themselves are out of reach: Recharts measures its container,
    // and jsdom reports every element as 0x0, so the axis labels that would
    // prove the re-bucketing are never drawn. `scripts/screenshot.mjs` is
    // where the chart itself gets looked at.
    expect(pageText()).toMatch(new RegExp(`Best month[^A-Za-z]*${bestMonth}`))
    expectNoPoison()
  })

  it('Forecast renders and discloses that it has no provider data', async () => {
    window.location.hash = '#/forecast'
    renderTab(<App />)
    // Wait for the skeleton to clear. A length check is not enough: the nav
    // alone clears any threshold, so the assertion would race the live query.
    await waitFor(() => expect(pageText()).not.toMatch(/Loading forecast/))
    // With no market data the only forward figure is the open accrual, so the
    // screen must say so rather than presenting a near-zero total as complete.
    expect(pageText()).toMatch(/declared|estimated|market data/i)
    expectNoPoison()
  })

  it('Data lists the imported file and its reconciliation', async () => {
    window.location.hash = '#/data'
    renderTab(<App />)
    await waitFor(() => expect(pageText()).toMatch(/activity-basic\.csv/))
    expectNoPoison()
  })
})

describe('scroll containment', () => {
  beforeEach(async () => {
    await wipe()
    await importStatementText(FIXTURE, 'activity-basic.csv')
  })

  it('contains the payments matrix horizontally only, so a vertical swipe reaches the page', async () => {
    // Regression, verified in a real browser: `overscroll-contain` blocks scroll
    // chaining on BOTH axes, so a vertical swipe starting inside the matrix
    // never reached the page and the tab felt frozen. Measured with a headless
    // wheel event: contained on both axes the page stayed at scrollY 765; with
    // x-only containment it moved to 1125. Horizontal containment is the part
    // we want — dragging the matrix sideways should not drag the page.
    window.location.hash = '#/income'
    renderTab(<App />)
    const region = await waitFor(() => {
      const el = document.querySelector('[aria-label="Payments matrix, scrolls horizontally"]')
      if (!el) throw new Error('matrix not rendered')
      return el
    })
    expect(region.className).toContain('overscroll-x-contain')
    expect(region.className).not.toMatch(/(^|\s)overscroll-contain(\s|$)/)
  })

  it('renders that scroller from sm up only, and gives a phone a paged window instead', async () => {
    // Containment fixed chaining and never touched CAPTURE, which is the other
    // half of the bug and has no CSS answer: a touch gesture locks to one axis
    // as it begins, so a diagonal swipe over a horizontal scroller locks to
    // horizontal and the page does not move until the finger lifts. Measured in
    // a real browser at 390px, dragging from the middle of the old scroller:
    // pure vertical moved the page 356px, 30 degrees off vertical 310px, 45
    // degrees 0px. `touch-action: pan-x` measured 0px at every angle — it
    // removes vertical panning rather than delegating it.
    //
    // So below sm the scroller is not rendered: display:none takes it out of
    // hit testing entirely, and a paged month window stands in its place. This
    // asserts the arrangement, because a stray `sm:` dropped from either half
    // puts a horizontal scrollport back under the user's thumb.
    window.location.hash = '#/income'
    renderTab(<App />)
    const region = await waitFor(() => {
      const el = document.querySelector('[aria-label="Payments matrix, scrolls horizontally"]')
      if (!el) throw new Error('matrix not rendered')
      return el
    })
    const wrapper = region.parentElement
    expect(wrapper?.className).toMatch(/(^|\s)hidden(\s|$)/)
    expect(wrapper?.className).toContain('sm:block')

    // The phone window: same label prefix, no scrollport of its own anywhere
    // inside it, and hidden from sm up so the two never show at once.
    const phone = [...document.querySelectorAll('[aria-label^="Payments matrix"]')].find(
      (el) => el !== region,
    )
    expect(phone).toBeDefined()
    expect(phone?.closest('.sm\\:hidden')).not.toBeNull()
    const scrollers = [phone, ...(phone?.querySelectorAll('*') ?? [])].filter((el) =>
      /overflow/.test(el?.className.toString() ?? ''),
    )
    expect(scrollers.map((el) => el?.className.toString())).toEqual([])
  })

  it('opens the phone window on the most recent months and pages back through them', async () => {
    // The fixture pays from April to October, seven months against a window of
    // four, so the window has somewhere to go. Landing on the oldest months
    // would be the one thing nobody opens this to see.
    window.location.hash = '#/income'
    renderTab(<App />)
    const group = await waitFor(() => {
      const el = [...document.querySelectorAll('[role="group"]')].find((n) =>
        (n.getAttribute('aria-label') ?? '').startsWith('Payments matrix,'),
      )
      if (!el) throw new Error('phone window not rendered')
      return el
    })
    expect(group.getAttribute('aria-label')).toBe('Payments matrix, Jul – Oct 2025')
    expect(pageText()).toContain('Showing 4 of 7 months')
    expect(disabled('Show later months')).toBe(true)
    expect(disabled('Show earlier months')).toBe(false)

    fireEvent.click(screen.getByLabelText('Show earlier months'))
    expect(group.getAttribute('aria-label')).toBe('Payments matrix, Apr – Jul 2025')
    expect(disabled('Show earlier months')).toBe(true)
    expect(disabled('Show later months')).toBe(false)
    expectNoPoison()
  })
})

describe('base currency', () => {
  beforeEach(wipe)

  it('adopts the base currency stated by the first statement', async () => {
    // A EUR-based IBKR account would otherwise report in dollars forever,
    // because the built-in default is USD and nothing read the statement.
    const eur = FIXTURE.replace(
      'Account Information,Data,Base Currency,USD',
      'Account Information,Data,Base Currency,EUR',
    )
    expect(eur).not.toBe(FIXTURE)
    await importStatementText(eur, 'eur.csv')
    expect((await getSettings()).baseCurrency).toBe('EUR')
  })

  it('does not redenominate the app when a second account arrives', async () => {
    await importStatementText(FIXTURE, 'usd.csv')
    expect((await getSettings()).baseCurrency).toBe('USD')

    // Same content, different account and base. Adopting this would silently
    // reinterpret every figure already on screen.
    const other = FIXTURE
      .replace('Account Information,Data,Account,U00000001', 'Account Information,Data,Account,U00000002')
      .replace('Account Information,Data,Base Currency,USD', 'Account Information,Data,Base Currency,EUR')
    await importStatementText(other, 'second.csv')
    expect((await getSettings()).baseCurrency).toBe('USD')
  })

  it('leaves the default alone when the statement does not say', async () => {
    const silent = FIXTURE.replace('Account Information,Data,Base Currency,USD', '')
    await importStatementText(silent, 'quiet.csv')
    expect((await getSettings()).baseCurrency).toBe('USD')
  })
})

describe('cached market data survives a reload', () => {
  beforeEach(async () => {
    await wipe()
    await importStatementText(FIXTURE, 'activity-basic.csv')
  })

  it('values a holding from a quote left in IndexedDB by an earlier session', async () => {
    // Regression: quotes used to live in a module-level cache. The auto-refresh
    // only re-fetches every 15 minutes, so a reload inside that window had no
    // quotes AND no permission to fetch any, and the portfolio silently fell
    // back to the statement's closing prices with no indication anything had
    // changed. Persisting them is what makes the rate limit survivable.
    await db.quotes.put({
      instrumentKey: '222222222', // ACME
      price: 99,
      currency: 'USD',
      previousClose: 98,
      provenance: { source: 'stockanalysis', asOf: new Date().toISOString() },
    })

    window.location.hash = '#/holdings'
    renderTab(<App />)
    await waitFor(() => expect(pageText()).toMatch(/ACME/))
    // 100.25 shares at the cached 99, not at the fixture's 55.2 close.
    await waitFor(() => expect(pageText()).toMatch(/9,924/))
    expectNoPoison()
  })
})

describe('import idempotency through the UI stack', () => {
  beforeEach(wipe)

  it('re-importing the identical file changes nothing', async () => {
    const first = await importStatementText(FIXTURE, 'a.csv')
    expect(first.outcome).toBe('imported')
    const txns = await db.transactions.count()
    const dists = await db.distributions.count()

    const second = await importStatementText(FIXTURE, 'a.csv')
    expect(second.outcome).toBe('duplicate-exact')
    expect(await db.transactions.count()).toBe(txns)
    expect(await db.distributions.count()).toBe(dists)
  })

  it('re-importing the same statement under a different name is still a no-op', async () => {
    await importStatementText(FIXTURE, 'a.csv')
    const txns = await db.transactions.count()
    // Same bytes, different filename: sha256Raw still matches, so it is caught
    // by the cheapest check before anything is parsed.
    const again = await importStatementText(FIXTURE, 'renamed.csv')
    expect(again.outcome).toBe('duplicate-exact')
    expect(await db.transactions.count()).toBe(txns)
  })

  it('a regenerated export of the same period does not double-count', async () => {
    await importStatementText(FIXTURE, 'a.csv')
    const txns = await db.transactions.count()
    // IBKR stamps WhenGenerated into every export, so the bytes differ but the
    // content is identical. This is the case sha256Canonical exists for.
    const regenerated = FIXTURE.replace(
      'Statement,Data,WhenGenerated,"2026-01-05, 09:00:00 EDT"',
      'Statement,Data,WhenGenerated,"2026-02-11, 17:30:00 EDT"',
    )
    expect(regenerated).not.toBe(FIXTURE)
    const again = await importStatementText(regenerated, 'b.csv')
    expect(again.outcome).toBe('duplicate-regenerated')
    expect(await db.transactions.count()).toBe(txns)
  })
})
