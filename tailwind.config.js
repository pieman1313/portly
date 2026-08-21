/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b0f16', surface: '#131926', border: '#222c3d',
        ink: '#e6edf7', muted: '#8b9ab3',
        // P/L text. Both clear WCAG AA (4.5:1) on the page and card surfaces
        // (6.92 and 5.24) — the status-palette red does not, at 3.66, so it is
        // reserved for badges that also carry an icon and a label.
        pos: '#3fb950', neg: '#f85149', accent: '#3987e5',
        good: '#0ca30c', warn: '#fab219', serious: '#ec835a', crit: '#d03b3b',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
