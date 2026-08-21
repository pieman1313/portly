import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assignOrdinals,
  canon,
  canonCodes,
  keyString,
  makeId,
  naturalKey,
  sectionClass,
  sha256HexSync,
} from './dedupe'

const bind = (header: string, fields: string): Map<string, string> => {
  const h = header.split(',')
  const f = fields.split(',')
  const m = new Map<string, string>()
  h.forEach((name, i) => {
    if (name.trim() !== '') m.set(name.trim(), f[i] ?? '')
  })
  return m
}

const TRADES_HEADER =
  'DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code'
const ACCRUAL_HEADER =
  'Asset Category,Currency,Symbol,Date,Ex Date,Pay Date,Quantity,Tax,Fee,Gross Rate,Gross Amount,Net Amount,Code'

describe('sha256HexSync', () => {
  const cases = [
    '',
    'abc',
    'a'.repeat(55), // one byte short of needing a second block
    'a'.repeat(56), // forces a second block
    'a'.repeat(1000),
    'VDIVdNL00116835942025-12-10T05:19:04',
    'ACME CORP, CLASS "A" — ünïcøde',
  ]
  it.each(cases)('matches node:crypto for %j', (input) => {
    expect(sha256HexSync(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'))
  })
})

describe('sectionClass', () => {
  it('classifies every section family', () => {
    expect(sectionClass('Trades')).toBe('EVENT')
    expect(sectionClass('Change in Dividend Accruals')).toBe('EVENT')
    expect(sectionClass('Deposits & Withdrawals')).toBe('EVENT')
    expect(sectionClass('Open Positions')).toBe('SNAPSHOT')
    expect(sectionClass('Net Asset Value')).toBe('SNAPSHOT')
    expect(sectionClass('Cash Report')).toBe('SNAPSHOT')
    expect(sectionClass('Interest Accruals')).toBe('SNAPSHOT')
    expect(sectionClass('Change in NAV')).toBe('PERIOD_AGGREGATE')
    expect(sectionClass('Mark-to-Market Performance Summary')).toBe('PERIOD_AGGREGATE')
    expect(sectionClass('Realized & Unrealized Performance Summary')).toBe('PERIOD_AGGREGATE')
    expect(sectionClass('Total P/L for Statement Period')).toBe('PERIOD_AGGREGATE')
    expect(sectionClass('Financial Instrument Information')).toBe('REFERENCE')
    expect(sectionClass('Codes')).toBe('REFERENCE')
    expect(sectionClass('Notes/Legal Notes')).toBe('IGNORE')
    expect(sectionClass('Statement')).toBe('IGNORE')
    expect(sectionClass('Account Information')).toBe('IGNORE')
  })

  it('defaults unknown sections to IGNORE rather than guessing a key', () => {
    expect(sectionClass('Some Section IBKR Ships Next Year')).toBe('IGNORE')
    expect(naturalKey('Some Section IBKR Ships Next Year', bind('A,B', '1,2'))).toBeNull()
  })
})

describe('canon', () => {
  it('treats every IBKR flavour of blank as nothing', () => {
    for (const v of ['', ' ', '--', '-', '   ']) expect(canon(v)).toBe('')
  })

  it('strips thousands separators so a quoted number keys like a plain one', () => {
    expect(canon('"3,334.3400"'.replace(/"/g, ''))).toBe('3334.34')
    expect(canon('1,234.5600')).toBe(canon('1234.56'))
    expect(canon('-102,774.80')).toBe('-102774.8')
    expect(canon('1,000')).toBe('1000')
  })

  it('normalises numeric scale', () => {
    expect(canon('50')).toBe(canon('50.000'))
    expect(canon('0')).toBe('0')
    expect(canon('-0.00')).toBe('0')
    expect(canon('144.6797')).toBe('144.6797')
  })

  it('normalises IBKR datetimes to ISO', () => {
    expect(canon('2025-07-14, 07:37:45')).toBe('2025-07-14T07:37:45')
    expect(canon('2025-07-14')).toBe('2025-07-14')
  })

  it('leaves descriptions alone apart from whitespace', () => {
    expect(canon('  ACME CORP,  CLASS "A" ')).toBe('ACME CORP, CLASS "A"')
  })
})

describe('canonCodes', () => {
  it('treats the Code column as an unordered set', () => {
    expect(canonCodes('O;P;FPA')).toBe(canonCodes('FPA; P ;O'))
    expect(canonCodes('')).toBe('')
  })
})

describe('naturalKey — Trades', () => {
  it('is stable across quoting, scale and thousands separators', () => {
    const a = bind(TRADES_HEADER, 'Order,Stocks,USD,GLOB,2025-06-01 09:00:00,80,1234.56,1240,-98764.8,-8,98772.8,0,435.2,O')
    // The same fill as IBKR quotes it: "1,234.5600" and a padded quantity.
    const b = new Map(a)
    b.set('T. Price', '1,234.5600')
    b.set('Quantity', '80.0000')
    b.set('Date/Time', '2025-06-01, 09:00:00')
    expect(naturalKey('Trades', a)).toEqual(naturalKey('Trades', b))
  })

  it('excludes commission, basis and realized P/L — IBKR restates them', () => {
    const a = bind(TRADES_HEADER, 'Order,Stocks,USD,ACME,2025-02-01 10:00:00,200.5,50,50.2,-10025,-4,10029,0,40.1,O')
    const b = bind(TRADES_HEADER, 'Order,Stocks,USD,ACME,2025-02-01 10:00:00,200.5,50,50.2,-10025,-6,10031,12,41,O;P')
    expect(naturalKey('Trades', a)).toEqual(naturalKey('Trades', b))
  })

  it('collapses the custody suffix onto the plain asset category', () => {
    const plain = bind(TRADES_HEADER, 'Order,Stocks,USD,ACME,2025-02-01 10:00:00,1,50,,-50,,50,0,0,O')
    const held = bind(
      TRADES_HEADER,
      'Order,Stocks - Held with Interactive Brokers (U.K.) Limited carried by Interactive Brokers LLC,USD,ACME,2025-02-01 10:00:00,1,50,,-50,,50,0,0,O',
    )
    expect(naturalKey('Trades', plain)).toEqual(naturalKey('Trades', held))
  })

  it('keys renamed tickers identically once the symbol resolves to a conid', () => {
    const old = bind(TRADES_HEADER, 'Order,Stocks,EUR,TDIV,2025-07-14 07:37:45,93,36.5,,-3394.5,-3,3397.5,0,1,O')
    const renamed = bind(TRADES_HEADER, 'Order,Stocks,EUR,VDIVd,2025-07-14 07:37:45,93,36.5,,-3394.5,-3,3397.5,0,1,O')
    const resolve = (s: string) => (s === 'TDIV' || s === 'VDIVd' ? '234004667' : s)
    expect(naturalKey('Trades', old, resolve)).toEqual(naturalKey('Trades', renamed, resolve))
    // …and differently without the resolver, which is exactly the bug the
    // resolver exists to prevent.
    expect(naturalKey('Trades', old)).not.toEqual(naturalKey('Trades', renamed))
  })

  it('separates the Order grain from the ClosedLot grain', () => {
    const order = bind(TRADES_HEADER, 'Order,Stocks,USD,ACME,2025-02-01 10:00:00,100.25,50,,5012.5,,5014.5,996.5,,C')
    const lot = bind(TRADES_HEADER, 'ClosedLot,Stocks,USD,ACME,2025-02-01 10:00:00,100.25,50,,5012.5,,5014.5,996.5,,')
    expect(naturalKey('Trades', order)).not.toEqual(naturalKey('Trades', lot))
  })
})

describe('naturalKey — Change in Dividend Accruals', () => {
  // The real statement carries two Po rows for one ex-date that differ ONLY in
  // tax (4.42 vs 5.02). A key without tax collapses them and breaks the
  // accrual balance by 0.60.
  const po1 = bind(ACCRUAL_HEADER, 'Stocks,EUR,TDIV,2025-09-02,2025-09-02,2025-09-10,93,4.42,0,0.36,33.47,29.05,Po')
  const po2 = bind(ACCRUAL_HEADER, 'Stocks,EUR,TDIV,2025-09-02,2025-09-02,2025-09-10,93,5.02,0,0.36,33.48,28.46,Po')
  const re2 = bind(ACCRUAL_HEADER, 'Stocks,EUR,TDIV,2025-09-10,2025-09-02,2025-09-10,93,-5.02,0,0.36,-33.48,-28.46,Re')

  it('keeps two Po rows that differ only in tax apart', () => {
    expect(naturalKey('Change in Dividend Accruals', po1)).not.toEqual(
      naturalKey('Change in Dividend Accruals', po2),
    )
  })

  it('keeps a posting apart from its reversal', () => {
    expect(naturalKey('Change in Dividend Accruals', po2)).not.toEqual(
      naturalKey('Change in Dividend Accruals', re2),
    )
  })

  it('carries tax, gross amount and the code', () => {
    const key = naturalKey('Change in Dividend Accruals', po1) ?? []
    expect(key).toContain('4.42')
    expect(key).toContain('33.47')
    expect(key).toContain('Po')
  })
})

describe('naturalKey — cash sections', () => {
  it('keeps the description, which carries the ISIN and the per-share rate', () => {
    const h = 'Currency,Date,Description,Amount'
    const a = bind(h, 'USD,2025-09-08,JEPI(IE000U5MJOZ6) Cash Dividend USD 0.2282 per Share (Mixed Income),184.61')
    const b = bind(h, 'USD,2025-09-08,JEPQ(IE000U5MJOZ7) Cash Dividend USD 0.4400 per Share (Mixed Income),184.61')
    expect(naturalKey('Dividends', a)).not.toEqual(naturalKey('Dividends', b))
  })

  it('never omits the amount — a fee and its same-day reversal must stay apart', () => {
    const h = 'Subtitle,Currency,Date,Description,Amount'
    const fee = bind(h, 'Other Fees,EUR,2024-05-02,J*77:GLOBAL SNAPSHOT FOR APR 2024,-0.03')
    const rev = bind(h, 'Other Fees,EUR,2024-05-02,J*77:GLOBAL SNAPSHOT FOR APR 2024,0.03')
    expect(naturalKey('Fees', fee)).not.toEqual(naturalKey('Fees', rev))
  })

  it('separates sections that share a column shape', () => {
    const h = 'Currency,Date,Description,Amount'
    const row = bind(h, 'USD,2025-08-05,USD Credit Interest for Jul-2025,12.34')
    expect(naturalKey('Interest', row)).not.toEqual(naturalKey('Broker Interest Received', row))
  })
})

describe('assignOrdinals', () => {
  it('counts occurrences within a key group, in file order', () => {
    const items = ['a', 'b', 'a', 'c', 'a', 'b']
    expect(assignOrdinals(items, (s) => s)).toEqual([0, 0, 1, 0, 2, 1])
  })

  it('restarts per calendar date, because the natural key carries the date', () => {
    const h = 'Currency,Date,Description,Amount'
    const rows = [
      bind(h, 'USD,2025-01-15,Electronic Fund Transfer,1000'),
      bind(h, 'USD,2025-01-15,Electronic Fund Transfer,1000'),
      bind(h, 'USD,2025-02-15,Electronic Fund Transfer,1000'),
    ]
    const ords = assignOrdinals(rows, (r) => keyString(naturalKey('Deposits & Withdrawals', r) ?? []))
    expect(ords).toEqual([0, 1, 0])
  })
})

describe('makeId', () => {
  it('is deterministic and 20 hex chars', () => {
    const parts = ['div', 'Dividends', 'EUR', '2025-06-20', 'OLDT(NL0) Cash Dividend', '50']
    expect(makeId(parts, 0)).toBe(makeId([...parts], 0))
    expect(makeId(parts, 0)).toMatch(/^[0-9a-f]{20}$/)
  })

  it('separates two genuinely identical same-day rows by ordinal', () => {
    const parts = ['div', 'Dividends', 'USD', '2025-06-20', 'ACME special', '10']
    expect(makeId(parts, 0)).not.toBe(makeId(parts, 1))
  })

  it('cannot be fooled by shifting a character across the part boundary', () => {
    expect(makeId(['ab', 'c'], 0)).not.toBe(makeId(['a', 'bc'], 0))
  })
})
