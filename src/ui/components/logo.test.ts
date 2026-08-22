import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The header mark and the favicon are the same drawing, kept in two places: a
 * static file the browser loads for the tab and the home screen, and an inlined
 * component for the app's own headers.
 *
 * That duplication is deliberate — see the docblock in Logo.tsx — but it can
 * drift in total silence. A favicon gets redrawn once, years apart, and nobody
 * editing an SVG in `public/` thinks to grep `src/ui/components`. The result
 * would be an app whose header shows one logo and whose browser tab shows
 * another, which reads as a build problem rather than as a missed edit.
 *
 * So this compares the parts that carry the drawing: the path geometry, the
 * stroke width, and both colours.
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

const FAVICON = read('public/favicon.svg')
const LOGO = read('src/ui/components/Logo.tsx')

/** Collapse whitespace so a reflowed attribute list is not a failure. */
const flat = (s: string) => s.replace(/\s+/g, ' ')

describe('the header mark matches the favicon', () => {
  it('draws the same path', () => {
    const d = /d="([^"]+)"/.exec(FAVICON)?.[1]
    expect(d, 'no path found in public/favicon.svg').toBeDefined()
    expect(flat(LOGO)).toContain(`d="${d}"`)
  })

  it('uses the same stroke width for that path', () => {
    const width = /stroke-width="([^"]+)"/.exec(FAVICON)?.[1]
    expect(width, 'no stroke-width in public/favicon.svg').toBeDefined()
    expect(flat(LOGO)).toContain(`strokeWidth="${width}"`)
  })

  it('uses the same two colours', () => {
    // The line and the dot. The tile's fill is deliberately absent from the
    // component, so it is excluded here rather than asserted.
    const tile = /rect[^>]*fill="([^"]+)"/.exec(FAVICON)?.[1]
    const colours = [...FAVICON.matchAll(/(?:stroke|fill)="(#[0-9a-fA-F]{3,8})"/g)]
      .map((m) => m[1])
      .filter((c) => c !== tile && c !== 'none')
    expect(colours.length).toBeGreaterThan(0)
    for (const c of new Set(colours)) expect(LOGO).toContain(c)
  })

  it('keeps the same viewBox, so the geometry is not silently rescaled', () => {
    const box = /viewBox="([^"]+)"/.exec(FAVICON)?.[1]
    expect(box).toBeDefined()
    expect(flat(LOGO)).toContain(`viewBox="${box}"`)
  })

  it('does not draw the favicon tile, which is the page background', () => {
    // #0b0f16 is the `bg` token. Drawing it would be an invisible square that
    // shrinks the glyph inside the same box.
    const tile = /rect[^>]*fill="([^"]+)"/.exec(FAVICON)?.[1]
    expect(tile).toBe('#0b0f16')
    expect(LOGO).not.toContain(`fill="${tile}"`)
  })
})
