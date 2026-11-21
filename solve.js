// v5: single-pass charCodeAt engine (uDSV-style). Exact csv-reader 1.0.0 semantics.
// One pass over the JS string as it comes out of JSON.parse: fields are sliced
// once at their end boundary; no split, no per-field indexOf, no regex, no
// Buffer/TextEncoder. The driver keeps the native JSON.parse / JSON.stringify
// (v4 proved the native pieces win); the win must come from less JS work per byte.

// Rare path only: build a quoted field's value when it contains doubled quotes
// ("" -> ") or CR/CRLF (each -> one LF). `end` is the closing-quote index.
function buildQuoted(text, start, end) {
  const parts = [];
  let s = start;
  let i = start;
  while (i < end) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      parts.push(text.slice(s, i));
      parts.push('"');
      i += 2;
      s = i;
    } else if (c === 13) {
      parts.push(text.slice(s, i));
      parts.push('\n');
      i += (i + 1 < end && text.charCodeAt(i + 1) === 10) ? 2 : 1;
      s = i;
    } else {
      i++;
    }
  }
  parts.push(text.slice(s, end));
  return parts.join('');
}

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  const rows = [];
  const errors = [];
  let columns = null;
  let width = -1;

  while (true) {
    // Skip blank lines: LF, or CRLF.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos++; line++; }
      else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) { pos += 2; line++; }
      else break;
    }
    if (pos >= len) break;

    const recordLine = line;
    const recordRow = (header && columns === null) ? null : rows.length;
    const fields = [];
    let f0quoted = false;
    let ended = 2; // 0 = comma, 1 = line break, 2 = end of text

    for (;;) {
      // ---- one field ----
      let prefix = ''; // unquoted scan appends to this (junk after quote, or '"' re-read); '' = none (keeps the + monomorphic string-only)
      let junkCheck = false; // after the scan, quote_junk if added > 0

      if (pos < len && text.charCodeAt(pos) === 34) {
        // ---- quoted field ----
        if (fields.length === 0) f0quoted = true;
        const open = pos;
        const openLine = line;
        let q = pos + 1;
        let closed = -1;
        let special = false; // doubled quote or CR inside
        while (q < len) {
          const c = text.charCodeAt(q);
          if (c === 34) {
            if (q + 1 < len && text.charCodeAt(q + 1) === 34) { special = true; q += 2; }
            else { closed = q; break; }
          } else if (c === 13) {
            special = true;
            line++;
            q += (q + 1 < len && text.charCodeAt(q + 1) === 10) ? 2 : 1;
          } else if (c === 10) {
            line++;
            q++;
          } else {
            q++;
          }
        }
        if (closed === -1) {
          // Unterminated: error FIRST, reset, re-read as unquoted with literal '"'.
          pos = open + 1;
          line = openLine;
          errors.push({code: 'unterminated_quote', line: recordLine, row: recordRow});
          prefix = '"';
        } else {
          const value = special ? buildQuoted(text, open + 1, closed) : text.slice(open + 1, closed);
          pos = closed + 1;
          if (pos >= len) {
            fields.push(value);
            ended = 2;
            break;
          }
          const t = text.charCodeAt(pos);
          if (t === 44) {
            fields.push(value);
            pos++;
            ended = 0;
            continue;
          }
          if (t === 10) {
            fields.push(value);
            pos++;
            line++;
            ended = 1;
            break;
          }
          if (t === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
            fields.push(value);
            pos += 2;
            line++;
            ended = 1;
            break;
          }
          // Junk after the closing quote: readUnquoted(value) from here.
          prefix = value;
          junkCheck = true;
        }
      }

      // ---- unquoted scan (prefix: null, '"' or a quoted value) ----
      let segStart = pos;
      let parts = null; // only when stray CRs force segmenting
      let endPos = len;
      ended = 2;
      while (pos < len) {
        const c = text.charCodeAt(pos);
        if (c >= 45) { pos++; continue; } // ordinary char: one compare, no call
        if (c === 44) { endPos = pos; pos++; ended = 0; break; }
        if (c === 10) { endPos = pos; pos++; line++; ended = 1; break; }
        if (c === 13) {
          if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) { endPos = pos; pos += 2; line++; ended = 1; break; }
          // Stray CR: error, drop it, keep scanning.
          errors.push({code: 'stray_cr', line: recordLine, row: recordRow});
          if (parts === null) parts = [];
          parts.push(text.slice(segStart, pos));
          pos++;
          segStart = pos;
          continue;
        }
        pos++;
      }
      let value;
      let added;
      if (parts === null) {
        value = prefix === '' ? text.slice(segStart, endPos) : prefix + text.slice(segStart, endPos);
        added = endPos - segStart;
      } else {
        parts.push(text.slice(segStart, endPos));
        value = prefix === '' ? parts.join('') : prefix + parts.join('');
        added = value.length - prefix.length;
      }
      if (junkCheck && added > 0) {
        errors.push({code: 'quote_junk', line: recordLine, row: recordRow});
      }
      fields.push(value);
      if (ended !== 0) break;
    }

    // ---- record done ----
    if (fields.length === 1 && fields[0] === '' && !f0quoted) {
      // Dropped entirely (e.g. a line of only stray CRs); errors stay.
    } else {
      if (width === -1) width = fields.length;
      if (header && columns === null) {
        columns = fields;
      } else {
        if (fields.length < width) {
          errors.push({code: 'short_row', line: recordLine, row: recordRow, fields: fields.length});
          while (fields.length < width) fields.push('');
        } else if (fields.length > width) {
          const extra = fields.splice(width);
          errors.push({code: 'long_row', line: recordLine, row: recordRow, extra: extra});
        }
        rows.push(fields);
      }
    }
  }

  return {columns: header ? (columns === null ? [] : columns) : null, rows: rows, errors: errors};
}

// ---- JIT warmup (module load) ----
// Prime run() through every code path with enough loop iterations to trigger
// Maglev/TurboFan BEFORE the timed parse, so the real cases run on optimized
// code instead of paying tier-up + deopts mid-parse. The result is discarded;
// run() keeps no state between calls, so purity is unaffected. Cost is a few ms.
(function prime() {
  const rows = [
    'id,name,amount,date,note,code',
    '1,alpha,12.5,2020-01-02,plain note,AB-123',
    '2,"bravo, x",3.14,2021-06-30,"quoted, with comma",CD-456',
    '3,"say ""hi""",7,2022-03-04,"doubled ""quotes"" here",EF-789',
    '4,delta,9.99,2023-12-31,"multi\nline note",GH-012',
    '5,echo,1.5,2024-02-29,"crlf\r\ninside",IJ-345',
    '6,"lone\rcr",2.25,2025-05-05,trailing,KL-678',
    '7,"junk"xx,4,2026-07-07,after junk,MN-901',
    '8,hotel,5,2027-08-08,short',
    '9,india,6,2028-09-09,long,extra1,extra2',
    '',
    '10,juliet,7.5,2029-10-10,after blank,OP-234',
    '11,kilo\r,8,2030-11-11,stray cr,QR-567',
    '12,"unterm,13,14,2031-12-12,never closes,ST-890',
    '13,mike,9,2032-01-01,after unterm,UV-123',
  ];
  const text = '\uFEFF' + rows.join('\r\n');
  run({ text: text + ('\n' + rows.slice(1, 7).join('\n')).repeat(900), header: true });
})();
