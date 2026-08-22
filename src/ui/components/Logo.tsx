/**
 * The app mark, inlined.
 *
 * Same geometry as public/favicon.svg — deliberately the same path data, so the
 * thing in the header is recognisably the icon on the home screen and in the
 * browser tab. `src/ui/components/logo.test.ts` asserts the two have not
 * drifted, because a favicon is edited once a year and nobody thinks to look in
 * here when they do.
 *
 * Inlined rather than `<img src="favicon.svg">` for two reasons: it is 300-odd
 * bytes, so a request for it costs more than it saves, and the app is served
 * from a base path (/portly/ on Pages, / in dev) that an absolute src would get
 * wrong in one environment or the other.
 *
 * The favicon's rounded tile is NOT drawn. It is #0b0f16, which is exactly the
 * page background, so on either header it is an invisible square that only
 * pushes the glyph 20% smaller inside the same box. Without it the mark reads
 * as a logotype rather than as a shrunken app icon.
 */
export function Logo({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      // Decorative. Both headers already name the thing beside it — the
      // wordmark on desktop, the tab name on a phone — and the document title
      // carries "· Portly" on every route, so announcing this too would only
      // add a word before every screen name.
      aria-hidden
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path
        d="M12 44 L24 30 L34 38 L52 16"
        fill="none"
        stroke="#4c8dff"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="52" cy="16" r="5" fill="#3fb950" />
    </svg>
  )
}
