import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv'

const FIXTURE = readFileSync(new URL('../test/fixtures/activity-basic.csv', import.meta.url)).toString('utf8')

describe('parseCsv', () => {
  it('strips the UTF-8 BOM at byte 0', () => {
    const rows = parseCsv('﻿Statement,Header,Field Name,Field Value')
    expect(rows[0]!.fields[0]).toBe('Statement')
    expect(rows[0]!.fields[0]!.charCodeAt(0)).toBe('S'.charCodeAt(0))
  })

  it('only strips a BOM at byte 0, not a stray one mid-file', () => {
    const rows = parseCsv('a,b\n﻿c,d')
    expect(rows[1]!.fields[0]).toBe('﻿c')
  })

  it('keeps commas inside quoted fields', () => {
    const rows = parseCsv('Statement,Data,Period,"January 1, 2025 - December 31, 2025"')
    expect(rows[0]!.fields).toEqual(['Statement', 'Data', 'Period', 'January 1, 2025 - December 31, 2025'])
  })

  it('unescapes doubled quotes', () => {
    const rows = parseCsv('a,"ACME CORP, CLASS ""A""",b')
    expect(rows[0]!.fields).toEqual(['a', 'ACME CORP, CLASS "A"', 'b'])
  })

  it('handles a quoted field that is nothing but escaped quotes', () => {
    const rows = parseCsv('a,"""",b')
    expect(rows[0]!.fields).toEqual(['a', '"', 'b'])
  })

  it('handles CRLF, LF and a mix of both', () => {
    const rows = parseCsv('a,1\r\nb,2\nc,3\r\n')
    expect(rows.map((r) => r.fields)).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ])
    expect(rows.map((r) => r.lineNo)).toEqual([1, 2, 3])
  })

  it('does not emit a phantom row for a trailing newline', () => {
    expect(parseCsv('a,1\n')).toHaveLength(1)
    expect(parseCsv('a,1\r\n')).toHaveLength(1)
    expect(parseCsv('a,1')).toHaveLength(1)
    expect(parseCsv('')).toHaveLength(0)
    expect(parseCsv('﻿')).toHaveLength(0)
  })

  it('skips blank lines but keeps a line holding one quoted empty field', () => {
    const rows = parseCsv('a,1\n\nb,2\n""\n')
    expect(rows.map((r) => [r.lineNo, r.fields])).toEqual([
      [1, ['a', '1']],
      [3, ['b', '2']],
      [4, ['']],
    ])
  })

  it('keeps ragged rows ragged — no padding, no truncation', () => {
    const rows = parseCsv('Codes,Header,Code,Meaning,Code (Cont.),Meaning (Cont.)\nCodes,Data,A,Assignment\n')
    expect(rows[0]!.fields).toHaveLength(6)
    expect(rows[1]!.fields).toHaveLength(4)
  })

  it('does not trim: a trailing " " field is distinct from an empty one', () => {
    const rows = parseCsv('Trades,Total,,455.25, \nTrades,Total,,455.25,\n')
    expect(rows[0]!.fields[4]).toBe(' ')
    expect(rows[1]!.fields[4]).toBe('')
  })

  it('counts physical lines across a newline embedded in a quoted field', () => {
    const rows = parseCsv('a,1\nb,"two\nlines"\nc,3\n')
    expect(rows.map((r) => r.lineNo)).toEqual([1, 2, 4])
    expect(rows[1]!.fields[1]).toBe('two\nlines')
  })

  it('keeps a CRLF embedded in a quoted field verbatim while advancing the line count', () => {
    const rows = parseCsv('a,"x\r\ny"\r\nb,2\r\n')
    expect(rows[0]!.fields[1]).toBe('x\r\ny')
    expect(rows[1]!.lineNo).toBe(3)
  })

  it('counts a bare CR inside a quoted field as a line break, exactly as it does outside one', () => {
    // A lone CR terminates a row outside quotes (see the classic-Mac case below),
    // so it must advance `line` inside quotes too. It used to not, which silently
    // shifted every later lineNo — and every RawRow.id — down by one.
    const rows = parseCsv('a,"x\ry"\nb,2\nc,3\n')
    expect(rows[0]!.fields[1]).toBe('x\ry')
    expect(rows.map((r) => r.lineNo)).toEqual([1, 3, 4])
  })

  it('counts a CR-only file the same way, quoted or not', () => {
    expect(parseCsv('a,1\rb,2\rc,3\r').map((r) => r.lineNo)).toEqual([1, 2, 3])
    // Two embedded CRs push the next row down two lines, not zero.
    expect(parseCsv('a,"x\ry\rz"\rb,2').map((r) => r.lineNo)).toEqual([1, 4])
  })

  it('recovers from an unterminated quote at EOF instead of dropping the row', () => {
    const rows = parseCsv('a,1\nb,"never closed')
    expect(rows).toHaveLength(2)
    expect(rows[1]!.fields).toEqual(['b', 'never closed'])
  })

  it('treats a quote after unquoted content leniently rather than corrupting the row', () => {
    const rows = parseCsv('a,b"c",d\n')
    expect(rows[0]!.fields).toEqual(['a', 'bc', 'd'])
  })

  it('emits an empty field for every empty column', () => {
    const rows = parseCsv(',,\n')
    expect(rows[0]!.fields).toEqual(['', '', ''])
  })

  describe('against the real fixture', () => {
    const rows = parseCsv(FIXTURE)

    it('maps every row onto its own 1-based physical line', () => {
      const lines = FIXTURE.replace(/^﻿/, '').split('\n')
      for (const row of rows) {
        expect(lines[row.lineNo - 1]!.startsWith(row.fields[0]!)).toBe(true)
      }
      expect(rows.map((r) => r.lineNo)).toEqual(rows.map((_, i) => i + 1))
    })

    it('puts the second Trades header on line 42 with its empty column names intact', () => {
      const header = rows.find((r) => r.lineNo === 42)!
      expect(header.fields.slice(0, 2)).toEqual(['Trades', 'Header'])
      expect(header.fields[9]).toBe('')
      expect(header.fields[11]).toBe('Comm in USD')
      expect(header.fields[12]).toBe('')
      expect(header.fields[13]).toBe('')
    })

    it('reads the quoted alias list and the escaped-quote description', () => {
      const newt = rows.find((r) => r.lineNo === 76)!
      expect(newt.fields[3]).toBe('NEWT, OLDT')
      const acme = rows.find((r) => r.lineNo === 77)!
      expect(acme.fields[4]).toBe('ACME CORP, CLASS "A"')
    })

    it('reads thousands separators as part of the quoted field, unmodified', () => {
      const glob = rows.find((r) => r.lineNo === 28)!
      expect(glob.fields[8]).toBe('1,234.5600')
    })
  })
})
