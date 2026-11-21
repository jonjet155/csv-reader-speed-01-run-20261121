// Fast exact drop-in for csv-reader 1.0.0.
//
// Single pass over the text. The common case — a record with no quotes and no
// stray CR — is handled with native indexOf / slice / split, never one
// character at a time. Anything unusual (a quote in the record, a stray CR)
// falls back to a careful character-level reader that reproduces the
// reference exactly, error for error.
//
// Semantics (csv-reader 1.0.0):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote; CRLF and lone CR inside it each become LF.
//   What follows the closing quote, up to the next comma or line break, is
//   appended as it stands (quote_junk, when the field ends).
// - A quote that never closes is a literal character and the text after it
//   is read again as unquoted (unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows are the
//   records after it, each padded (short_row, with fields: its count) or cut
//   (long_row, with extra: the cut fields) to the first record's width.
// - Each error is {code, line, row} in the order met; line is the 1-based
//   line its record starts on, row its index in rows (null for the header).
// - Pure: no state is kept from one call to the next.

export function run(input) {
  const s = String(input.text);
  const header = input.header === true;
  const n = s.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // next character to read
  let line = 1; // line that character is on
  if (n > 0 && s.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on, its index in rows (null:
  // the header). Every error of the record carries these two.
  let recordLine = 1;
  let recordRow = null;

  // Count line breaks (LF, or CR not followed by LF) in s[a..b) into line.
  // A CRLF pair counts once, through its LF.
  function countBreaks(a, b) {
    let k = s.indexOf('\n', a);
    while (k !== -1 && k < b) {
      line++;
      k = s.indexOf('\n', k + 1);
    }
    k = s.indexOf('\r', a);
    while (k !== -1 && k < b) {
      if (s.charCodeAt(k + 1) !== 10) line++;
      k = s.indexOf('\r', k + 1);
    }
  }

  // Careful character-level unquoted reader (rare path: a stray CR was met).
  // Continues from pos; `value` is what the field holds so far, `added` the
  // kept characters added so far (stray CRs add nothing).
  function unquotedSlow(value, added) {
    while (pos < n) {
      const cc = s.charCodeAt(pos);
      if (cc === 44) {
        pos++;
        return { value, ended: 'comma', added };
      }
      if (cc === 10) {
        pos++;
        line++;
        return { value, ended: 'line break', added };
      }
      if (cc === 13) {
        if (s.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line++;
          return { value, ended: 'line break', added };
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos++;
        continue;
      }
      value += s[pos];
      added++;
      pos++;
    }
    return { value, ended: 'end', added };
  }

  // Fast unquoted reader: slice up to the next comma / LF / end of text.
  // A CR inside the slice (other than the one trailing a CRLF ending) hands
  // the field to the slow reader, which drops it with a stray_cr error.
  function unquoted(value) {
    let added = 0;
    const cIdx = s.indexOf(',', pos);
    const lIdx = s.indexOf('\n', pos);
    let end;
    let ended;
    if (cIdx !== -1 && (lIdx === -1 || cIdx < lIdx)) {
      end = cIdx;
      ended = 'comma';
    } else if (lIdx !== -1) {
      end = lIdx;
      ended = 'line break';
    } else {
      end = n;
      ended = 'end';
    }
    const chunk = s.slice(pos, end);
    const r = chunk.indexOf('\r');
    if (r !== -1) {
      if (ended === 'line break' && r === chunk.length - 1) {
        // CRLF ending: the trailing CR is the line break, not content.
        if (chunk.length > 1) {
          value += chunk.slice(0, -1);
          added += chunk.length - 1;
        }
        pos = end + 1;
        line++;
        return { value, ended, added };
      }
      return unquotedSlow(value, added);
    }
    if (chunk.length > 0) {
      value += chunk;
      added += chunk.length;
    }
    if (ended === 'comma') pos = end + 1;
    else if (ended === 'line break') {
      pos = end + 1;
      line++;
    } else {
      pos = n;
    }
    return { value, ended, added };
  }

  // A quoted field whose opening quote is at pos.
  function quoted() {
    const open = pos;
    const openLine = line;
    pos++;
    let pieces = null;
    let seg = pos;
    while (true) {
      const q = s.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return unquoted('"');
      }
      if (s.charCodeAt(q + 1) === 34) {
        // Doubled quote: one literal quote.
        if (pieces === null) pieces = [];
        pieces.push(s.slice(seg, q + 1));
        pos = q + 2;
        seg = pos;
        continue;
      }
      let value;
      if (pieces === null) value = s.slice(seg, q);
      else {
        pieces.push(s.slice(seg, q));
        value = pieces.join('');
      }
      // CRLF and lone CR inside quotes each become one LF in the value, and
      // each counts one line for the records that follow. The value pieces
      // still hold the raw CRs, so normalise them now (split/join, no regex).
      if (value.indexOf('\r') !== -1) value = value.split('\r\n').join('\n').split('\r').join('\n');
      countBreaks(open + 1, q);
      pos = q + 1;
      if (pos >= n) return { value, ended: 'end' };
      const cc = s.charCodeAt(pos);
      if (cc === 44) {
        pos++;
        return { value, ended: 'comma' };
      }
      if (cc === 10) {
        pos++;
        line++;
        return { value, ended: 'line break' };
      }
      if (cc === 13 && s.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
        return { value, ended: 'line break' };
      }
      // What follows the closing quote is appended as it stands.
      const junk = unquoted(value);
      if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return junk;
    }
  }

  // Field-by-field record reader (slow path: a quote, or a stray CR, is in
  // the record). Returns the fields and whether the first field was quoted.
  function recordSlow() {
    const fields = [];
    let firstQuoted = false;
    let first = true;
    let ended;
    do {
      let f;
      if (s.charCodeAt(pos) === 34) {
        if (first) firstQuoted = true;
        f = quoted();
      } else {
        f = unquoted('');
      }
      first = false;
      fields.push(f.value);
      ended = f.ended;
    } while (ended === 'comma');
    return { fields, firstQuoted };
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const cc = s.charCodeAt(pos);
      if (cc === 10) {
        pos++;
        line++;
      } else if (cc === 13 && s.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record's first line holds no quote at all, so no field
    // of it is quoted and it cannot span lines. Split it with split(',').
    const nl = s.indexOf('\n', pos);
    const segEnd = nl === -1 ? n : nl;
    const seg = s.slice(pos, segEnd);
    let fields;
    let firstQuoted = false;
    if (seg.indexOf('"') === -1) {
      const r = seg.indexOf('\r');
      if (r === -1) {
        fields = seg.split(',');
        pos = nl === -1 ? n : nl + 1;
        if (nl !== -1) line++;
      } else if (nl !== -1 && r === seg.length - 1) {
        // CRLF ending: strip the one trailing CR.
        fields = seg.slice(0, -1).split(',');
        pos = nl + 1;
        line++;
      } else {
        // A stray CR inside the record: read it field by field.
        const rec = recordSlow();
        fields = rec.fields;
        firstQuoted = rec.firstQuoted;
      }
    } else {
      const rec = recordSlow();
      fields = rec.fields;
      firstQuoted = rec.firstQuoted;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !firstQuoted) continue;

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
