/**
 * RFC-4180 CSV reader, hand-rolled.
 *
 * Papa Parse is a dependency and would handle the quoting fine, but it exposes
 * only a byte cursor per row — and a quoted field may legally span physical
 * lines, so the row → line mapping is not recoverable after the fact. Every row
 * here must carry the 1-based physical line it STARTED on: `RawRow.id` is
 * `${fileId}:${lineNo}` and the import audit trail shows the user that line.
 *
 * Deliberately does NOT: trim, coerce, pad to a header width, or truncate.
 * IBKR sections are ragged by design (Codes emits 4 fields under a 5-column
 * header; Total rows emit one extra trailing `" "`), and a trailing single
 * space is a distinct token from an empty field — see ibkr-format.md §3.9.
 */

export interface CsvRow {
  /** 1-based physical line the row starts on. A quoted field may span lines. */
  lineNo: number
  /** Fields after CSV unquoting only. Verbatim otherwise. */
  fields: string[]
}

export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = []
  const len = text.length

  // The UTF-8 BOM sits at byte 0 of every real IBKR export. Left in place, the
  // first section name is "﻿Statement" and every Statement handler misses.
  // (Blob.text() strips it, FileReader may not, a fetch of a fixture will not.)
  let i = len > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0

  let line = 1
  let rowLine = 1
  let fields: string[] = []
  let field = ''
  let open = false
  // Distinguishes a bare blank line (not a row) from a line holding `""`
  // (one row, one empty field).
  let quoted = false

  const endRow = (): void => {
    if (fields.length > 0 || field !== '' || quoted) {
      fields.push(field)
      rows.push({ lineNo: rowLine, fields })
    }
    fields = []
    field = ''
    open = false
    quoted = false
  }

  while (i < len) {
    if (!open) {
      rowLine = line
      open = true
    }
    const c = text[i]!

    if (c === '"') {
      quoted = true
      i++
      for (;;) {
        if (i >= len) break // unterminated quote at EOF: keep what we read
        const q = text[i]!
        if (q === '"') {
          // "" inside a quoted run is one literal quote: ACME CORP, CLASS ""A""
          if (text[i + 1] === '"') {
            field += '"'
            i += 2
            continue
          }
          i++
          break
        }
        // A line break inside quotes still advances the file. All three forms
        // count, and CRLF counts once — outside quotes a bare CR is treated as a
        // terminator below, so if it did not count here every subsequent lineNo
        // (and therefore every RawRow.id) would be short by one.
        if (q === '\r') {
          line++
          if (text[i + 1] === '\n') {
            field += '\r\n'
            i += 2
            continue
          }
          field += '\r'
          i++
          continue
        }
        if (q === '\n') line++
        field += q
        i++
      }
      continue
    }

    if (c === ',') {
      fields.push(field)
      field = ''
      i++
      continue
    }

    if (c === '\r') {
      i++
      if (text[i] === '\n') i++ // CRLF is one terminator
      endRow()
      line++
      continue
    }

    if (c === '\n') {
      i++
      endRow()
      line++
      continue
    }

    // Plain run — copied in one slice rather than char by char.
    let j = i
    while (j < len) {
      const d = text[j]!
      if (d === ',' || d === '"' || d === '\r' || d === '\n') break
      j++
    }
    field += text.slice(i, j)
    i = j
  }

  // A trailing newline must not manufacture a phantom row; unterminated content
  // at EOF must not be dropped.
  if (open) endRow()

  return rows
}
