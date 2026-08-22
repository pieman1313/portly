/* Icons: inline 20px strokes, same `ico` spread as App.tsx's tab bar. Four
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
