import { useEffect, useRef } from 'react'
import type { TabId } from '../../App'
import { useCards } from './useCardLayout'
import { GripIcon } from './icons'

const FOCUS =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'

/**
 * The one entry point into arranging, in the app header rather than in the tab.
 *
 * Two reasons it lives here. It must not become a child of `main > div`: it
 * would take a mobile snap point of its own, and as `:first-child` it would
 * spend the 1.5rem scroll-margin that exists specifically to keep the top of
 * the page somewhere you can stand. And one button serves all five tabs.
 *
 * Icon-only below `sm`. The mobile bar is 48px tall with a title and a
 * SyncStatus that can read "··· Updating prices"; a third labelled control does
 * not fit a 320px screen.
 *
 * Absent, not disabled, while no CardStack is mounted — a tab showing its
 * loading skeleton or its empty state has nothing to arrange.
 */
export function ArrangeButton({ tab, className = '' }: { tab: TabId; className?: string }) {
  const { stack, openFor, open } = useCards()
  const ref = useRef<HTMLButtonElement | null>(null)
  const wasOpen = useRef(false)

  const isOpen = openFor === tab
  useEffect(() => {
    // Focus returns to the control that opened the dialog. Tracked here rather
    // than handed across the tree as a ref, because the sheet lives in a portal.
    if (wasOpen.current && !isOpen) ref.current?.focus()
    wasOpen.current = isOpen
  }, [isOpen])

  if (stack === null || stack.tab !== tab) return null
  const hidden = stack.hidden

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => open(tab)}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      className={`min-h-[44px] min-w-[44px] -mr-2 inline-flex items-center justify-center gap-1.5 rounded-lg px-2 text-muted hover:text-ink ${FOCUS} ${className}`}
    >
      {/* The name carries the count, so a screen-reader user learns something is
          hidden without having to open the sheet to find out. */}
      <span className="sr-only">Arrange cards{hidden > 0 ? `, ${hidden} hidden` : ''}</span>
      <GripIcon />
      <span aria-hidden className="hidden sm:inline text-sm">
        Arrange
      </span>
      {hidden > 0 && (
        <span
          aria-hidden
          className="num text-[10px] leading-none px-1 py-0.5 rounded bg-accent/20 text-accent"
        >
          {hidden}
        </span>
      )}
    </button>
  )
}
