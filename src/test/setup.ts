// Dexie needs a real IndexedDB implementation under Node.
import 'fake-indexeddb/auto'

// Testing Library gives an async assertion one second. That was a fair budget
// when a tab's module was a plain esbuild transform; with the React Compiler in
// the pipeline the first `import()` of a tab costs noticeably more, and the CI
// runner measured about twice this machine's wall clock — so Overview sat in
// its Suspense fallback while the clock ran out. Ten seconds is still short
// enough to fail a genuinely stuck screen well inside the 30s test budget.
//
// Dynamically imported: this file also runs for the 400+ node-environment
// tests, which have no document for @testing-library/dom to attach to.
if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/dom')
  configure({ asyncUtilTimeout: 10_000 })
}
