/**
 * Run a real IBKR statement through the ingest pipeline and print what we
 * derived, plus how it reconciles against IBKR's own stated totals.
 *
 * Deliberately NOT a unit test: it takes a path to a real brokerage export,
 * which must never be committed. Point it at a file outside the repo.
 *
 *   pnpm tsx scripts/verify-statement.ts /path/to/statement.csv
 */
import { readFileSync } from 'node:fs'
import { parseStatement } from '../src/ingest/statement'
import { derive } from '../src/ingest/derive'
import { PARSER_VERSION } from '../src/domain/types'

const path = process.argv[2]
if (!path) {
  console.error('usage: verify-statement.ts <path-to-statement.csv>')
  process.exit(2)
}

const text = readFileSync(path, 'utf8')
const { file, rows, warnings } = await parseStatement(text, path.split('/').pop() ?? 'statement.csv')
const bundle = derive(
  { ...file, id: file.sha256Raw, name: 'statement.csv', importedAt: new Date().toISOString(), parserVersion: PARSER_VERSION },
  rows,
)

const n = (v: number, dp = 2) => v.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp })

console.log(`\nStatement  ${file.account}  ${file.periodStart} .. ${file.periodEnd}  base ${file.baseCurrency}`)
console.log(`Rows       ${rows.length} across ${file.sections.length} sections`)
console.log(`Parser     ${warnings.length} warning(s)`)

console.log(`\nDerived`)
console.log(`  instruments   ${bundle.instruments.length}`)
console.log(`  transactions  ${bundle.transactions.length}`)
console.log(`  distributions ${bundle.distributions.length}`)
console.log(`  accruals      ${bundle.accruals.length} (${bundle.accruals.filter((a) => a.open).length} open)`)
console.log(`  cashEvents    ${bundle.cashEvents.length}`)
console.log(`  positions     ${bundle.positions.length}`)

console.log(`\nInstruments (identity)`)
for (const i of bundle.instruments) {
  console.log(
    `  ${i.symbol.padEnd(7)} ${(i.isin ?? '-').padEnd(13)} conid=${(i.conid ?? '-').padEnd(10)} ` +
    `${i.identitySource.padEnd(15)} aliases=[${i.aliases.join(',')}] ${i.tradeCurrency ?? '?'}/${i.divCurrency ?? '-'}`,
  )
}

console.log(`\nOpen (declared, unpaid) dividends`)
for (const a of bundle.accruals.filter((x) => x.open).sort((x, y) => x.payDate.localeCompare(y.payDate))) {
  const inst = bundle.instruments.find((i) => i.key === a.instrumentKey)
  console.log(`  ${(inst?.symbol ?? a.instrumentKey).padEnd(7)} pay ${a.payDate}  ex ${a.exDate}  ${a.currency} ${n(a.net).padStart(10)}  (${a.quantity} sh @ ${a.grossRate})`)
}

console.log(`\nReconciliation vs IBKR's own totals`)
let bad = 0
for (const c of bundle.reconciliation) {
  const mark = c.ok ? 'ok  ' : 'FAIL'
  if (!c.ok) bad++
  console.log(`  [${mark}] ${c.label.padEnd(34)} ours ${n(c.ours).padStart(14)}  theirs ${n(c.theirs).padStart(14)}  ${c.currency}`)
}

if (warnings.length) {
  console.log(`\nWarnings`)
  for (const w of warnings.slice(0, 20)) console.log(`  - ${w}`)
}
if (bundle.warnings.length) {
  console.log(`\nDerive warnings`)
  for (const w of bundle.warnings.slice(0, 20)) console.log(`  - ${w}`)
}

// ── metrics over the derived entities ────────────────────────────────────────
const { buildHoldings } = await import('../src/metrics/holdings')
const { project12Months, forwardIncome } = await import('../src/metrics/forecast')
const { yields } = await import('../src/metrics/income')
const { fetchRatesRange } = await import('../src/providers/frankfurter')

const base = file.baseCurrency ?? 'USD'
const settings = {
  id: 'settings' as const, baseCurrency: base, showNetDividends: true,
  costBasisMethod: 'FIFO' as const, enableMarketData: true, lastRefresh: null,
}

// Real ECB rates, so the base-currency figures are honest rather than 1:1.
const ccys = [...new Set([
  ...bundle.transactions.map((t) => t.currency),
  ...bundle.distributions.map((d) => d.currency),
  ...bundle.positions.map((p) => p.currency),
])].filter((c) => c !== base)
const dates = bundle.transactions.map((t) => t.date).sort()
const fx = await fetchRatesRange(dates[0] ?? file.periodStart ?? '2024-01-01', file.periodEnd ?? new Date().toISOString().slice(0, 10), base, ccys)
const rates = fx.ok ? fx.value : []
console.log(`\nFX  ${fx.ok ? `${rates.length} rates for ${ccys.join(',')}->${base}` : `unavailable: ${fx.reason}`}`)

const portfolio = buildHoldings(
  bundle.transactions, bundle.instruments, [], bundle.positions, settings,
  { rates, asOf: file.periodEnd ?? undefined },
)

console.log(`\nHoldings (valued at the statement's own closing prices)`)
console.log(`  ${'sym'.padEnd(7)} ${'qty'.padStart(10)} ${'price'.padStart(10)} ${'value'.padStart(13)} ${'cost'.padStart(13)} ${'unreal'.padStart(12)} ${'wt%'.padStart(6)}`)
for (const h of [...portfolio.holdings].sort((a, b) => (b.marketValueBase ?? 0) - (a.marketValueBase ?? 0))) {
  console.log(
    `  ${h.symbol.padEnd(7)} ${n(h.quantity, 4).padStart(10)} ${n(h.price ?? 0).padStart(10)} ` +
    `${n(h.marketValueBase ?? 0).padStart(13)} ${n(h.costBasisBase ?? 0).padStart(13)} ` +
    `${n(h.unrealizedPnlBase ?? 0).padStart(12)} ${(h.weightPct ?? 0).toFixed(1).padStart(6)}`,
  )
}
console.log(`  ${'TOTAL'.padEnd(7)} ${''.padStart(10)} ${''.padStart(10)} ${n(portfolio.marketValueBase).padStart(13)} ${n(portfolio.costBasisBase).padStart(13)} ${n(portfolio.unrealizedPnlBase).padStart(12)}`)
if (portfolio.unpriced.length) console.log(`  unpriced: ${portfolio.unpriced.join(', ')}`)
if (portfolio.missingFx.length) console.log(`  missing FX: ${portfolio.missingFx.join(', ')}`)
if (portfolio.discrepancies.length) console.log(`  ledger/broker quantity discrepancies: ${portfolio.discrepancies.length}`)

const asOf = file.periodEnd ?? new Date().toISOString().slice(0, 10)
const forecast = project12Months(portfolio.holdings, bundle.accruals, [], base, rates, asOf, { net: true })
const income = forwardIncome(forecast)
const y = yields(portfolio.holdings, income)

console.log(`\nForward income (declared accruals only — no provider data in this run)`)
for (const m of forecast.months.filter((x) => x.items.length > 0)) {
  console.log(`  ${m.month}  ${n(m.netBase).padStart(10)} ${base}  ${m.items.map((i) => `${i.symbol ?? i.instrumentKey}:${i.basis}`).join(' ')}`)
}
console.log(`  12m total ${n(forecast.totalBase)} ${base}   coverage ${(forecast.coverage.ratio * 100).toFixed(0)}% of ${forecast.coverage.positions} positions estimated`)
console.log(`\nYields`)
console.log(`  passive income % (fwd, ex-cash)  ${y.forwardYieldExCashPct?.toFixed(2) ?? '—'}`)
console.log(`  yield on cost                    ${y.yieldOnCostPct?.toFixed(2) ?? '—'}`)
console.log(`  dividends received (all time)    ${n(bundle.distributions.reduce((s, d) => s + d.net, 0))} (mixed ccy)`)

console.log(bad === 0 ? '\nAll reconciliation checks passed.\n' : `\n${bad} reconciliation check(s) FAILED.\n`)
process.exit(bad === 0 ? 0 : 1)
