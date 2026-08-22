/**
 * The screen a new user actually lands on.
 *
 * It is the only screen in the app with nothing to report, so it is the one
 * place where decoration earns its keep: there is no number to look at, and a
 * paragraph of prose asking someone to go and find a CSV is a worse first
 * impression than a picture and one button. The four tabs used to say the same
 * thing four ways — "Go to the Data tab", "Go to Data", "Import a statement",
 * three different focus rings, two of them boxed in a Card and two not.
 *
 * The headline is an <h1>, so a tab in this state still has a document outline.
 * The tabs that carry an `sr-only` <h1> when they have data drop it here rather
 * than shipping two.
 */

/** The mark from the header, grown into an illustration and drawn on entry. */
function Illustration() {
  return (
    <svg
      viewBox="0 0 200 120"
      className="w-full max-w-[15rem] h-auto mx-auto"
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id="nd-line" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#3987e5" />
          <stop offset="100%" stopColor="#3fb950" />
        </linearGradient>
        <radialGradient id="nd-glow">
          <stop offset="0%" stopColor="#3fb950" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#3fb950" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Ghost months. Faint enough to read as texture rather than as data —
          this is an empty state, and a chart with plausible bars on it would be
          inventing figures the user has not imported. */}
      {[
        [26, 74],
        [56, 58],
        [86, 66],
        [116, 40],
        [146, 50],
      ].map(([x, y]) => (
        <rect
          key={x}
          x={(x ?? 0) - 9}
          y={y ?? 0}
          width="18"
          height={100 - (y ?? 0)}
          rx="3"
          className="fill-border/40"
        />
      ))}

      {/* Baseline, so the bars sit on something. */}
      <path d="M12 100 H188" className="stroke-border" strokeWidth="1.5" strokeLinecap="round" />

      <circle cx="172" cy="22" r="26" fill="url(#nd-glow)" />

      {/* Same gesture as the favicon: a rise, a dip, a bigger rise, a dot at the
          peak. `nd-draw` is defined in index.css, where the global
          prefers-reduced-motion block already cuts its duration to nothing —
          which is why the resting state is dashoffset 0 and the keyframe
          animates FROM the hidden end, rather than the other way round. */}
      <path
        d="M20 86 L56 60 L86 68 L116 42 L146 52 L172 22"
        fill="none"
        stroke="url(#nd-line)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="[stroke-dasharray:400] [stroke-dashoffset:0] animate-[nd-draw_900ms_cubic-bezier(.2,0,0,1)]"
      />
      <circle cx="172" cy="22" r="6.5" fill="#3fb950" />
    </svg>
  )
}

export function NoData({
  title,
  children,
  cta = 'Add data',
}: {
  title: string
  /** One sentence. If it needs two, it is documentation, not an empty state. */
  children: string
  cta?: string
}) {
  return (
    // `flex-1`, not a vh fraction and not `min-h-full`. A `60vh` box centred the
    // hero in the top two thirds and left ~290px of dead space under it on a
    // 390x844 phone, which reads as a page that failed to load rather than as a
    // page with nothing on it. `min-h-full` did not help either: <main> is
    // itself a flex item, so a percentage min-height there resolves to auto and
    // there was nothing for `justify-center` to distribute. <main> is a column
    // flex container for this one reason, and this grows into it.
    <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-8">
      <Illustration />
      <h1 className="text-xl sm:text-2xl font-semibold mt-6">{title}</h1>
      <p className="text-sm text-muted mt-2 max-w-sm">{children}</p>
      <a
        href="#/data"
        className="mt-6 inline-flex items-center justify-center gap-2 min-h-[48px] px-6 rounded-xl bg-accent text-white text-sm font-medium
                   hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        {cta}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </a>
      {/* Kept, at one line. It is the reason to use this app at all, and the
          question every new user has about handing over a brokerage statement. */}
      <p className="text-xs text-muted mt-4">Your statement never leaves this device.</p>
    </div>
  )
}
