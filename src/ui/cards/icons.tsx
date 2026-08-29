/* Icons: inline 20px strokes, same `ico` spread as App.tsx's tab bar. Five
   glyphs do not justify an icon dependency in a PWA bundle. */

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

/** Points down when the card is open, right when it is collapsed — the same
 *  reading as every other disclosure in the app, which rotates a right-facing
 *  chevron by 90 degrees. */
export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg {...ico} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

/** Two columns of three dots: the one shape a thumb reads as "drag me" without
 *  a label, and it does not look like a control that does something on tap. */
export function GripIcon() {
  return (
    <svg {...ico} strokeWidth={2}>
      <path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01" />
    </svg>
  )
}

/**
 * The header control that opens the arrange sheet.
 *
 * A gear rather than the grip below it. The grip is the thing you DRAG, and
 * wearing it on a button that opens a dialog promised a drag that does nothing
 * there — on a phone that reads as a dead control rather than as a menu. A gear
 * is the one glyph a thumb reads as "settings for what I am looking at" with no
 * label beside it, which is what this button has to be at 48px.
 */
export function GearIcon() {
  return (
    <svg {...ico}>
      {/* Six teeth, generated: outer r 9.2, root r 6.5, 24deg of tooth and 16deg
          of valley per 60deg of pitch. Straight flanks, because at 20px the
          rounded joins do all the softening the shape needs. */}
      <path d="M10.1 3L13.9 3L14.3 5.9L16.1 6.9L18.8 5.8L20.7 9.2L18.4 11L18.4 13L20.7 14.8L18.8 18.2L16.1 17.1L14.3 18.1L13.9 21L10.1 21L9.7 18.1L7.9 17.1L5.2 18.2L3.3 14.8L5.6 13L5.6 11L3.3 9.2L5.2 5.8L7.9 6.9L9.7 5.9Z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  )
}

export function EyeIcon() {
  return (
    <svg {...ico}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function EyeOffIcon() {
  return (
    <svg {...ico}>
      <path d="M4 4l16 16" />
      <path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4" />
      <path d="M6.7 7.7A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9.7 9.7 0 0 0 3.6-.7" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  )
}
