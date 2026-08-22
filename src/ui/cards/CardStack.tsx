import { Suspense, lazy, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import type { TabId } from '../../App'
import { SlotContext } from './slot'
import { useCardLayout, useCards } from './useCardLayout'
import type { CardSpec } from './layout'

const ArrangeSheet = lazy(() =>
  import('./ArrangeSheet').then((m) => ({ default: m.ArrangeSheet })),
)

const FOCUS =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'

/**
 * The tab root. NOT a wrapper around it — this component renders the
 * `div.space-y-4` itself, and every card is still that div's direct child.
 *
 * That is the whole structural discipline of this feature, and it is not
 * tidiness. Every rule in the mobile snap block in src/index.css is keyed on
 * `main > div > *`. One element inserted between <main> and this div re-points
 * `main > div` at it, and `main > div > :last-child section` at specificity
 * (0,1,3) then beats `main > div > * > section` at (0,0,3) and sets
 * `scroll-snap-align: none` on every card in the app.
 *
 * Three consequences follow, and none of them is negotiable:
 *   - reordering PERMUTES THE ARRAY. Never CSS `order`, never
 *     `flex-direction: column-reverse`: `:last-child` reads DOM order, and so
 *     does `space-y-4`, which Tailwind compiles to `& > * + * { margin-top }`.
 *   - hiding UNMOUNTS. Never `hidden`, never `visibility:hidden; height:0` — a
 *     boxless last child has no snap area, and the end of the page becomes
 *     unreachable again (measured on Forecast: 2031 of a possible 2103, a
 *     permanent 72px short, which is exactly the height of the tab bar the last
 *     card then stayed behind).
 *   - the arrange sheet is PORTALED OUT of here. A `position: fixed` element
 *     contributes no snap area but still matches `:last-child`, so a sheet
 *     rendered in this list would silently demote the real last card even while
 *     it was closed.
 */
export function CardStack({
  tab,
  lead,
  cards,
}: {
  tab: TabId
  /**
   * Rendered first and unmanaged. The sr-only <h1> is the document outline and
   * the `:first-child` whose scroll-margin index.css widens to pin the top of
   * the page as a place you can stand; it is not a card.
   */
  lead?: ReactNode
  cards: CardSpec[]
}) {
  const layout = useCardLayout(tab, cards)
  const { setStack, openFor, open, close } = useCards()

  // Publishes to the Arrange button in the app header. Mount and unmount, plus a
  // hidden count that only moves on a user action, so this is not per-render
  // churn.
  useEffect(() => {
    setStack({ tab, hidden: layout.hiddenCount })
    // Guarded rather than a bare null: during a tab switch React runs this
    // cleanup and the next stack's effect in an order we should not have to rely
    // on, and clearing someone else's entry would leave the button missing.
    return () => setStack((prev) => (prev?.tab === tab ? null : prev))
  }, [tab, layout.hiddenCount, setStack])

  // A sheet cannot outlive the stack it is arranging. Erasing the database while
  // the sheet is open drops this tab to its empty state, which unmounts the
  // stack and the portal with it — but `openFor` would still say "open", so the
  // sheet would reappear on its own the next time the tab had data again.
  //
  // Its own effect, with `close` (stable) as the only dependency, so it runs on
  // mount and unmount and nothing else. Folded into the effect above it would
  // fire on every change of `hiddenCount` — which is to say it would close the
  // sheet the instant you hid a card from it.
  useEffect(() => close, [close])

  return (
    <div className="space-y-4">
      {lead}
      {layout.visible.map((spec) => (
        // Keyed by id, not by position: under positional keys a permutation
        // remounts every card, which loses the matrix month window, the Recent
        // payments reveal count and any in-flight import, and replays every
        // chart's entry animation. A Provider renders no DOM, so what is inside
        // it is still a direct child of the div above.
        <SlotContext.Provider key={spec.id} value={layout.chromeFor(spec)}>
          {spec.render()}
        </SlotContext.Provider>
      ))}

      {/* The only element this feature adds to a page, and only while something
          is hidden. A hidden card with no route back from the page itself is a
          bug report waiting to happen: the count on the header button is easy to
          miss three weeks later. A plain div with no nested <section>, so it
          takes the end-aligned snap point cleanly. */}
      {layout.hiddenCount > 0 && (
        <div className="flex items-center gap-1 text-xs text-muted">
          <span>
            {layout.hiddenCount === 1 ? '1 card hidden' : `${layout.hiddenCount} cards hidden`}
          </span>
          <button
            type="button"
            onClick={() => open(tab)}
            className={`min-h-[44px] px-2 text-accent underline rounded-lg ${FOCUS}`}
          >
            Arrange cards
          </button>
        </div>
      )}

      {openFor === tab &&
        createPortal(
          <Suspense fallback={null}>
            <ArrangeSheet layout={layout} onClose={close} />
          </Suspense>,
          document.body,
        )}
    </div>
  )
}
