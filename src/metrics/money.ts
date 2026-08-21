/**
 * Scalar arithmetic that survives IEEE-754.
 *
 * No decimal dependency: the whole app must stay small enough to be a static
 * PWA, and a portfolio tracker only needs correct *rounding* and *summation*,
 * not arbitrary precision. Two rules follow from that:
 *
 *   1. Never round mid-calculation. Round at boundaries only (storage,
 *      display, reconciliation against IBKR's own totals).
 *   2. Never sum a long series with `+=`. 380 rows of six-figure euros lose
 *      cents to cancellation; IBKR's stated totals then disagree with ours and
 *      the import report cries wolf.
 */

/** Quantities: IBKR reports 4dp (144.6797), providers hand back more. */
export const QTY_DP = 9
/** Money: per-share rates like 0.004821 need more than 2dp to survive. */
export const MONEY_DP = 6
/** Display only. Never feed a display-rounded number back into a calculation. */
export const DISPLAY_DP = 2

/** Dust threshold for "this position is closed". One nano-share. */
export const EPS_QTY = 1e-9
/** Dust threshold for money. A millionth of a cent. */
export const EPS_MONEY = 1e-6

/**
 * Multiply by a power of ten via the decimal exponent rather than arithmetic.
 * `1.005 * 100` is 100.49999999999999 and rounds DOWN, which is how trackers
 * end up a cent short; `Number('1.005e2')` is exactly 100.5.
 */
function shift(n: number, exp: number): number {
  const parts = n.toString().split('e')
  const mantissa = parts[0] ?? '0'
  const e = parts[1] === undefined ? 0 : Number(parts[1])
  return Number(`${mantissa}e${e + exp}`)
}

/** Half away from zero — the convention every broker statement uses. */
export function round(n: number, dp: number): number {
  if (!Number.isFinite(n)) return n
  const shifted = shift(n, dp)
  if (!Number.isFinite(shifted)) return n
  const rounded = shifted < 0 ? -Math.round(-shifted) : Math.round(shifted)
  const out = shift(rounded, -dp)
  // `-0` renders as "-0" and looks like a bug to the user.
  return out === 0 ? 0 : out
}

export function roundQty(n: number): number {
  return round(n, QTY_DP)
}

export function roundMoney(n: number): number {
  return round(n, MONEY_DP)
}

export function roundDisplay(n: number, dp: number = DISPLAY_DP): number {
  return round(n, dp)
}

/**
 * Neumaier summation — Kahan's compensation, plus the fix for the case where
 * the running total is SMALLER than the addend (a large sale following many
 * small dividends). Non-finite inputs propagate on purpose: a NaN here means a
 * price or FX lookup returned garbage, and hiding it produces a plausible,
 * wrong total.
 */
export function sum(ns: Iterable<number>): number {
  let acc = 0
  let comp = 0
  for (const n of ns) {
    const t = acc + n
    comp += Math.abs(acc) >= Math.abs(n) ? acc - t + n : n - t + acc
    acc = t
  }
  return acc + comp
}

export function sumBy<T>(items: Iterable<T>, fn: (item: T) => number): number {
  const values: number[] = []
  for (const item of items) values.push(fn(item))
  return sum(values)
}

/** Sums only the numbers, skipping nulls — for columns where "no price" is legal. */
export function sumDefined(ns: Iterable<number | null | undefined>): number {
  const values: number[] = []
  for (const n of ns) if (n !== null && n !== undefined) values.push(n)
  return sum(values)
}

export function isZero(n: number, eps: number = EPS_QTY): boolean {
  return Math.abs(n) <= eps
}

/**
 * Division that refuses to invent a number. Returns null when the denominator
 * is zero (a cash-only portfolio has no yield; it does not have a yield of 0)
 * or when either side is not finite.
 */
export function ratio(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole)) return null
  if (whole === 0) return null
  const r = part / whole
  return Number.isFinite(r) ? r : null
}

/** As `ratio`, scaled to a percentage. Everything named `...Pct` is 0..100. */
export function pct(part: number, whole: number): number | null {
  const r = ratio(part, whole)
  return r === null ? null : r * 100
}

/** Clamp for guarding root-finders and weights. */
export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}
