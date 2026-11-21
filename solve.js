// Fast drop-in for make.fun's csv-reader 1.0.0: identical answers, bulk scanning instead of
// character-at-a-time. Semantics follow csv-reader 1.0.0 (kit baselines/csv-reader/vendor/
// csv-reader/index.js) exactly:
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it
//     one quote, each CRLF or lone CR inside it read as LF; what follows its closing quote, up
//     to the next comma or line break, is appended as it stands (quote_junk, when the field
//     ends); a quote that never closes is a literal character, and the text after it is read
//     again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings;
//   - columns is the first record when header is true, else null; rows are padded with ""
//     (short_row, with fields: its count) or cut (long_row, with extra: the cut fields) to the
//     first record's width; each error is {code, line, row} in the order met, line the 1-based
//     line its record starts on, row its record's index in rows (null for the header).
//
// Speed comes from bulk scans: unquoted fields are cut at the next comma or line break
// with indexOf, quoted fields jump from quote to quote with indexOf and copy whole segments
// with slice, so the common single-line field costs a few native calls instead of a loop over
// every character. A CR is found with a short scan bounded by the field's end, never an
// unbounded search. Nothing is cached from one case to the next.

/** A line break inside a quoted field: CRLF, a lone CR, or LF; each becomes one LF. */
const QUOTED_BREAK = /\r\n|\r|\n/g;

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The last field read: its value, how it ended, and how many characters an unquoted read
  // kept (a shared slot, so reading a field allocates no result object).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Every CR in the text, in order, collected in one native scan: a CR is only ever a
  // stray CR or half of a CRLF, so a field can test for one in [pos, end) by looking at the
  // next entry here instead of scanning for it.
  const crs = [];
  {
    let r = text.indexOf('\r', 0);
    while (r !== -1) {
      crs.push(r);
      r = text.indexOf('\r', r + 1);
    }
  }
  let crIdx = 0; // the first CR at or after pos
  let lineEnd = -1; // the next LF at or after pos: -1 unknown, Infinity none left

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed
  // by LF is dropped (stray_cr). Leaves the field in fValue, how it ended in fEnded, and the
  // characters kept in fAdded.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      while (crIdx < crs.length && crs[crIdx] < pos) crIdx += 1;
      const c = text.indexOf(',', pos);
      if (lineEnd < pos) {
        lineEnd = text.indexOf('\n', pos);
        if (lineEnd === -1) lineEnd = Infinity;
      }
      const n = lineEnd === Infinity ? -1 : lineEnd;
      let end;
      let isComma;
      if (c === -1) {
        end = n;
        isComma = false;
      } else if (n === -1) {
        end = c;
        isComma = true;
      } else if (c < n) {
        end = c;
        isComma = true;
      } else {
        end = n;
        isComma = false;
      }
      if (end === -1) {
        // No comma or line break left: the rest is the field, except stray CRs (no LF
        // follows any of them, since none is left).
        while (crIdx < crs.length) {
          const r = crs[crIdx];
          crIdx += 1;
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          if (r > pos) {
            value += text.slice(pos, r);
            added += r - pos;
          }
          pos = r + 1;
        }
        if (pos < len) {
          value += text.slice(pos);
          added += len - pos;
          pos = len;
        }
        fValue = value;
        fEnded = END;
        fAdded = added;
        return;
      }
      const r = crIdx < crs.length && crs[crIdx] < end ? crs[crIdx] : -1;
      if (r === -1) {
        if (end > pos) {
          value += text.slice(pos, end);
          added += end - pos;
        }
        if (isComma) {
          pos = end + 1;
          fValue = value;
          fEnded = COMMA;
          fAdded = added;
          return;
        }
        pos = end + 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = added;
        return;
      }
      if (!isComma && r === end - 1) {
        // CRLF: the CR is the line break's first half.
        if (r > pos) {
          value += text.slice(pos, r);
          added += r - pos;
        }
        pos = end + 1;
        line += 1;
        crIdx += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = added;
        return;
      }
      // A stray CR: dropped, and the field goes on after it.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (r > pos) {
        value += text.slice(pos, r);
        added += r - pos;
      }
      pos = r + 1;
      crIdx += 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Leaves the field in fValue and how
  // it ended in fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let segStart = pos;
    for (;;) {
      const j = text.indexOf('"', pos);
      if (j === -1) {
        // The quote never closes: it is a literal character, and the text after it is read
        // again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      if (text.charCodeAt(j + 1) === 34) {
        // A doubled quote: the segment before it, then one quote.
        value += appendSegment(text.slice(segStart, j));
        value += '"';
        pos = j + 2;
        segStart = pos;
        continue;
      }
      // The closing quote.
      value += appendSegment(text.slice(segStart, j));
      pos = j + 1;
      if (pos >= len) {
        fValue = value;
        fEnded = END;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value;
        fEnded = COMMA;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or
      // line break.
      readUnquoted(value);
      if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
  }

  // A quoted segment with every CRLF or lone CR read as LF, counting each line break; a segment
  // with no line break is returned as it stands.
  function appendSegment(seg) {
    if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) return seg;
    return seg.replace(QUOTED_BREAK, () => {
      line += 1;
      return '\n';
    });
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
