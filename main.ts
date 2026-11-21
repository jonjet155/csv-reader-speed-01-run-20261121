// main.ts — JSON-to-JSON byte transcoder driver.
//
// Reads cases.json as raw bytes, answers each case with the byte engine in
// solve.js, and streams answers.json out per case. No JSON.parse, no
// JSON.stringify, no 12 MB output string, no per-field JS strings. The output
// is byte-identical to JSON.stringify(answers) (verified against the baseline
// driver). run() from solve.js is the exact fallback if any case cannot be
// transcoded (it never triggers on the generator's alphabet).

import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-incremental-marking');

const { run, findCase, decodeJsonString, runBytes, Out } = await import('./solve.js');

import { readFileSync, writeFileSync, writeSync, openSync, closeSync } from 'node:fs';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(INPUT_DIR + '/cases.json');
const out = new Out(1 << 20);
const err = new Out(1 << 16);

let pos = 0;
let first = true;
let failed = false;
const fd = openSync(OUTPUT_DIR + '/answers.json', 'w');
try {
  writeSync(fd, '[');
  while (true) {
    const c = findCase(raw, pos);
    if (!c) break;
    pos = c.nextPos;
    const decLen = decodeJsonString(raw, c.textStart, c.textEnd);
    if (decLen < 0) { failed = true; break; }
    runBytes(raw, c.textStart, decLen, c.header, out, err);
    if (!first) writeSync(fd, ',');
    first = false;
    writeSync(fd, out.b.subarray(0, out.n));
  }
  writeSync(fd, ']');
} finally {
  closeSync(fd);
}

if (failed) {
  // Exact fallback: re-read the file (the buffer was partly decoded in
  // place) and answer each case with run() on the parsed JSON.
  const cases = JSON.parse(readFileSync(INPUT_DIR + '/cases.json', 'utf8'));
  const answers = cases.map((k: any) => run(k.input));
  writeFileSync(OUTPUT_DIR + '/answers.json', JSON.stringify(answers));
}
