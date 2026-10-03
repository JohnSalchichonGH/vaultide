/**
 * Tab-separated text, as a spreadsheet puts it on the clipboard (blueprint
 * 15.3 "paste from a spreadsheet (TSV …)"; ADR 0011 D4).
 *
 * A tab separates fields and a line break separates rows — CRLF or LF — and a
 * final line break adds no row. A field that starts with `"` is quoted, the way
 * Excel and Google Sheets quote one: it runs to its closing quote, `""` inside
 * it is a literal quote, and a tab or line break inside it belongs to the field.
 * A quote that never closes refuses the whole paste rather than swallowing the
 * rest of it as one field.
 *
 * Fields come back as text. Whether a field is a number, a blank, or neither is
 * the number parser's question, asked per cell after this.
 */

export type TsvParse =
  | { readonly ok: true; readonly rows: readonly (readonly string[])[] }
  | { readonly ok: false; readonly message: string };

export function parseTsv(text: string): TsvParse {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let index = 0;
  let fieldStart = true;

  const endField = (): void => {
    row.push(field);
    field = '';
    fieldStart = true;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index] as string;

    if (fieldStart && char === '"') {
      // A quoted field: to the closing quote, `""` being a literal one.
      index += 1;
      let closed = false;
      while (index < text.length) {
        const inner = text[index] as string;
        if (inner === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 2;
            continue;
          }
          closed = true;
          index += 1;
          break;
        }
        field += inner;
        index += 1;
      }
      if (!closed) {
        return { ok: false, message: 'The pasted text has a quote that never closes, so nothing was pasted.' };
      }
      fieldStart = false;
      const next = text[index];
      if (next !== undefined && next !== '\t' && next !== '\n' && next !== '\r') {
        return { ok: false, message: 'The pasted text has characters after a closing quote, so nothing was pasted.' };
      }
      continue;
    }

    fieldStart = false;
    if (char === '\t') {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r' || char === '\n') {
      endRow();
      index += char === '\r' && text[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += char;
    index += 1;
  }

  // Text after the last line break is a last row; a final line break is not.
  if (!fieldStart || row.length > 0 || field !== '') endRow();
  return { ok: true, rows };
}
