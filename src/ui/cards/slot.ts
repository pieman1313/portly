import { createContext, useContext } from 'react'

/**
 * What a `Card` learns about the slot it was rendered into.
 *
 * Deliberately tiny and dependency-free. `primitives.tsx` is on the first-paint
 * path for every user, so the thing it imports to grow a collapse control must
 * not reach the store, the sheet or the drag engine.
 *
 * Null outside a CardStack. Every tab's loading skeleton and empty state
 * renders bare Cards, and those must get no chrome at all — there is nothing to
 * arrange on a screen with no data on it.
 */
export interface CardChrome {
  id: string
  label: string
  collapsible: boolean
  collapsed: boolean
  /** Render the body with `hidden` rather than dropping its children. */
  keepMounted: boolean
  toggle: () => void
}

export const SlotContext = createContext<CardChrome | null>(null)

export const useCardChrome = (): CardChrome | null => useContext(SlotContext)
