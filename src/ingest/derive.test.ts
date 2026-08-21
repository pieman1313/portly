import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import type { RawFile, RawRow } from '../domain/types'
import { derive, num, parseDescription, toDate, toDateTime } from './derive'
import type { DerivedBundle } from './derive'
import { parseStatement } from './statement'

const FIXTURE = readFileSync(
  fileURLToPath(new URL('../test/fixtures/activity-basic.csv', import.meta.url)),
  'utf8',
)

/** Real parse → real derive. The raw layer is not mocked. */
async function read(csv: string, over: Partial<RawFile> = {}): Promise<{ file: RawFile; rows: RawRow[] }> {
  const parsed = await parseStatement(csv, 'activity-basic.csv')
  return { file: { ...parsed.file, importedAt: '2026-01-06T10:00:00', ...over }, rows: parsed.rows }
}

async function deriveCsv(csv: string, over: Partial<RawFile> = {}): Promise<DerivedBundle> {
  const { file, rows } = await read(csv, over)
  return derive(file, rows)
}

/** The whole fixture, derived once. */
let BASIC: DerivedBundle
let BASIC_FILE: RawFile
let BASIC_ROWS: RawRow[]
beforeAll(async () => {
  const parsed = await read(FIXTURE)
  BASIC_FILE = parsed.file
  BASIC_ROWS = parsed.rows
  BASIC = derive(BASIC_FILE, BASIC_ROWS)
})
const basic = (): DerivedBundle => BASIC

const FII_HEADER =
  'Financial Instrument Information,Header,Asset Category,Symbol,Description,Conid,Security ID,Underlying,Listing Exch,Multiplier,Type,Code'
const FII_ACME =
  'Financial Instrument Information,Data,Stocks,ACME,"ACME CORP, CLASS ""A""",222222222,US0000000002,ACME,NASDAQ,1,COMMON,'
const TRADES_HEADER =
  'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code'

/** Derive a hand-written statement fragment, preamble included. */
function mini(lines: string[], over: Partial<RawFile> = {}): Promise<DerivedBundle> {
  return deriveCsv(
    [
      'Statement,Header,Field Name,Field Value',
      'Statement,Data,Title,Activity Statement',
      'Statement,Data,Period,"January 1, 2025 - December 31, 2025"',
      'Account Information,Header,Field Name,Field Value',
      'Account Information,Data,Account,U00000001',
      'Account Information,Data,Base Currency,USD',
      ...lines,
    ].join('\n'),
    over,
  )
}

const byLabel = (bundle: DerivedBundle, label: string) =>
  bundle.reconciliation.find((c) => c.label === label)

// ─────────────────────────────────────────────────────────────────────────────

describe('num', () => {
  it('strips thousands separators from quoted numbers', () => {
    expect(num('3,334.3400')).toBe(3334.34)
    expect(num('1,234.5600')).toBe(1234.56)
    expect(num('-102,774.80')).toBe(-102774.8)
    expect(num('23,456.7800')).toBe(23456.78)
  })

  it('maps every IBKR flavour of blank to null, but never zero', () => {
    expect(num('')).toBeNull()
    expect(num('--')).toBeNull()
    expect(num('-')).toBeNull()
    expect(num(' ')).toBeNull()
    expect(num(undefined)).toBeNull()
    expect(num('0')).toBe(0)
    expect(num('-0.03')).toBe(-0.03)
  })

  it('keeps full decimal precision — fractional shares are real', () => {
    expect(num('144.6797')).toBe(144.6797)
    expect(num('152949.128270194')).toBe(152949.128270194)
  })
})

describe('dates', () => {
  it('reads both the datetime and the bare-date form ClosedLot rows use', () => {
    expect(toDateTime('2025-07-14, 07:37:45')).toBe('2025-07-14T07:37:45')
    expect(toDateTime('2021-03-15')).toBe('2021-03-15T00:00:00')
    expect(toDate('2025-07-14, 07:37:45')).toBe('2025-07-14')
    expect(toDate('nonsense')).toBeNull()
  })
})

describe('parseDescription', () => {
  it('pulls symbol, ISIN, rate and type out of a dividend line', () => {
    expect(parseDescription('TDIV(NL0011683594) Cash Dividend EUR 0.36 per Share (Ordinary Dividend)')).toEqual({
      symbol: 'TDIV',
      isin: 'NL0011683594',
      perShare: 0.36,
      divType: 'Ordinary Dividend',
    })
  })

  it('takes everything before the first paren, so dotted tickers survive', () => {
    expect(parseDescription('BRK.B(US0846707026) Cash Dividend USD 1.00 per Share').symbol).toBe('BRK.B')
  })

  it('degrades gracefully on the shapes that do not match', () => {
    expect(parseDescription('Withholding @ 20% on Credit Interest')).toEqual({
      symbol: null,
      isin: null,
      perShare: null,
      divType: null,
    })
    expect(parseDescription('XSDG(US7960542030) Cash Dividend USD 0.202828 per Share - FEE').divType).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('instrument identity', () => {
  it('collapses a ticker rename into ONE instrument via the alias list', () => {
    const { instruments, transactions } = basic()
    expect(instruments).toHaveLength(3)

    const renamed = instruments.find((i) => i.aliases.includes('OLDT'))
    expect(renamed).toBeDefined()
    expect(renamed?.key).toBe('111111111')
    expect(renamed?.identitySource).toBe('conid')
    expect(renamed?.aliases.sort()).toEqual(['NEWT', 'OLDT'])
    expect(renamed?.isin).toBe('NL0000000001')

    // No stub keyed on either bare ticker.
    expect(instruments.map((i) => i.key)).toEqual(['111111111', '222222222', '333333333'])
    // The OLDT fill and the NEWT fill are the same holding.
    const eur = transactions.filter((t) => t.currency === 'EUR')
    expect(eur.map((t) => t.instrumentKey)).toEqual(['111111111', '111111111'])
  })

  it('defaults the displayed ticker to the undecorated root, not the alias order', () => {
    // The Symbol cell reads "NEWT, OLDT" and Underlying says OLDT. Underlying
    // wins: the Symbol cell's ordering is IBKR's business and can differ
    // between exports, so keying display off it makes a holding rename itself
    // for no reason. In a real statement this is the difference between the
    // venue-suffixed "VDIVd" and "TDIV", the ticker the market actually uses —
    // and the one the price feed resolves.
    const renamed = basic().instruments.find((i) => i.key === '111111111')
    expect(renamed?.symbol).toBe('OLDT')
    expect(renamed?.aliases).toContain('NEWT')
  })

  it('records the trade currency and the (different) dividend currency', () => {
    const { instruments } = basic()
    const acme = instruments.find((i) => i.symbol === 'ACME')
    expect(acme?.tradeCurrency).toBe('USD')
    expect(acme?.divCurrency).toBe('USD')
    // GLOB never paid anything, so there is no dividend currency to invent.
    expect(instruments.find((i) => i.symbol === 'GLOB')?.divCurrency).toBeNull()
  })

  it('resolves a dividend to the instrument through the ISIN in its description', () => {
    // The Dividends row says OLDT; the position and the FII row say NEWT.
    const { distributions } = basic()
    expect(distributions[0]?.instrumentKey).toBe('111111111')
  })

  it('mints a symbol-keyed stub, and warns, when there is no reference row', async () => {
    const b = await mini([
      'Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code',
      'Open Positions,Data,Summary,Stocks,USD,NEWCO,10,1,5,50,6,60,10,',
    ])
    expect(b.instruments).toHaveLength(1)
    expect(b.instruments[0]?.key).toBe('NEWCO')
    expect(b.instruments[0]?.identitySource).toBe('symbol')
    expect(b.warnings.join(' ')).toContain('No instrument reference for "NEWCO"')
  })
})

describe('trades', () => {
  it('excludes ClosedLot rows from the ledger and reports them', () => {
    const { transactions, warnings } = basic()
    expect(transactions).toHaveLength(5)
    expect(transactions.some((t) => t.sourceRowIds.includes(`${BASIC_FILE.id}:37`))).toBe(false)
    expect(warnings.join(' ')).toContain('1 ClosedLot row(s) excluded')

    // Naively summing the three ACME rows gives 200.5 shares and 1993 of P/L.
    const acme = transactions.filter((t) => t.instrumentKey === '222222222')
    expect(acme.reduce((s, t) => s + t.quantity, 0)).toBe(100.25)
    expect(acme.reduce((s, t) => s + t.realizedPnl, 0)).toBe(996.5)
  })

  it('signs a sale negative and carries its realized P/L', () => {
    const sell = basic().transactions.find((t) => t.kind === 'SELL')
    expect(sell?.quantity).toBe(-100.25)
    expect(sell?.price).toBe(60)
    expect(sell?.proceeds).toBe(6015)
    expect(sell?.realizedPnl).toBe(996.5)
    expect(sell?.codes).toEqual(['C', 'P'])
  })

  it('stores commission as a positive cost whatever sign IBKR used', () => {
    expect(basic().transactions.every((t) => t.fees >= 0)).toBe(true)
    expect(basic().transactions.find((t) => t.kind === 'SELL')?.fees).toBe(4)
  })

  it('parses a price written with a thousands separator', () => {
    const glob = basic().transactions.find((t) => t.instrumentKey === '333333333')
    expect(glob?.price).toBe(1234.56)
    expect(glob?.proceeds).toBe(-98764.8)
  })

  it('routes Forex trades to cash, never to the ledger', () => {
    const { transactions, cashEvents } = basic()
    expect(transactions.some((t) => t.currency === 'EUR.USD' || t.price === 1.085)).toBe(false)
    const fx = cashEvents.find((e) => e.kind === 'FX')
    expect(fx?.amount).toBe(-4340)
    expect(fx?.currency).toBe('USD')
    // …and its commission is still real money.
    expect(cashEvents.find((e) => e.description.startsWith('Commission on EUR.USD'))?.amount).toBe(-2)
  })

  it('ingests only the Order grain when both grains are present', async () => {
    const b = await mini([
      FII_HEADER,
      FII_ACME,
      TRADES_HEADER,
      'Trades,Data,Order,Stocks,USD,ACME,"2025-02-01, 10:00:00",100,50,50,-5000,-1,5001,0,0,O',
      'Trades,Data,Trade,Stocks,USD,ACME,"2025-02-01, 10:00:00",60,50,50,-3000,-0.6,3000.6,0,0,O',
      'Trades,Data,Trade,Stocks,USD,ACME,"2025-02-01, 10:30:00",40,50,50,-2000,-0.4,2000.4,0,0,O',
    ])
    expect(b.transactions).toHaveLength(1)
    expect(b.transactions[0]?.quantity).toBe(100)
  })

  it('falls back to the Trade grain when no Order rows exist', async () => {
    const b = await mini([
      FII_HEADER,
      FII_ACME,
      TRADES_HEADER,
      'Trades,Data,Trade,Stocks,USD,ACME,"2025-02-01, 10:00:00",60,50,50,-3000,-0.6,3000.6,0,0,O',
      'Trades,Data,Trade,Stocks,USD,ACME,"2025-02-01, 10:30:00",40,50,50,-2000,-0.4,2000.4,0,0,O',
    ])
    expect(b.transactions).toHaveLength(2)
  })
})

describe('open positions', () => {
  it('ignores the stack of consecutive Total rows', () => {
    const { positions } = basic()
    expect(positions).toHaveLength(3)
    // 6315 (EUR sub) + 5533.8 + 104000. The file also states 7325.4 (that EUR
    // block translated to USD) and 116859.2 (the grand total) as Total rows;
    // counting either would inflate the portfolio.
    expect(positions.reduce((s, p) => s + p.value, 0)).toBeCloseTo(115848.8, 6)
    expect(positions.some((p) => p.value === 7325.4 || p.value === 116859.2)).toBe(false)
    expect(positions.map((p) => p.instrumentKey)).toEqual(['111111111', '222222222', '333333333'])
  })

  it('carries the close price so the portfolio values offline', () => {
    const acme = basic().positions.find((p) => p.instrumentKey === '222222222')
    expect(acme).toMatchObject({
      account: 'U00000001',
      asOf: '2025-12-31',
      currency: 'USD',
      quantity: 100.25,
      closePrice: 55.2,
      value: 5533.8,
      unrealizedPnl: 521.3,
    })
    expect(acme?.id).toBe('U00000001|2025-12-31|222222222')
  })

  it('skips Lot rows in favour of the Summary row', async () => {
    const b = await mini([
      'Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code',
      'Open Positions,Data,Summary,Stocks,USD,ACME,10,1,5,50,6,60,10,',
      'Open Positions,Data,Lot,Stocks,USD,ACME,4,1,5,20,6,24,4,',
      'Open Positions,Data,Lot,Stocks,USD,ACME,6,1,5,30,6,36,6,',
    ])
    expect(b.positions).toHaveLength(1)
    expect(b.positions[0]?.quantity).toBe(10)
  })
})

describe('dividends and withholding', () => {
  it('parses the description and attaches the matching withholding', () => {
    const eur = basic().distributions.find((d) => d.currency === 'EUR')
    expect(eur).toMatchObject({
      isin: 'NL0000000001',
      payDate: '2025-06-20',
      gross: 50,
      tax: 7.5, // stored positive, though IBKR reports -7.5
      net: 42.5,
      perShare: 0.5,
      divType: 'Ordinary Dividend',
    })
    // Ex-date comes from the accrual that paired with it.
    expect(eur?.exDate).toBe('2025-06-11')
    expect(eur?.sourceRowIds).toEqual([`${BASIC_FILE.id}:51`, `${BASIC_FILE.id}:59`])
  })

  it('leaves untaxed dividends alone', () => {
    const usd = basic().distributions.filter((d) => d.currency === 'USD')
    expect(usd).toHaveLength(2)
    expect(usd.every((d) => d.tax === 0 && d.net === d.gross)).toBe(true)
  })

  it('does not treat the Total rows as dividends', () => {
    // Four Data rows in the section are totals; only three are payments.
    expect(basic().distributions).toHaveLength(3)
  })

  it('turns withholding with no dividend into a TAX cash event', async () => {
    const b = await mini([
      'Withholding Tax,Header,Currency,Date,Description,Amount,Code',
      'Withholding Tax,Data,USD,2025-08-05,Withholding @ 20% on Credit Interest,-2.47,',
      'Withholding Tax,Data,Total,,,-2.47,',
    ])
    expect(b.distributions).toHaveLength(0)
    expect(b.cashEvents).toHaveLength(1)
    expect(b.cashEvents[0]).toMatchObject({ kind: 'TAX', amount: -2.47, currency: 'USD' })
    expect(byLabel(b, 'Withholding tax (USD)')?.ok).toBe(true)
  })

  it('keeps two genuinely identical same-day dividends apart', async () => {
    const lines = [
      FII_HEADER,
      FII_ACME,
      'Dividends,Header,Currency,Date,Description,Amount',
      'Dividends,Data,USD,2025-05-05,ACME(US0000000002) Cash Dividend USD 0.10 per Share (Ordinary Dividend),10',
      'Dividends,Data,USD,2025-05-05,ACME(US0000000002) Cash Dividend USD 0.10 per Share (Ordinary Dividend),10',
      'Dividends,Data,Total,,,20',
    ]
    const b = await mini(lines)
    expect(b.distributions).toHaveLength(2)
    expect(b.distributions[0]?.id).not.toBe(b.distributions[1]?.id)
    expect(byLabel(b, 'Dividends (USD)')?.ok).toBe(true)
    // …and the same two ids come back on re-import, because the ordinal is
    // scoped to the day rather than to the file.
    expect((await mini(lines)).distributions.map((d) => d.id)).toEqual(b.distributions.map((d) => d.id))
  })
})

describe('accruals', () => {
  it('nets Po against Re, keeping near-identical restated postings distinct', () => {
    const { accruals } = basic()
    expect(accruals).toHaveLength(2)

    // Two Po rows differing only in tax (7.4 / 7.5) and two matching Re rows.
    // All four are one accrual group and net to zero.
    const paid = accruals.find((a) => a.payDate === '2025-06-20')
    expect(paid?.sourceRowIds).toHaveLength(4)
    expect(paid?.gross).toBe(0)
    expect(paid?.tax).toBe(0)
    expect(paid?.net).toBe(0)
    expect(paid?.open).toBe(false)
  })

  it('leaves the un-reversed accrual open, with the record-date quantity', () => {
    const open = basic().accruals.find((a) => a.open)
    expect(open).toMatchObject({
      instrumentKey: '111111111',
      exDate: '2025-12-31',
      payDate: '2026-01-15',
      quantity: 150,
      grossRate: 0.42,
      currency: 'EUR',
      gross: 63,
      net: 63,
    })
  })

  it('keeps a restated residual open, because the broker counts it too', async () => {
    // A restated Po/Re pair leaves 0.10 behind on an already-paid dividend.
    // It is still part of the accrual BALANCE, so `open` must stay true —
    // IBKR's own Ending Dividend Accruals includes exactly these residuals.
    // Suppressing it here would put us a cent away from the broker and break
    // the reconciliation check. Hiding it from the forecast is forecast.ts's
    // job, and it does that by pay date.
    const b = await mini([
      'Change in Dividend Accruals,Header,Asset Category,Currency,Symbol,Date,Ex Date,Pay Date,Quantity,Tax,Fee,Gross Rate,Gross Amount,Net Amount,Code',
      'Change in Dividend Accruals,Data,Stocks,USD,ACME,2025-03-01,2025-03-02,2025-03-10,100,0,0,0.5,50,50,Po',
      'Change in Dividend Accruals,Data,Stocks,USD,ACME,2025-03-10,2025-03-02,2025-03-10,100,0,0,0.5,-49.9,-49.9,Re',
      'Change in Dividend Accruals,Data,Stocks,USD,ACME,2025-12-20,2025-12-21,2026-01-10,100,0,0,0.5,50,50,Po',
    ])
    expect(b.accruals).toHaveLength(2)
    const stale = b.accruals.find((a) => a.payDate === '2025-03-10')
    expect(stale?.net).toBeCloseTo(0.1, 10)
    expect(stale?.open).toBe(true)
    expect(b.accruals.find((a) => a.payDate === '2026-01-10')?.open).toBe(true)
  })

  it('nets a fully reversed accrual to closed', async () => {
    const b = await mini([
      'Change in Dividend Accruals,Header,Asset Category,Currency,Symbol,Date,Ex Date,Pay Date,Quantity,Tax,Fee,Gross Rate,Gross Amount,Net Amount,Code',
      'Change in Dividend Accruals,Data,Stocks,USD,ACME,2025-03-01,2025-03-02,2025-03-10,100,0,0,0.5,50,50,Po',
      'Change in Dividend Accruals,Data,Stocks,USD,ACME,2025-03-10,2025-03-02,2025-03-10,100,0,0,0.5,-50,-50,Re',
    ])
    expect(b.accruals).toHaveLength(1)
    expect(b.accruals[0]?.open).toBe(false)
  })

  it('still reports an accrual whose pay date precedes the statement end', async () => {
    // Regression: an earlier rule required payDate >= period end, which silently
    // dropped a genuine 71.83 EUR accrual paid one day before the period closed
    // and put us out of step with the broker's own balance.
    const b = await mini([
      'Change in Dividend Accruals,Header,Asset Category,Currency,Symbol,Date,Ex Date,Pay Date,Quantity,Tax,Fee,Gross Rate,Gross Amount,Net Amount,Code',
      'Change in Dividend Accruals,Data,Stocks,EUR,ACME,2025-12-02,2025-12-03,2025-12-10,313,11.9,0,0.27,84.5,72.6,Po',
      'Change in Dividend Accruals,Data,Stocks,EUR,ACME,2025-12-02,2025-12-03,2025-12-10,313,12.68,0,0.27,84.51,71.83,Po',
      'Change in Dividend Accruals,Data,Stocks,EUR,ACME,2025-12-02,2025-12-03,2025-12-10,313,-11.9,0,0.27,-84.5,-72.6,Re',
    ])
    const a = b.accruals.find((x) => x.payDate === '2025-12-10')
    expect(a?.open).toBe(true)
    expect(a?.net).toBeCloseTo(71.83, 6)
  })
})

describe('exchange rates recovered from the statement', () => {
  it('reads the rate out of the base-currency restatement of a currency block', () => {
    // The fixture states a EUR block (cost 6075, value 6315) and then restates
    // it in USD (7047, 7325.4). Both columns scale by 1.16, which is what marks
    // the row as a translation rather than an unrelated subtotal.
    const b = basic()
    const eur = b.fxRates.find((r) => r.quote === 'EUR')
    expect(eur).toBeDefined()
    expect(eur?.base).toBe('USD')
    expect(eur?.date).toBe('2025-12-31')
    expect(1 / (eur?.rate ?? 0)).toBeCloseTo(1.16, 6)
  })

  it('ignores a following total whose two columns disagree', async () => {
    // Cost scales by 1.10 and value by 1.30 — not a translation, just the next
    // subtotal in the file. Inventing an exchange rate from it would silently
    // misprice a whole currency sleeve.
    const b = await mini([
      'Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code',
      'Open Positions,Data,Summary,Stocks,EUR,AAA,100,1,10,1000,12,1200,200,',
      'Open Positions,Total,,Stocks,EUR,,,,,1000,,1200,200,',
      'Open Positions,Total,,Stocks,USD,,,,,1100,,1560,460,',
    ])
    expect(b.fxRates).toEqual([])
  })

  it('does not invent a rate from a single usable column', async () => {
    const b = await mini([
      'Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code',
      'Open Positions,Data,Summary,Stocks,EUR,AAA,100,1,10,1000,12,1200,200,',
      'Open Positions,Total,,Stocks,EUR,,,,,1000,,,,',
      'Open Positions,Total,,Stocks,USD,,,,,1160,,,,',
    ])
    expect(b.fxRates).toEqual([])
  })
})

describe('cash events', () => {
  it('reads deposits and interest without swallowing the total rows', () => {
    const { cashEvents } = basic()
    expect(cashEvents.filter((e) => e.kind === 'DEPOSIT')).toHaveLength(1)
    expect(cashEvents.find((e) => e.kind === 'DEPOSIT')?.amount).toBe(25000)
    expect(cashEvents.filter((e) => e.kind === 'INTEREST')).toHaveLength(1)
    expect(cashEvents.find((e) => e.kind === 'INTEREST')?.amount).toBe(12.34)
  })

  it('signs a withdrawal by its amount', async () => {
    const b = await mini([
      'Deposits & Withdrawals,Header,Currency,Settle Date,Description,Amount',
      'Deposits & Withdrawals,Data,USD,2025-01-15,Electronic Fund Transfer,"25,000"',
      'Deposits & Withdrawals,Data,USD,2025-03-15,Electronic Fund Transfer,-5000',
      'Deposits & Withdrawals,Data,Total,,,20000',
    ])
    expect(b.cashEvents.map((e) => e.kind)).toEqual(['DEPOSIT', 'WITHDRAWAL'])
    expect(b.cashEvents[0]?.amount).toBe(25000)
    expect(byLabel(b, 'Deposits & Withdrawals (USD)')?.ok).toBe(true)
  })
})

describe('reconciliation', () => {
  it('agrees with every total IBKR states in the fixture', () => {
    const { reconciliation } = basic()
    const failures = reconciliation.filter((c) => !c.ok)
    expect(failures).toEqual([])
    expect(reconciliation.length).toBeGreaterThanOrEqual(20)
  })

  it('checks the things it claims to check', () => {
    const b = basic()
    for (const label of [
      'Open Positions value (EUR)',
      'Open Positions value (USD)',
      'Open Positions cost basis (USD)',
      'Dividends (EUR)',
      'Dividends (USD)',
      'Withholding tax (EUR)',
      'Interest (USD)',
      'Deposits & Withdrawals (USD)',
      'Deposits & Withdrawals — statement total',
      'Dividend accrual change (EUR)',
      'Trades quantity ACME (Stocks/USD)',
      'Trades proceeds ACME (Stocks/USD)',
      'Trades commission ACME (Stocks/USD)',
      'Trades realized P/L ACME (Stocks/USD)',
      'Trades quantity OLDT (Stocks/EUR)',
    ]) {
      expect(byLabel(b, label), label).toBeDefined()
    }
  })

  it('fails loudly when our total disagrees with IBKR', async () => {
    // The fixture, but with IBKR's stated total for the USD dividend block
    // altered. A reconciliation that cannot fail is not a reconciliation.
    const b = await deriveCsv(FIXTURE.replace('Dividends,Data,Total,,,95.24', 'Dividends,Data,Total,,,99.99'))
    expect(byLabel(b, 'Dividends (USD)')).toMatchObject({ ours: 95.24, theirs: 99.99, ok: false })
  })

  it('compares position value against the Net Asset Value stock row when no FX is needed', async () => {
    const b = await mini([
      'Net Asset Value,Header,Asset Class,Prior Total,Current Long,Current Short,Current Total,Change',
      'Net Asset Value,Data,Stock,0,1000,0,1000,1000',
      'Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code',
      'Open Positions,Data,Summary,Stocks,USD,ACME,10,1,90,900,100,1000,100,',
      'Open Positions,Total,,Stocks,USD,,,,,900,,1000,100,',
    ])
    expect(byLabel(b, 'Net Asset Value — Stock')).toMatchObject({ ours: 1000, theirs: 1000, ok: true })
  })

  it('skips the NAV comparison when a holding needs an FX rate we do not have', () => {
    // The fixture holds EUR and USD against a USD base.
    expect(byLabel(basic(), 'Net Asset Value — Stock')).toBeUndefined()
  })

  it('compares open accruals against the ending accrual balance', async () => {
    const b = await mini([
      'Change in Dividend Accruals,Header,Asset Category,Currency,Symbol,Date,Ex Date,Pay Date,Quantity,Tax,Fee,Gross Rate,Gross Amount,Net Amount,Code',
      'Change in Dividend Accruals,Data,Starting Dividend Accruals in USD,,,,,,,,,,,0,',
      'Change in Dividend Accruals,Data,Stocks,USD,ACME,2025-12-20,2025-12-21,2026-01-10,10,0,0,0.5,5,5,Po',
      'Change in Dividend Accruals,Data,Total,,,,,,,0,0,,5,5,',
      'Change in Dividend Accruals,Data,Ending Dividend Accruals in USD,,,,,,,,,,,5,',
    ])
    expect(byLabel(b, 'Open dividend accruals')).toMatchObject({ ours: 5, theirs: 5, ok: true })
    expect(byLabel(b, 'Dividend accrual change (USD)')).toMatchObject({ ours: 5, theirs: 5, ok: true })
  })
})

describe('regressions', () => {
  it('keeps a Trade-grain block that sits next to an Order-grain one', async () => {
    // The Trades section rebinds its header mid-file. Deciding the grain once
    // for the whole section threw away every row of the Forex block — a whole
    // currency conversion and its commission, silently, with no warning and no
    // reconciliation to catch it (Forex SubTotals are deliberately not checked).
    const b = await mini([
      FII_HEADER,
      FII_ACME,
      TRADES_HEADER,
      'Trades,Data,Order,Stocks,USD,ACME,"2025-02-01, 10:00:00",10,50,50,-500,-1,501,0,0,O',
      'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,,Proceeds,Comm in USD,,,MTM in USD,Code',
      'Trades,Data,Trade,Forex,USD,EUR.USD,"2025-03-09, 17:00:00",4000,1.0850,,-4340,-2,,,1.25,AFx',
    ])
    expect(b.transactions).toHaveLength(1)
    expect(b.cashEvents.map((e) => [e.kind, e.amount])).toEqual([
      ['FX', -4340],
      ['FEE', -2],
    ])
  })

  it('still collapses the Trade grain into the Order grain for one instrument', async () => {
    const b = await mini([
      FII_HEADER,
      FII_ACME,
      TRADES_HEADER,
      'Trades,Data,Order,Stocks,USD,ACME,"2025-02-01, 10:00:00",100,50,50,-5000,-1,5001,0,0,O',
      'Trades,Data,Trade,Stocks,USD,ACME,"2025-02-01, 10:00:00",60,50,50,-3000,-0.6,3000.6,0,0,O',
      'Trades,Data,Trade,Stocks,USD,ACME,"2025-02-01, 10:30:00",40,50,50,-2000,-0.4,2000.4,0,0,O',
    ])
    expect(b.transactions.map((t) => t.quantity)).toEqual([100])
  })

  it('puts a withholding line on the payment whose rate it names', async () => {
    // Two payments on one instrument on one day; the only withholding names
    // 0.20 per share. Pairing greedily in payment order handed it to the 0.10
    // payment, reporting 10 gross / 3 tax / 7 net on one and 20 / 0 / 20 on the
    // other — the section total still reconciled, so nothing complained.
    const b = await mini([
      FII_HEADER,
      FII_ACME,
      'Dividends,Header,Currency,Date,Description,Amount',
      'Dividends,Data,USD,2025-05-05,ACME(US0000000002) Cash Dividend USD 0.10 per Share (Ordinary Dividend),10',
      'Dividends,Data,USD,2025-05-05,ACME(US0000000002) Cash Dividend USD 0.20 per Share (Ordinary Dividend),20',
      'Dividends,Data,Total,,,30',
      'Withholding Tax,Header,Currency,Date,Description,Amount,Code',
      'Withholding Tax,Data,USD,2025-05-05,ACME(US0000000002) Cash Dividend USD 0.20 per Share - US Tax,-3,',
      'Withholding Tax,Data,Total,,,-3,',
    ])
    expect(b.distributions.map((d) => [d.perShare, d.gross, d.tax, d.net])).toEqual([
      [0.1, 10, 0, 10],
      [0.2, 20, 3, 17],
    ])
    expect(byLabel(b, 'Withholding tax (USD)')?.ok).toBe(true)
  })

  it('matches an Open Positions Total to the block whose currency it states', async () => {
    // IBKR stacks the native subtotal and its base-currency translation with
    // nothing but the Currency column to tell them apart. Taking whichever
    // came first compared 1000 EUR of holdings against the 1100 USD
    // restatement and reported a reconciliation failure we had not caused.
    const b = await mini([
      FII_HEADER,
      FII_ACME,
      'Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code',
      'Open Positions,Data,Summary,Stocks,EUR,ACME,10,1,90,900,100,1000,100,',
      'Open Positions,Total,,Stocks,USD,,,,,990,,1100,110,',
      'Open Positions,Total,,Stocks,EUR,,,,,900,,1000,100,',
    ])
    expect(byLabel(b, 'Open Positions value (EUR)')).toMatchObject({ ours: 1000, theirs: 1000, ok: true })
    expect(byLabel(b, 'Open Positions value (USD)')).toBeUndefined()
  })

  it('compares only stock positions against the NAV stock line', async () => {
    // The NAV section gives bonds their own line. Summing the whole book
    // against the Stock line reported every bond-holding account as broken.
    const b = await mini([
      'Net Asset Value,Header,Asset Class,Prior Total,Current Long,Current Short,Current Total,Change',
      'Net Asset Value,Data,Stock,0,1000,0,1000,1000',
      'Net Asset Value,Data,Bond,0,500,0,500,500',
      'Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code',
      'Open Positions,Data,Summary,Stocks,USD,ACME,10,1,90,900,100,1000,100,',
      'Open Positions,Data,Summary,Bonds,USD,BND,5,1,90,450,100,500,50,',
      'Open Positions,Total,,Stocks,USD,,,,,1350,,1500,150,',
    ])
    expect(byLabel(b, 'Net Asset Value — Stock')).toMatchObject({ ours: 1000, theirs: 1000, ok: true })
  })

  it('refuses to merge two securities that share a ticker but not an ISIN', async () => {
    // A ticker match used to win even against a contradicting ISIN, pooling a
    // London listing's dividend into the NASDAQ instrument's key.
    const b = await mini([
      FII_HEADER,
      'Financial Instrument Information,Data,Stocks,ACME,ACME US,222222222,US0000000002,,NASDAQ,1,COMMON,',
      'Dividends,Header,Currency,Date,Description,Amount',
      'Dividends,Data,GBP,2025-05-05,ACME(GB00B0000001) Cash Dividend GBP 0.10 per Share (Ordinary Dividend),1',
    ])
    expect(b.instruments.map((i) => i.key).sort()).toEqual(['222222222', 'GB00B0000001'])
    expect(b.distributions[0]?.instrumentKey).toBe('GB00B0000001')
  })

  it('keys a security with no reference row the same way whichever section names it', async () => {
    // Without a Financial Instrument Information section the key used to fall
    // out of the section walk order: trades-then-dividends gave `ACME`,
    // dividends-only gave the ISIN, and the two never merged across imports.
    const divLine =
      'Dividends,Data,USD,2025-05-05,ACME(US0000000002) Cash Dividend USD 0.10 per Share (Ordinary Dividend),1'
    const withTrades = await mini([
      TRADES_HEADER,
      'Trades,Data,Order,Stocks,USD,ACME,"2025-02-01, 10:00:00",10,50,50,-500,-1,501,0,0,O',
      'Trades,Data,Order,Stocks,USD,ACME,"2025-03-01, 10:00:00",10,50,50,-500,-1,501,0,0,O',
      'Dividends,Header,Currency,Date,Description,Amount',
      divLine,
    ])
    const divOnly = await mini(['Dividends,Header,Currency,Date,Description,Amount', divLine])
    expect(withTrades.instruments.map((i) => i.key)).toEqual(['US0000000002'])
    expect(divOnly.instruments.map((i) => i.key)).toEqual(['US0000000002'])
    // …and every trade of it agrees, including the first, which is hashed
    // before the instrument exists.
    expect(withTrades.transactions.map((t) => t.instrumentKey)).toEqual(['US0000000002', 'US0000000002'])
    expect(new Set(withTrades.transactions.map((t) => t.id)).size).toBe(2)
  })

  it('picks the ex-date by gross rate when one pay date carries two accruals', async () => {
    const lines = [
      FII_HEADER,
      FII_ACME,
      'Change in Dividend Accruals,Header,Asset Category,Currency,Symbol,Date,Ex Date,Pay Date,Quantity,Tax,Fee,Gross Rate,Gross Amount,Net Amount,Code',
      'Change in Dividend Accruals,Data,Stocks,USD,ACME,2025-04-01,2025-04-02,2025-05-05,100,0,0,0.1,10,10,Po',
      'Change in Dividend Accruals,Data,Stocks,USD,ACME,2025-04-01,2025-04-03,2025-05-05,100,0,0,0.2,20,20,Po',
      'Dividends,Header,Currency,Date,Description,Amount',
      'Dividends,Data,USD,2025-05-05,ACME(US0000000002) Cash Dividend USD 0.10 per Share (Ordinary Dividend),10',
    ]
    expect((await mini(lines)).distributions[0]?.exDate).toBe('2025-04-02')

    // …and reports nothing rather than a coin flip when the rate cannot tell
    // the two accruals apart.
    const ambiguous = await mini(lines.map((l) => l.replace(',0.2,20,20,Po', ',0.1,20,20,Po')))
    expect(ambiguous.distributions[0]?.exDate).toBeNull()
  })

  it('warns about an event section it parses but does not derive', async () => {
    const b = await mini([
      'Corporate Actions,Header,Asset Category,Currency,Report Date,Date/Time,Description,Quantity,Proceeds,Value,Realized P/L,Code',
      'Corporate Actions,Data,Stocks,USD,2025-03-01,"2025-03-01, 20:25:00",ACME(US0000000002) Split 2 for 1,100,0,0,0,',
    ])
    expect(b.warnings.join(' ')).toContain('Section "Corporate Actions" is not derived yet')
    // The sections we DO derive must never produce that warning.
    expect(basic().warnings.filter((w) => w.includes('is not derived yet'))).toEqual([])
  })
})

describe('idempotency', () => {
  it('gives the same ids for the same statement imported again', () => {
    const a = basic()
    const b = derive(BASIC_FILE, BASIC_ROWS)
    expect(b.transactions.map((t) => t.id)).toEqual(a.transactions.map((t) => t.id))
    expect(b.distributions.map((d) => d.id)).toEqual(a.distributions.map((d) => d.id))
    expect(b.accruals.map((x) => x.id)).toEqual(a.accruals.map((x) => x.id))
    expect(b.cashEvents.map((c) => c.id)).toEqual(a.cashEvents.map((c) => c.id))
    expect(b.positions.map((p) => p.id)).toEqual(a.positions.map((p) => p.id))
  })

  it('gives the same ids for rows shared with a narrower statement', async () => {
    // A one-month statement covering only the ACME activity. Overlapping
    // imports must not double-count it.
    const monthly = await mini(
      [
        FII_HEADER,
        FII_ACME,
        TRADES_HEADER,
        'Trades,Data,Order,Stocks,USD,ACME,"2025-02-01, 10:00:00",200.5,50,50.2,-10025,-4,10029,0,40.1,FPA;O;P',
        'Trades,Data,Order,Stocks,USD,ACME,"2025-09-15, 11:30:00",-100.25,60,59.8,6015,-4,-5014.5,996.5,-20.05,C;P',
        'Trades,Data,ClosedLot,Stocks,USD,ACME,"2025-02-01, 10:00:00",100.25,50,,5012.5,,5014.5,996.5,,',
      ],
      { periodStart: '2025-02-01', periodEnd: '2025-09-30' },
    )
    const annual = basic()
    const acmeIds = annual.transactions.filter((t) => t.instrumentKey === '222222222').map((t) => t.id)
    expect(monthly.transactions.map((t) => t.id)).toEqual(acmeIds)
  })

  it('does not let the file id, its name or its period leak into an id', () => {
    // Same rows, restamped as if they had arrived in a differently named file
    // covering a different window.
    const rows = BASIC_ROWS.map((r) => ({ ...r, fileId: 'other', id: `other:${r.lineNo}` }))
    const file: RawFile = { ...BASIC_FILE, id: 'other', name: 'renamed.csv', periodStart: '2024-01-01' }
    const b = derive(file, rows)
    expect(b.transactions.map((t) => t.id)).toEqual(basic().transactions.map((t) => t.id))
    expect(b.accruals.map((a) => a.id)).toEqual(basic().accruals.map((a) => a.id))
  })
})

describe('pseudo rows', () => {
  it('keeps the label rows that ARE the payload out of the skip list', () => {
    // `Ending Dividend Accruals in USD` is an aggregate in the accruals
    // section, but `Starting Value` in Change in NAV is data. Neither may be
    // derived as an event, and neither may crash the walk.
    const b = basic()
    expect(b.cashEvents.some((e) => e.description.includes('Ending'))).toBe(false)
    expect(b.warnings.filter((w) => w.startsWith('Unrecognised section'))).toEqual([])
  })

  it('warns about a section it has never seen instead of guessing', async () => {
    const b = await mini(['Widget Activity,Header,A,B', 'Widget Activity,Data,1,2'])
    expect(b.warnings.join(' ')).toContain('Unrecognised section "Widget Activity"')
  })
})
