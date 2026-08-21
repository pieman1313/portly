import { render } from '@testing-library/react'
import type { ReactElement } from 'react'

/**
 * Render helper for tab tests.
 *
 * jsdom implements neither ResizeObserver (Recharts' ResponsiveContainer needs
 * it) nor matchMedia, so charts would throw on mount rather than render empty.
 * Stub both, and give the container a real size so Recharts draws something.
 */
export function renderTab(ui: ReactElement) {
  return render(ui)
}

export function installBrowserStubs(): void {
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
  // ResponsiveContainer measures its parent; jsdom reports 0x0 forever.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 768 })
  if (!('scrollTo' in window)) (window as unknown as Record<string, unknown>).scrollTo = () => {}
}
