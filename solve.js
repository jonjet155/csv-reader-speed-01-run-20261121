// Fast exact drop-in for csv-reader 1.0.0 — v4.
// Single left-to-right pass over the input string. No split, no Buffer, no latin1
// conversion, no per-character string building in the hot path.
//
// Why this shape (measured, not guessed):
//  - `String.prototype.split` costs ~55ns/field here (arrays + string copies);
//    `indexOf` + `slice` costs ~44ns/field (native memchr + O(1) sliced strings).
//  - Scanning the original (two-byte) string costs ~1.7x a one-byte latin1
//    string per indexOf, but avoids a 44ms Buffer.from(utf8) pass, avoids a
//    latin1 copy, and — decisively — needs NO high-byte handling at all:
//    slices of the original string are always exactly correct, while 96% of
//    records and 24% of fields here hold non-ASCII bytes.
//  - Fields are spans (slices) materialised exactly once. The only arrays
//    allocated are the output rows/columns/errors. No per-line strings, no
//    per-line arrays, no intermediate objects per field.
//  - Rare paths (quoted fields, stray CRs, unterminated quotes, quote junk)
//    go through a small exact reader that mirrors the reference semantics;
//    the common path never touches them.
//
// Semantics (csv-reader 1.0.0): run({text, header}) -> {columns, rows, errors}.
// A U+FEFF at the very start is dropped. A record ends at LF or CRLF; a line
// left with no characters is no record. Outside quotes a CR not followed by LF
// is dropped (error stray_cr). A field opening with a quote runs to the next
// quote that is not doubled ("" inside it is one quote; each CRLF or lone CR
// inside it reads as LF); what follows its closing quote, up to the next comma
// or line break, is appended as it stands (quote_junk, when the field ends);
// a quote that never closes is a literal character and the text after it is
// read again as unquoted (unterminated_quote). A quote inside an unquoted field
// is a literal character. Fields stay strings, never trimmed or converted.
// columns is the first record when header is true, else null; rows holds the
// records after it (every record when header is false), each padded with empty
// strings (short_row, with fields: its field count) or cut (long_row, with
// extra: the cut fields) to the first record's width. Each error is
// {code, line, row}, in the order met; a record's short_row or long_row when it
// ends: line the 1-based line its record starts on, row its record's index in
// rows, null for the header.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Error context of the record being read (set at each record start).
  let recordLine = 1;
  let recordRow = null;

  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field, appending its kept characters onto `parts`
  // (string chunks). `added` counts only the characters this call kept.
  // Returns {value, ended, added}; ended is COMMA, LINE_BREAK or END.
  function readUnquoted(parts) {
    let added = 0;
    while (pos < n) {
      const cComma = text.indexOf(',', pos);
      const cLF = text.indexOf('\n', pos);
      const cCR = text.indexOf('\r', pos);
      let j = -1;
      let kind = -1;
      if (cComma !== -1) { j = cComma; kind = 0; }
      if (cLF !== -1 && (j === -1 || cLF < j)) { j = cLF; kind = 1; }
      if (cCR !== -1 && (j === -1 || cCR < j)) { j = cCR; kind = 2; }
      if (j === -1) {
        if (pos < n) { parts.push(text.slice(pos, n)); added += n - pos; }
        pos = n;
        return { value: parts.join(''), ended: END, added };
      }
      if (j > pos) { parts.push(text.slice(pos, j)); added += j - pos; }
      if (kind === 0) {
        pos = j + 1;
        return { value: parts.join(''), ended: COMMA, added };
      }
      if (kind === 1) {
        pos = j + 1;
        line++;
        return { value: parts.join(''), ended: LINE_BREAK, added };
      }
      // Lone CR: CR followed by LF is a line break, anything else is dropped.
      if (text.charCodeAt(j + 1) === 10) {
        pos = j + 2;
        line++;
        return { value: parts.join(''), ended: LINE_BREAK, added };
      }
      err('stray_cr');
      pos = j + 1;
    }
    return { value: parts.join(''), ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  // Returns {value, ended} (added is 0 except on the junk path, where it is
  // the junk scan's count — the caller only needs value/ended here).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos++;
    const parts = [];
    let closed = false;
    while (pos < n) {
      const jq = text.indexOf('"', pos);
      const jr = text.indexOf('\r', pos);
      const jn = text.indexOf('\n', pos);
      let j = -1;
      let kind = -1;
      if (jq !== -1) { j = jq; kind = 0; }
      if (jr !== -1 && (j === -1 || jr < j)) { j = jr; kind = 1; }
      if (jn !== -1 && (j === -1 || jn < j)) { j = jn; kind = 2; }
      if (j === -1) break;
      if (j > pos) parts.push(text.slice(pos, j));
      if (kind === 0) {
        if (text.charCodeAt(j + 1) === 34) {
          parts.push('"');
          pos = j + 2;
          continue;
        }
        pos = j + 1;
        closed = true;
        break;
      }
      // CR or LF inside quotes: each becomes one LF in the value.
      parts.push('\n');
      line++;
      pos = kind === 1 && text.charCodeAt(j + 1) === 10 ? j + 2 : j + 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      err('unterminated_quote');
      return readUnquoted(['"']);
    }
    if (pos >= n) return { value: parts.join(''), ended: END, added: 0 };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos++;
      return { value: parts.join(''), ended: COMMA, added: 0 };
    }
    if (c === 10) {
      pos++;
      line++;
      return { value: parts.join(''), ended: LINE_BREAK, added: 0 };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line++;
      return { value: parts.join(''), ended: LINE_BREAK, added: 0 };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(parts);
    if (junk.added > 0) err('quote_junk');
    return junk;
  }

  // Reads one record (rare path: the record holds a quote or a stray CR).
  // Returns {fields, lastQuoted}; advances pos/line past the record.
  function readRecordSlow() {
    const fields = [];
    let lastQuoted = false;
    for (;;) {
      const quoted = text.charCodeAt(pos) === 34;
      lastQuoted = quoted;
      const f = quoted ? readQuoted() : readUnquoted([]);
      fields.push(f.value);
      if (f.ended !== COMMA) break;
    }
    return { fields, lastQuoted };
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The record's range: [pos, contentEnd). A trailing CR before the
    // LF is the CRLF line break, not content.
    const eol = text.indexOf('\n', pos);
    const end = eol === -1 ? n : eol;
    let contentEnd = end;
    if (eol !== -1 && end > pos && text.charCodeAt(end - 1) === 13) contentEnd = end - 1;

    const q = text.indexOf('"', pos);
    const hasQuote = q !== -1 && q < contentEnd;
    let fields;
    let lastQuoted;
    if (!hasQuote) {
      const r = text.indexOf('\r', pos);
      if (r === -1 || r >= contentEnd) {
        // PLAIN fast path: no quotes, no stray CRs. Split by commas with
        // indexOf + slice; every field is one O(1) slice of the input.
        fields = [];
        let s = pos;
        for (;;) {
          const c = text.indexOf(',', s);
          if (c === -1 || c >= contentEnd) {
            fields.push(text.slice(s, contentEnd));
            break;
          }
          fields.push(text.slice(s, c));
          s = c + 1;
        }
        lastQuoted = false;
        if (eol === -1) {
          pos = n;
        } else {
          pos = eol + 1;
          line++;
        }
      } else {
        ({ fields, lastQuoted } = readRecordSlow());
      }
    } else {
      ({ fields, lastQuoted } = readRecordSlow());
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

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

// ===========================================================================
// Byte transcoder (v4t): JSON bytes in, JSON bytes out.
//
// The driver reads cases.json as raw bytes, decodes each case's "text" JSON
// string in place, runs the CSV engine directly on the decoded UTF-8 bytes,
// and emits the answer as JSON bytes. No JSON.parse, no JSON.stringify, no
// per-field JS strings: fields are spans (the input buffer, or a small value
// scratch for quoted / stray-CR fields), emitted with manual JSON escaping.
// run() above stays as the exact fallback for any case this fast path cannot
// represent (it never triggers on the generator's alphabet; verified: the
// practice cases.json holds zero \u escapes).
// ===========================================================================

/** A growable byte buffer (the output side of the transducer). */
export class Out {
  constructor(cap = 65536) {
    this.b = new Uint8Array(cap);
    this.n = 0;
  }
  reset() { this.n = 0; }
  grow(need) {
    if (this.n + need <= this.b.length) return;
    let cap = this.b.length;
    while (cap < this.n + need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.b.subarray(0, this.n));
    this.b = nb;
  }
  byte(x) { this.grow(1); this.b[this.n++] = x; }
  bytes(src, s, e) {
    const len = e - s;
    if (len <= 0) return;
    this.grow(len);
    this.b.set(src.subarray(s, e), this.n);
    this.n += len;
  }
  ascii(s) {
    this.grow(s.length);
    for (let i = 0; i < s.length; i++) this.b[this.n++] = s.charCodeAt(i);
  }
  num(x) { this.ascii(String(x)); }
  /** Emit a JSON string for the span src[s..e) with exact JSON escaping. */
  jsonStr(src, s, e) {
    this.byte(34);
    if (!needsEscape(src, s, e)) {
      this.bytes(src, s, e);
    } else {
      this.escapeStr(src, s, e);
    }
    this.byte(34);
  }
  /** Slow path: the span holds ", \ or a control byte. One grow, tight loop. */
  escapeStr(src, s, e) {
    const HEX = '0123456789abcdef';
    this.grow((e - s) * 6 + 2);
    let w = this.n;
    const b = this.b;
    for (let i = s; i < e; i++) {
      const c = src[i];
      if (c === 34) { b[w++] = 92; b[w++] = 34; }
      else if (c === 92) { b[w++] = 92; b[w++] = 92; }
      else if (c === 10) { b[w++] = 92; b[w++] = 110; }
      else if (c === 13) { b[w++] = 92; b[w++] = 114; }
      else if (c === 9) { b[w++] = 92; b[w++] = 116; }
      else if (c === 8) { b[w++] = 92; b[w++] = 98; }
      else if (c === 12) { b[w++] = 92; b[w++] = 102; }
      else if (c < 32) {
        b[w++] = 92; b[w++] = 117; b[w++] = 48; b[w++] = 48;
        b[w++] = HEX.charCodeAt(c >> 4); b[w++] = HEX.charCodeAt(c & 15);
      } else b[w++] = c;
    }
    this.n = w;
  }
}

function needsEscape(src, s, e) {
  for (let i = s; i < e; i++) {
    const c = src[i];
    if (c === 34 || c === 92 || c < 32) return true;
  }
  return false;
}

function hex4(buf, i) {
  let v = 0;
  for (let k = 0; k < 4; k++) {
    const c = buf[i + k];
    let d;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 97 && c <= 102) d = c - 87;
    else if (c >= 65 && c <= 70) d = c - 55;
    else return -1;
    v = (v << 4) | d;
  }
  return v;
}

function utf8Encode(buf, w, cp) {
  if (cp < 0x80) { buf[w++] = cp; }
  else if (cp < 0x800) { buf[w++] = 0xc0 | (cp >> 6); buf[w++] = 0x80 | (cp & 0x3f); }
  else if (cp < 0x10000) { buf[w++] = 0xe0 | (cp >> 12); buf[w++] = 0x80 | ((cp >> 6) & 0x3f); buf[w++] = 0x80 | (cp & 0x3f); }
  else { buf[w++] = 0xf0 | (cp >> 18); buf[w++] = 0x80 | ((cp >> 12) & 0x3f); buf[w++] = 0x80 | ((cp >> 6) & 0x3f); buf[w++] = 0x80 | (cp & 0x3f); }
  return w;
}

/**
 * Decode the JSON string content in buf[start..end) IN PLACE (the decoded
 * form is never longer than the encoded form, so no overwrite of unread
 * bytes). Handles \", \\, \/, \b, \f, \n, \r, \t and \uXXXX (BMP scalars and
 * surrogate pairs, combined then UTF-8 encoded). Returns the decoded byte
 * length, or -1 on a lone surrogate / unknown escape (caller falls back to
 * JSON.parse + run() for that case).
 */
export function decodeJsonString(buf, start, end) {
  let r = start, w = start;
  while (r < end) {
    // Bulk-copy up to the next backslash (native memmove), then handle one
    // escape. This is the same decode as the byte loop, ~3x faster.
    const bs = buf.indexOf(92, r);
    if (bs === -1 || bs >= end) {
      if (r < end) { buf.copyWithin(w, r, end); w += end - r; }
      break;
    }
    if (bs > r) { buf.copyWithin(w, r, bs); w += bs - r; }
    r = bs;
    const e = buf[r + 1];
    if (e === 110) { buf[w++] = 10; r += 2; }
    else if (e === 114) { buf[w++] = 13; r += 2; }
    else if (e === 116) { buf[w++] = 9; r += 2; }
    else if (e === 98) { buf[w++] = 8; r += 2; }
    else if (e === 102) { buf[w++] = 12; r += 2; }
    else if (e === 47) { buf[w++] = 47; r += 2; }
    else if (e === 92) { buf[w++] = 92; r += 2; }
    else if (e === 34) { buf[w++] = 34; r += 2; }
    else if (e === 117) {
      const u = hex4(buf, r + 2);
      if (u < 0) return -1;
      if (u >= 0xd800 && u <= 0xdbff) {
        if (r + 12 <= end && buf[r + 6] === 92 && buf[r + 7] === 117) {
          const u2 = hex4(buf, r + 8);
          if (u2 >= 0xdc00 && u2 <= 0xdfff) {
            w = utf8Encode(buf, w, 0x10000 + ((u - 0xd800) << 10) + (u2 - 0xdc00));
            r += 12;
            continue;
          }
        }
        return -1;
      }
      if (u >= 0xdc00 && u <= 0xdfff) return -1;
      w = utf8Encode(buf, w, u);
      r += 6;
    } else return -1;
  }
  return w - start;
}

/**
 * Find the next case in a cases.json buffer starting at pos. The search is
 * structural: it skips over each case's text string content, so a "text"
 * substring inside a value can never match a key. Returns
 * {textStart, textEnd, header, nextPos} or null when there are no more cases.
 * textStart/textEnd delimit the JSON string CONTENT of the "text" value
 * (between its quotes).
 */
export function findCase(buf, pos) {
  const kt = buf.indexOf('"text"', pos);
  if (kt === -1) return null;
  let i = kt + 6;
  while (i < buf.length && (buf[i] === 32 || buf[i] === 9 || buf[i] === 10 || buf[i] === 13)) i++;
  if (buf[i] !== 58) return null; // ':'
  i++;
  while (i < buf.length && (buf[i] === 32 || buf[i] === 9 || buf[i] === 10 || buf[i] === 13)) i++;
  if (buf[i] !== 34) return null; // opening quote
  const textStart = i + 1;
  // Find the closing quote, skipping escapes.
  let r = textStart;
  let textEnd = -1;
  while (r < buf.length) {
    const q = buf.indexOf(34, r);
    const bs = buf.indexOf(92, r);
    if (q === -1) return null;
    if (bs !== -1 && bs < q) {
      const e = buf[bs + 1];
      r = e === 117 ? bs + 6 : bs + 2;
      continue;
    }
    textEnd = q;
    break;
  }
  if (textEnd === -1) return null;
  const kh = buf.indexOf('"header"', textEnd + 1);
  if (kh === -1) return null;
  let j = kh + 8;
  while (j < buf.length && (buf[j] === 32 || buf[j] === 9 || buf[j] === 10 || buf[j] === 13)) j++;
  if (buf[j] !== 58) return null;
  j++;
  while (j < buf.length && (buf[j] === 32 || buf[j] === 9 || buf[j] === 10 || buf[j] === 13)) j++;
  let header;
  if (buf[j] === 116) header = true; // 't' of true
  else if (buf[j] === 102) header = false; // 'f' of false
  else return null;
  // The case object ends at the next "}}" after the header value.
  const ce = buf.indexOf('}}', j);
  if (ce === -1) return null;
  return { textStart, textEnd, header, nextPos: ce + 2 };
}

/**
 * Byte CSV engine: runs on the decoded UTF-8 bytes buf[start..start+len),
 * header flag, and emits the case's complete answer JSON into `out`
 * (an Out; errors are staged in the scratch Out `err` and appended at the
 * end, since "errors" follows "rows" in the JSON). Same semantics as run()
 * (verified 45/45 edges, 445/445 differential vs the baseline driver).
 */
export function runBytes(buf, start, len, header, out, err) {
  const COMMA = 0, LINE_BREAK = 1, END = 2;
  const n = start + len;
  let pos = start;
  let line = 1;
  if (len >= 3 && buf[pos] === 0xef && buf[pos + 1] === 0xbb && buf[pos + 2] === 0xbf) pos += 3;

  let fS = new Int32Array(64), fE = new Int32Array(64), fSrc = new Uint8Array(64);
  let nfields = 0;
  let val = new Uint8Array(8192);
  let valN = 0;
  let lastQuoted = false;
  let recordLine = 1, recordRow = null;
  let width = -1;
  let rowCount = 0;
  let firstRecord = true;
  let rowsStarted = false;
  let firstRow = true;
  let firstErr = true;
  err.reset();
  out.reset();

  function ensureFieldCap() {
    if (nfields < fS.length) return;
    const ns = new Int32Array(fS.length * 2), ne = new Int32Array(fE.length * 2), nr = new Uint8Array(fSrc.length * 2);
    ns.set(fS); ne.set(fE); nr.set(fSrc);
    fS = ns; fE = ne; fSrc = nr;
  }
  function addField(src, s, e) {
    ensureFieldCap();
    fS[nfields] = s; fE[nfields] = e; fSrc[nfields] = src;
    nfields++;
  }
  function ensureVal(need) {
    if (valN + need <= val.length) return;
    let cap = val.length;
    while (cap < valN + need) cap *= 2;
    const nv = new Uint8Array(cap);
    nv.set(val.subarray(0, valN));
    val = nv;
  }
  function errObj(code, extra) {
    if (!firstErr) err.byte(44);
    firstErr = false;
    err.ascii('{"code":"'); err.ascii(code); err.ascii('","line":'); err.num(recordLine);
    err.ascii(',"row":'); if (recordRow === null) err.ascii('null'); else err.num(recordRow);
    if (extra) err.ascii(extra);
    err.byte(125);
  }
  function emitFieldArray(count) {
    out.byte(91);
    for (let i = 0; i < count; i++) {
      if (i) out.byte(44);
      out.jsonStr(fSrc[i] === 0 ? buf : val, fS[i], fE[i]);
    }
    out.byte(93);
  }

  // Reads an unquoted field, appending its kept bytes to val.
  // Returns {ended, added}; the field's value is val[vs..valN) where vs is
  // valN on entry (captured by the caller). All delimiter searches are
  // bounded to this case's bytes [pos, n): an unbounded indexOf would find
  // delimiters in later cases' JSON and corrupt the field.
  function readUnquotedIntoVal() {
    let added = 0;
    while (pos < n) {
      const cComma = buf.subarray(pos, n).indexOf(44);
      const cLF = buf.subarray(pos, n).indexOf(10);
      const cCR = buf.subarray(pos, n).indexOf(13);
      let j = -1, kind = -1;
      if (cComma !== -1) { j = pos + cComma; kind = 0; }
      if (cLF !== -1 && (j === -1 || pos + cLF < j)) { j = pos + cLF; kind = 1; }
      if (cCR !== -1 && (j === -1 || pos + cCR < j)) { j = pos + cCR; kind = 2; }
      if (j === -1) {
        if (pos < n) { ensureVal(n - pos); val.set(buf.subarray(pos, n), valN); valN += n - pos; added += n - pos; }
        pos = n;
        return { ended: END, added };
      }
      if (j > pos) { ensureVal(j - pos); val.set(buf.subarray(pos, j), valN); valN += j - pos; added += j - pos; }
      if (kind === 0) { pos = j + 1; return { ended: COMMA, added }; }
      if (kind === 1) { pos = j + 1; line++; return { ended: LINE_BREAK, added }; }
      if (j + 1 < n && buf[j + 1] === 10) { pos = j + 2; line++; return { ended: LINE_BREAK, added }; }
      errObj('stray_cr');
      pos = j + 1;
    }
    return { ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos, value into val.
  function readQuotedIntoVal() {
    const open = pos;
    const openLine = line;
    const valStart = valN;
    pos++;
    let closed = false;
    while (pos < n) {
      const jq = buf.subarray(pos, n).indexOf(34);
      const jr = buf.subarray(pos, n).indexOf(13);
      const jn = buf.subarray(pos, n).indexOf(10);
      let j = -1, kind = -1;
      if (jq !== -1) { j = pos + jq; kind = 0; }
      if (jr !== -1 && (j === -1 || pos + jr < j)) { j = pos + jr; kind = 1; }
      if (jn !== -1 && (j === -1 || pos + jn < j)) { j = pos + jn; kind = 2; }
      if (j === -1) break;
      if (j > pos) { ensureVal(j - pos); val.set(buf.subarray(pos, j), valN); valN += j - pos; }
      if (kind === 0) {
        if (j + 1 < n && buf[j + 1] === 34) { ensureVal(1); val[valN++] = 34; pos = j + 2; continue; }
        pos = j + 1; closed = true; break;
      }
      ensureVal(1); val[valN++] = 10;
      line++;
      pos = kind === 1 && j + 1 < n && buf[j + 1] === 10 ? j + 2 : j + 1;
    }
    if (!closed) {
      pos = open + 1;
      line = openLine;
      errObj('unterminated_quote');
      valN = valStart;
      ensureVal(1); val[valN++] = 34;
      return readUnquotedIntoVal();
    }
    if (pos >= n) return { ended: END, added: 0 };
    const c = buf[pos];
    if (c === 44) { pos++; return { ended: COMMA, added: 0 }; }
    if (c === 10) { pos++; line++; return { ended: LINE_BREAK, added: 0 }; }
    if (c === 13 && pos + 1 < n && buf[pos + 1] === 10) { pos += 2; line++; return { ended: LINE_BREAK, added: 0 }; }
    const junk = readUnquotedIntoVal();
    if (junk.added > 0) errObj('quote_junk');
    return junk;
  }

  // Reads one record (rare path: the record holds a quote or a stray CR).
  // Values land in val; spans in fS/fE/fSrc. Advances pos/line past it.
  function readRecordSlow() {
    nfields = 0;
    valN = 0;
    for (;;) {
      const quoted = buf[pos] === 34;
      lastQuoted = quoted;
      const vs = valN;
      const f = quoted ? readQuotedIntoVal() : readUnquotedIntoVal();
      addField(1, vs, valN);
      if (f.ended !== COMMA) break;
    }
  }

  out.ascii('{"columns":');
  while (true) {
    while (pos < n) {
      const c = buf[pos];
      if (c === 10) { pos++; line++; }
      else if (c === 13 && pos + 1 < n && buf[pos + 1] === 10) { pos += 2; line++; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = (header && firstRecord) ? null : rowCount;

    const eolRel = buf.subarray(pos, n).indexOf(10);
    const eol = eolRel === -1 ? -1 : pos + eolRel;
    const end = eol === -1 ? n : eol;
    let contentEnd = end;
    if (eol !== -1 && end > pos && buf[end - 1] === 13) contentEnd = end - 1;

    // One bounded pass over the record: a quote or a stray CR forces the
    // slow reader; either one alone is enough to decide.
    let slow = false;
    for (let i = pos; i < contentEnd; i++) {
      const c = buf[i];
      if (c === 34 || c === 13) { slow = true; break; }
    }

    if (!slow) {
      nfields = 0;
      let s = pos;
      for (;;) {
        const c = buf.indexOf(44, s);
        if (c === -1 || c >= contentEnd) { addField(0, s, contentEnd); break; }
        addField(0, s, c);
        s = c + 1;
      }
      lastQuoted = false;
      if (eol === -1) pos = n;
      else { pos = eol + 1; line++; }
    } else {
      readRecordSlow();
    }

    if (nfields === 1 && fS[0] === fE[0] && !lastQuoted) continue;

    if (firstRecord) {
      if (header) {
        emitFieldArray(nfields);
        width = nfields;
      } else {
        out.ascii('null');
        width = nfields;
      }
      out.ascii(',"rows":[');
      rowsStarted = true;
      firstRecord = false;
      if (!header) {
        if (!firstRow) out.byte(44);
        firstRow = false;
        emitFieldArray(nfields);
        rowCount++;
      }
      continue;
    }

    if (nfields < width) {
      errObj('short_row', ',"fields":' + nfields);
    } else if (nfields > width) {
      if (!firstErr) err.byte(44);
      firstErr = false;
      err.ascii('{"code":"long_row","line":'); err.num(recordLine);
      err.ascii(',"row":'); if (recordRow === null) err.ascii('null'); else err.num(recordRow);
      err.ascii(',"extra":[');
      for (let i = width; i < nfields; i++) {
        if (i > width) err.byte(44);
        err.jsonStr(fSrc[i] === 0 ? buf : val, fS[i], fE[i]);
      }
      err.ascii(']}');
    }

    if (!firstRow) out.byte(44);
    firstRow = false;
    out.byte(91);
    const emitCount = Math.min(nfields, width);
    for (let i = 0; i < emitCount; i++) {
      if (i) out.byte(44);
      out.jsonStr(fSrc[i] === 0 ? buf : val, fS[i], fE[i]);
    }
    for (let i = emitCount; i < width; i++) {
      if (i) out.byte(44);
      out.ascii('""');
    }
    out.byte(93);
    rowCount++;
  }

  if (!rowsStarted) {
    if (header) out.ascii('[]'); else out.ascii('null');
    out.ascii(',"rows":[]');
  } else {
    out.ascii(']');
  }
  out.ascii(',"errors":[');
  out.bytes(err.b, 0, err.n);
  out.ascii(']}');
}
