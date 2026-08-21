import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import type { RawRow } from '../domain/types'
import { PARSER_VERSION } from '../domain/types'
import { bindRow, parsePeriod, parseStatement, sha256Hex } from './statement'

const FIXTURE = readFileSync(new URL('../test/fixtures/activity-basic.csv', import.meta.url)).toString('utf8')

const atLine = (rows: RawRow[], lineNo: number): RawRow => {
  const row = rows.find((r) => r.lineNo === lineNo)
  if (!row) throw new Error(`no row at line ${lineNo}`)
  return row
}

/** A minimal well-formed statement with an overridable Period value. */
const withPeriod = (period: string): string =>
  ['﻿Statement,Header,Field Name,Field Value', `Statement,Data,Period,"${period}"`, ''].join('\n')

describe('sha256Hex', () => {
  it('matches the known SHA-256 vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('hashes the empty string', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('parsePeriod', () => {
  it('parses a full range', () => {
    expect(parsePeriod('December 11, 2024 - December 11, 2025')).toEqual({
      start: '2024-12-11',
      end: '2025-12-11',
    })
  })

  it('parses a single day into an equal start and end', () => {
    expect(parsePeriod('January 1, 2025')).toEqual({ start: '2025-01-01', end: '2025-01-01' })
  })

  it('widens a bare year to the whole calendar year', () => {
    expect(parsePeriod('2025')).toEqual({ start: '2025-01-01', end: '2025-12-31' })
  })

  it('widens a bare month to the whole month, leap year included', () => {
    expect(parsePeriod('February 2024')).toEqual({ start: '2024-02-01', end: '2024-02-29' })
    expect(parsePeriod('February 2025')).toEqual({ start: '2025-02-01', end: '2025-02-28' })
  })

  it('handles abbreviations, en dashes and ISO endpoints', () => {
    expect(parsePeriod('Dec 11, 2024 – Jan 3, 2025')).toEqual({ start: '2024-12-11', end: '2025-01-03' })
    expect(parsePeriod('2025-01-01 - 2025-12-31')).toEqual({ start: '2025-01-01', end: '2025-12-31' })
    expect(parsePeriod('11-Dec-24 - 11-Dec-25')).toEqual({ start: '2024-12-11', end: '2025-12-11' })
  })

  it('does not shift the day for a timezone west of UTC', () => {
    // new Date('December 11, 2024') is midnight LOCAL; toISOString() in UTC-5
    // reports the 11th, but in UTC+2 it reports the 10th. Explicit parsing must
    // return the 11th regardless of where the browser is.
    expect(parsePeriod('December 11, 2024')!.start).toBe('2024-12-11')
    expect(parsePeriod('January 1, 2025')!.start).toBe('2025-01-01')
  })

  it('refuses a "month name" that only exists on Object.prototype', () => {
    // A month table held in an object literal answers MONTHS['constructor'] with
    // a function. It is !== undefined, every numeric range check against it is
    // false, and it reaches iso() as the literal source text of Object:
    // '2024-function Object() { [native code] }-05'.
    for (const w of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(parsePeriod(`${w} 5, 2024`)).toBeNull()
      expect(parsePeriod(`${w} 2024`)).toBeNull()
      expect(parsePeriod(`5-${w}-24`)).toBeNull()
    }
  })

  it('only ever returns well-formed ISO dates', () => {
    for (const v of ['December 11, 2024 - December 11, 2025', '2025', 'February 2024', '11-Dec-24']) {
      const p = parsePeriod(v)!
      expect(p.start).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(p.end).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('refuses ambiguous and impossible dates rather than guessing', () => {
    expect(parsePeriod('01/02/2025')).toBeNull()
    expect(parsePeriod('Februany 3, 2025')).toBeNull()
    expect(parsePeriod('February 30, 2025')).toBeNull()
    expect(parsePeriod('')).toBeNull()
    expect(parsePeriod('Year to date')).toBeNull()
  })
})

describe('parseStatement — period shapes end to end', () => {
  it('reads a range', async () => {
    const { file } = await parseStatement(withPeriod('December 11, 2024 - December 11, 2025'), 'a.csv')
    expect([file.periodStart, file.periodEnd]).toEqual(['2024-12-11', '2025-12-11'])
  })

  it('reads a single day', async () => {
    const { file } = await parseStatement(withPeriod('January 1, 2025'), 'a.csv')
    expect([file.periodStart, file.periodEnd]).toEqual(['2025-01-01', '2025-01-01'])
  })

  it('reads a bare year', async () => {
    const { file } = await parseStatement(withPeriod('2025'), 'a.csv')
    expect([file.periodStart, file.periodEnd]).toEqual(['2025-01-01', '2025-12-31'])
  })

  it('leaves the period null and warns for a prototype-shaped month name', async () => {
    const { file, warnings } = await parseStatement(withPeriod('constructor 5, 2024'), 'a.csv')
    expect(file.periodStart).toBeNull()
    expect(file.periodEnd).toBeNull()
    expect(warnings.join('\n')).toMatch(/unrecognised Period/)
  })

  it('warns and leaves the period null when it cannot be understood', async () => {
    const { file, warnings } = await parseStatement(withPeriod('sometime last spring'), 'a.csv')
    expect(file.periodStart).toBeNull()
    expect(file.periodEnd).toBeNull()
    expect(warnings.join('\n')).toMatch(/Period/)
  })
})

describe('parseStatement — hashing', () => {
  const base = [
    'Statement,Header,Field Name,Field Value',
    'Statement,Data,Period,"January 1, 2025"',
    'Statement,Data,WhenGenerated,"2026-01-05, 09:00:00 EDT"',
    'Dividends,Header,Currency,Date,Description,Amount',
    'Dividends,Data,USD,2025-04-10,ACME Cash Dividend,60.15',
    '',
  ].join('\n')
  const regenerated = base.replace('2026-01-05, 09:00:00 EDT', '2026-03-02, 17:41:12 EDT')

  it('separates a regenerated statement from a new one: raw differs, canonical does not', async () => {
    const a = await parseStatement(base, 'a.csv')
    const b = await parseStatement(regenerated, 'b.csv')
    expect(a.file.sha256Raw).not.toBe(b.file.sha256Raw)
    expect(a.file.sha256Canonical).toBe(b.file.sha256Canonical)
  })

  it('still differs canonically when any other line changes', async () => {
    const a = await parseStatement(base, 'a.csv')
    const c = await parseStatement(base.replace('60.15', '60.16'), 'c.csv')
    expect(a.file.sha256Canonical).not.toBe(c.file.sha256Canonical)
  })

  it('ignores the BOM and the line-ending style when canonicalising', async () => {
    const a = await parseStatement(base, 'a.csv')
    const b = await parseStatement('﻿' + base.replace(/\n/g, '\r\n'), 'b.csv')
    expect(a.file.sha256Raw).not.toBe(b.file.sha256Raw)
    expect(a.file.sha256Canonical).toBe(b.file.sha256Canonical)
  })

  it('uses sha256Raw as the file id', async () => {
    const { file } = await parseStatement(base, 'a.csv')
    expect(file.id).toBe(file.sha256Raw)
    expect(file.sha256Raw).toBe(await sha256Hex(base))
  })
})

describe('parseStatement — resilience', () => {
  it('never throws on malformed rows and reports them as warnings', async () => {
    const text = [
      'Statement,Header,Field Name,Field Value',
      'Statement,Data,Period,2025',
      'garbage line with no row type',
      'Trades,Wat,Stocks,USD,ACME,1',
      'Dividends,Data,USD,2025-04-10,orphan before any header,1',
      'Trades,Data,Order,Stocks,USD,"unterminated',
    ].join('\n')
    const { rows, warnings } = await parseStatement(text, 'bad.csv')
    expect(rows).toHaveLength(6)
    expect(warnings.some((w) => /no row-type column/.test(w))).toBe(true)
    expect(warnings.some((w) => /unrecognised row type "Wat"/.test(w))).toBe(true)
    expect(warnings.some((w) => /before any Header row/.test(w))).toBe(true)
    // Unrecognised row types collapse to '' so downstream filters ignore them.
    expect(atLine(rows, 4).rowType).toBe('')
    expect(atLine(rows, 3).rowType).toBe('')
  })

  it('warns once per class, not once per line', async () => {
    const text = [
      'Dividends,Data,USD,2025-01-01,a,1',
      'Dividends,Data,USD,2025-01-02,b,2',
      'Dividends,Data,USD,2025-01-03,c,3',
    ].join('\n')
    const { warnings } = await parseStatement(text, 'bad.csv')
    expect(warnings.filter((w) => /before any Header row/.test(w))).toHaveLength(1)
  })

  it('does not warn about the header-less "Total P/L for Statement Period" pseudo-section', async () => {
    const { rows, warnings } = await parseStatement('Total P/L for Statement Period,,,,,,8835.87,\n', 'a.csv')
    expect(atLine(rows, 1).rowType).toBe('')
    expect(warnings).toEqual([])
  })

  it('parses an empty file into an empty statement', async () => {
    const { file, rows, warnings } = await parseStatement('', 'empty.csv')
    expect(rows).toEqual([])
    expect(warnings).toEqual([])
    expect(file.rowCount).toBe(0)
    expect(file.sections).toEqual([])
    expect(file.broker).toBeNull()
  })
})

describe('parseStatement — the real fixture', () => {
  let rows: RawRow[]
  let file: Awaited<ReturnType<typeof parseStatement>>['file']
  let warnings: string[]

  beforeAll(async () => {
    const parsed = await parseStatement(FIXTURE, 'activity-basic.csv')
    rows = parsed.rows
    file = parsed.file
    warnings = parsed.warnings
  })

  it('strips the BOM so the Statement section is addressable', () => {
    expect(file.sections[0]).toBe('Statement')
    expect(file.sections.some((s) => s.startsWith('﻿'))).toBe(false)
    expect(rows.every((r) => !r.section.startsWith('﻿'))).toBe(true)
  })

  it('imports cleanly — no warnings on a well-formed statement', () => {
    expect(warnings).toEqual([])
  })

  it('extracts the statement identity', () => {
    expect(file.name).toBe('activity-basic.csv')
    expect(file.broker).toBe('Interactive Brokers Ireland Limited')
    expect(file.title).toBe('Activity Statement')
    expect(file.account).toBe('U00000001')
    expect(file.baseCurrency).toBe('USD')
    expect(file.whenGenerated).toBe('2026-01-05, 09:00:00 EDT')
    expect(file.periodStart).toBe('2025-01-01')
    expect(file.periodEnd).toBe('2025-12-31')
    expect(file.parserVersion).toBe(PARSER_VERSION)
    expect(file.bytes).toBe(new TextEncoder().encode(FIXTURE).length)
  })

  it('lists distinct sections in file order', () => {
    expect(file.sections).toEqual([
      'Statement',
      'Account Information',
      'Net Asset Value',
      'Change in NAV',
      'Open Positions',
      'Trades',
      'Deposits & Withdrawals',
      'Dividends',
      'Withholding Tax',
      'Interest',
      'Change in Dividend Accruals',
      'Financial Instrument Information',
      'Codes',
      'Notes/Legal Notes',
    ])
    expect(new Set(file.sections).size).toBe(file.sections.length)
  })

  it('keeps one RawRow per physical line, ids included', () => {
    expect(file.rowCount).toBe(rows.length)
    expect(rows).toHaveLength(85)
    expect(rows.map((r) => r.lineNo)).toEqual(rows.map((_, i) => i + 1))
    expect(rows.every((r) => r.id === `${file.id}:${r.lineNo}`)).toBe(true)
    expect(rows.every((r) => r.fileId === file.id)).toBe(true)
    expect(atLine(rows, 1).rowType).toBe('Header')
  })

  it('stores Header rows as rows in their own right', () => {
    const headers = rows.filter((r) => r.rowType === 'Header')
    expect(headers.map((r) => r.lineNo)).toEqual([1, 7, 12, 16, 23, 31, 42, 46, 50, 58, 62, 65, 75, 79, 84])
    // Two of them are Trades, which is the whole point of per-row snapshots.
    expect(headers.filter((r) => r.section === 'Trades')).toHaveLength(2)
  })

  it('keeps every consecutive Open Positions Total as its own row', () => {
    const totals = rows.filter((r) => r.section === 'Open Positions' && r.rowType === 'Total')
    expect(totals.map((r) => r.lineNo)).toEqual([25, 26, 29, 30])
  })

  it('preserves ClosedLot and negative-quantity sell rows verbatim', () => {
    expect(atLine(rows, 36).fields[7]).toBe('-100.25')
    expect(bindRow(atLine(rows, 37)).get('DataDiscriminator')).toBe('ClosedLot')
    expect(bindRow(atLine(rows, 37)).get('Quantity')).toBe('100.25')
  })

  describe('header rebinding', () => {
    it('binds a Stocks trade against the FIRST Trades header', () => {
      const stock = atLine(rows, 35) // Trades,Data,Order,Stocks,USD,ACME,...
      // header[] is offset by 2 from the physical column: [7] is full column 9.
      expect(stock.header[7]).toBe('C. Price')
      const bound = bindRow(stock)
      expect(bound.get('Comm/Fee')).toBe('-4')
      expect(bound.get('Symbol')).toBe('ACME')
      expect(bound.get('MTM P/L')).toBe('40.1')
      expect(bound.has('Comm in USD')).toBe(false)
    })

    it('binds a Forex trade against the SECOND Trades header', () => {
      const forex = atLine(rows, 43) // Trades,Data,Order,Forex,USD,EUR.USD,...
      const bound = bindRow(forex)
      expect(bound.get('Comm in USD')).toBe('-2')
      expect(bound.get('MTM in USD')).toBe('1.25')
      expect(bound.get('Symbol')).toBe('EUR.USD')
      // The Stocks names must NOT leak across the rebind — that is the bug this
      // whole design exists to prevent.
      expect(bound.has('Comm/Fee')).toBe(false)
      expect(bound.has('Basis')).toBe(false)
      expect(bound.has('Realized P/L')).toBe(false)
    })

    it('keys the Forex header cells that have no name by full-row column index', () => {
      const bound = bindRow(atLine(rows, 43))
      expect(bound.get('__col9')).toBe('') // where Stocks has C. Price
      expect(bound.get('__col12')).toBe('') // Basis
      expect(bound.get('__col13')).toBe('') // Realized P/L
    })

    it('snapshots the header at the time of the row, not the last one in the file', () => {
      const before = atLine(rows, 32) // first Stocks trade, line 32
      const after = atLine(rows, 43) // Forex trade, after the rebind on line 42
      expect(before.header[9]).toBe('Comm/Fee')
      expect(after.header[9]).toBe('Comm in USD')
    })

    it('rebinding is per section — Dividends keeps its own header throughout', () => {
      expect(bindRow(atLine(rows, 51)).get('Amount')).toBe('50')
      expect(bindRow(atLine(rows, 54)).get('Amount')).toBe('60.15')
    })
  })

  describe('bindRow', () => {
    it('offsets by two so Section and RowType are not columns', () => {
      const bound = bindRow(atLine(rows, 24))
      expect(bound.has('Open Positions')).toBe(false)
      expect(bound.has('Data')).toBe(false)
      expect(bound.get('DataDiscriminator')).toBe('Summary')
      expect(bound.get('Code')).toBe('')
    })

    it('carries quoted commas and escaped quotes through untouched', () => {
      expect(bindRow(atLine(rows, 76)).get('Symbol')).toBe('NEWT, OLDT')
      expect(bindRow(atLine(rows, 77)).get('Description')).toBe('ACME CORP, CLASS "A"')
      expect(bindRow(atLine(rows, 76)).get('Conid')).toBe('111111111')
      expect(bindRow(atLine(rows, 76)).get('Security ID')).toBe('NL0000000001')
    })

    it('does not strip thousands separators — that is the number layer\'s job', () => {
      expect(bindRow(atLine(rows, 28)).get('Cost Price')).toBe('1,234.5600')
    })

    it('tolerates a row with fewer fields than its header', () => {
      const codes = bindRow(atLine(rows, 80)) // Codes,Data,O,Opening Trade — 4 of 6
      expect(codes.get('Code')).toBe('O')
      expect(codes.get('Meaning')).toBe('Opening Trade')
      expect(codes.get('Code (Cont.)')).toBe('')
      expect(codes.get('Meaning (Cont.)')).toBe('')
    })

    it('keeps a trailing field that overflows the header', () => {
      const total = atLine(rows, 41) // Trades,Total,... with a trailing " "
      expect(total.fields.length).toBe(total.header.length + 2)
      const wide: RawRow = { ...total, fields: [...total.fields, 'extra'] }
      expect(bindRow(wide).get('__col16')).toBe('extra')
    })

    it('suffixes duplicate header names instead of clobbering the first', () => {
      const row: RawRow = {
        id: 'x:1',
        fileId: 'x',
        lineNo: 1,
        section: 'Trade Summary by Symbol',
        rowType: 'Data',
        header: ['Symbol', 'Quantity', 'Proceeds', 'Quantity', 'Proceeds', 'Quantity'],
        fields: ['Trade Summary by Symbol', 'Data', 'ACME', '10', '100', '-4', '-40', '6'],
      }
      const bound = bindRow(row)
      expect(bound.get('Quantity')).toBe('10')
      expect(bound.get('Quantity (2)')).toBe('-4')
      expect(bound.get('Quantity (3)')).toBe('6')
      expect(bound.get('Proceeds')).toBe('100')
      expect(bound.get('Proceeds (2)')).toBe('-40')
      expect(bound.size).toBe(6)
    })

    it('returns an empty map for a row with no bound header', () => {
      const row: RawRow = {
        id: 'x:1', fileId: 'x', lineNo: 1, section: 'Total P/L for Statement Period',
        rowType: '', header: [], fields: ['Total P/L for Statement Period', '', '8835.87'],
      }
      expect(bindRow(row).get('__col2')).toBe('8835.87')
    })
  })
})
