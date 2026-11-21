# csv-reader-speed-01 — Fast exact csv-reader drop-in

[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/jonjet155/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/jonjet155/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0: `solve.js` answers exactly as csv-reader
does on every case — same columns, rows and broken-row errors — but parses with
native `indexOf` / `slice` / `split` fast paths instead of one character at a
time. `main.ts` is the driver: it reads `/input/cases.json` and writes
`/output/answers.json`.
