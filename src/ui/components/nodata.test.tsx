import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installBrowserStubs, renderTab } from '../../test/render'
import { db } from '../../db/schema'
import { App } from '../../App'
import type { TabId } from '../../App'
import { NoData } from './NoData'

/**
 * The screen a new user lands on, across all four tabs that can have nothing.
 *
 * It replaced four different empty states that said the same thing four ways —
 * three CTA labels, three focus-ring styles, two of them boxed in a Card — so
 * what is worth pinning is the consistency, not the pixels: one heading, one
 * link, one destination, and copy short enough to read at a glance.
 */

const TABS: TabId[] = ['overview', 'income', 'forecast', 'holdings']

beforeAll(() => {
  installBrowserStubs()
})

/** No statements at all: the state every one of these tabs answers with NoData. */
beforeEach(async () => {
  await Promise.all([
    db.rawFiles.clear(), db.rawRows.clear(), db.instruments.clear(),
    db.transactions.clear(), db.distributions.clear(), db.accruals.clear(),
    db.cashEvents.clear(), db.positions.clear(), db.fxRates.clear(), db.settings.clear(),
  ])
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  window.location.hash = ''
})

describe('the no-data hero', () => {
  it('offers exactly one way forward on every empty tab, and it goes to Data', async () => {
    for (const tab of TABS) {
      window.location.hash = `#/${tab}`
      const { unmount } = renderTab(<App />)
      const main = await waitFor(() => {
        const el = document.querySelector('main')
        if (el === null || el.querySelector('h1') === null) throw new Error('no hero yet')
        return el
      }, { timeout: 5000 })

      const links = [...main.querySelectorAll('a')]
      expect(links.map((a) => a.getAttribute('href'))).toEqual(['#/data'])
      expect(links[0]?.textContent?.trim()).toMatch(/^Add data/)

      // A heading, not an sr-only stand-in: this screen has something to say.
      const h1 = main.querySelector('h1')
      expect(h1?.className ?? '').not.toContain('sr-only')
      expect((h1?.textContent ?? '').length).toBeGreaterThan(4)
      // Exactly one h1 — the tabs that carry an sr-only one when they have data
      // must not ship both.
      expect(main.querySelectorAll('h1').length).toBe(1)

      unmount()
    }
  })

  it('keeps the copy short enough to read at a glance', async () => {
    for (const tab of TABS) {
      window.location.hash = `#/${tab}`
      const { unmount } = renderTab(<App />)
      const main = await waitFor(() => {
        const el = document.querySelector('main')
        if (el === null || el.querySelector('h1') === null) throw new Error('no hero yet')
        return el
      }, { timeout: 5000 })
      // The four screens this replaced ran to 45-60 words of prose. The point of
      // the change was that a new user reads none of it.
      const words = (main.textContent ?? '').trim().split(/\s+/).length
      expect(words, `${tab} hero is ${words} words`).toBeLessThan(40)
      unmount()
    }
  })

  it('hides the illustration from assistive tech and names nothing after it', () => {
    render(<NoData title="Nothing yet">One short sentence.</NoData>)
    const svgs = [...document.querySelectorAll('svg')]
    expect(svgs.length).toBeGreaterThan(0)
    // Decorative: the heading and the link already say everything.
    for (const svg of svgs) expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('heading', { level: 1, name: 'Nothing yet' })).toBeDefined()
    expect(screen.getByRole('link', { name: /^Add data/ })).toBeDefined()
  })

  it('lands the line drawing in its finished state, so reduced motion sees a full chart', () => {
    // index.css cuts every animation to 0.01ms under prefers-reduced-motion, so
    // the resting style has to be the DRAWN one and the keyframe has to animate
    // from the hidden end. The other way round leaves an invisible line.
    render(<NoData title="Nothing yet">One short sentence.</NoData>)
    // `getAttribute('class')`, not `.className`: on an SVG element that property
    // is an SVGAnimatedString whose toString() is not the class list, so the
    // idiom the HTML-element assertions elsewhere use silently matches nothing.
    const line = [...document.querySelectorAll('path')].find((p) =>
      (p.getAttribute('class') ?? '').includes('nd-draw'),
    )
    expect(line, 'no animated line found').toBeDefined()
    expect(line?.getAttribute('class')).toContain('[stroke-dashoffset:0]')
  })
})
