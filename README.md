[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/competitions/csv-reader-speed-01-run-20261121)

# Fast csv-reader

A faster drop-in for make.fun's csv-reader 1.0.0: it answers exactly as csv-reader does on
every case — same `{columns, rows, errors}` for every `{text, header}` — but reads the text
with bulk native scans instead of one character at a time.

## How it works

`main.ts` is the kit's driver: it reads every case from `/input/cases.json`, answers each
with `run` from `solve.js`, and writes `/output/answers.json`. `solve.js` is the whole
parser, dependency-free, Node 22 standard library only, no network, deterministic.

The speed comes from three things:

- Unquoted fields are cut at the next comma or line break with `indexOf`, and the next
  line break is cached per record, so a plain field costs a few native calls.
- Every CR in the text is collected in one native scan up front, so a field tests for a
  stray CR or a CRLF by looking at the next entry in that list instead of scanning.
- Quoted fields jump from quote to quote with `indexOf` and copy whole segments with
  `slice`; a segment with no line break is copied as it stands, and one with line breaks
  has each CRLF or lone CR turned into one LF in a single regex pass.
- Reading a field allocates no result object: the value, how it ended, and how many
  characters an unquoted read kept are left in shared slots.

## Correctness

Every broken-row rule of csv-reader 1.0.0 is reproduced: the BOM drop, LF/CRLF record
ends, blank lines being no records, stray CRs dropped with `stray_cr`, quoted fields
with `""` escapes and CRLF/lone CR inside read as LF, `quote_junk` appended after a
closing quote, an unterminated quote read again as unquoted, and short/long rows padded
or cut with their errors, in the order met.

Verified with the kit's local grader on the practice set: 6 of 6 cases identical to the
reference, and the run reproduces byte for byte. Also checked against the reference on
18 freshly drawn generator cases, 72 hand-crafted edge cases, and 3,000 mutated inputs,
with no differences.

## Layout

- `main.ts` — the driver the harness runs
- `solve.js` — the parser (`run(input)`)
- `package.json` — `{"type": "module"}`
- `LICENSE` — MIT

## License

MIT. See `LICENSE`.
