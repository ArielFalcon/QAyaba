/* What a V8 coverage dump says of the changed files: the lines of a changed file that have a byte that ran, whether the script is served at the file's own URL or is a bundle whose source map says where its bytes came from. A dump is written by code the agent wrote, so decoding it must cost what the dump weighs and not what its numbers say: ranges that each cover the whole script, a script of line breaks and a source map of a million segments are bounded, and a dump past a bound is not decoded (which leaves the set of dumps unused, never a ratio of a part). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_V8_COVERED_LINES_PER_FILE, MAX_V8_SCRIPT_LINES, defaultParseV8Coverage } from "@contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts";

type Range = { startOffset: number; endOffset: number; count: number };

const range = (startOffset: number, endOffset: number, count = 1): Range => ({ startOffset, endOffset, count });
const covering = (...ranges: Range[]) => [{ ranges }];

/* The lines (1-based, sorted) a file of `entries` is covered on. */
function linesOf(entries: unknown[], changed: string[], file: string): number[] {
  const covered = defaultParseV8Coverage(entries as never, changed).get(file);
  return covered ? [...covered].sort((a, b) => a - b) : [];
}

/* "line one\nline two\nline three\n": line 1 is bytes 0..8 (its break is byte 8), line 2 is 9..17, line 3 is 18..28. */
const SOURCE = "line one\nline two\nline three\n";
const OWN = (functions: unknown, source = SOURCE) => [{ url: "https://dev.example/src/svc.ts", source, functions }];

test("a script served at a changed file's own URL is covered on every line that has a byte that ran, once per line however many of its bytes ran", () => {
  assert.deepEqual(linesOf(OWN(covering(range(0, 3), range(4, 6), range(20, 22))), ["src/svc.ts"], "src/svc.ts"), [1, 3]);
});

test("a later range decides a byte over the earlier ones where they overlap, and a byte no range covers did not run", () => {
  const whole = range(0, SOURCE.length, 3);
  const hole = range(9, 18, 0);
  const again = range(10, 12, 2);

  assert.deepEqual(linesOf(OWN(covering(whole, hole)), ["src/svc.ts"], "src/svc.ts"), [1, 3], "a nested range that did not run uncovers its bytes");
  assert.deepEqual(linesOf(OWN(covering(whole, hole, again)), ["src/svc.ts"], "src/svc.ts"), [1, 2, 3], "and a range after it covers them again");
  assert.deepEqual(linesOf(OWN(covering(range(9, 18, 0), range(0, SOURCE.length, 1))), ["src/svc.ts"], "src/svc.ts"), [1, 2, 3], "the order of the ranges decides, not their size");
  assert.deepEqual(linesOf(OWN([...covering(range(0, 10, 1)), ...covering(range(5, 14, 0))]), ["src/svc.ts"], "src/svc.ts"), [1], "ranges of different functions are in one order");
});

test("the line break ends the line it is the last byte of: a range over it covers that line and not the next", () => {
  assert.deepEqual(linesOf(OWN(covering(range(8, 9))), ["src/svc.ts"], "src/svc.ts"), [1]);
  assert.deepEqual(linesOf(OWN(covering(range(9, 10))), ["src/svc.ts"], "src/svc.ts"), [2]);
  assert.deepEqual(linesOf(OWN(covering(range(SOURCE.length - 1, SOURCE.length))), ["src/svc.ts"], "src/svc.ts"), [3], "the last byte of the script");
});

test("a range reaches only the bytes of the script: what is before it or past its end is clamped, and an empty, inverted or fractional range reaches none", () => {
  const f = (...ranges: Range[]) => linesOf(OWN(covering(...ranges)), ["src/svc.ts"], "src/svc.ts");

  assert.deepEqual(f(range(-50, 3)), [1], "before the start");
  assert.deepEqual(f(range(20, 5000)), [3], "past the end");
  assert.deepEqual(f(range(-100, -50), range(SOURCE.length + 10, SOURCE.length + 20)), [], "entirely outside");
  assert.deepEqual(f(range(5, 5), range(12, 3)), [], "empty and inverted");
  assert.deepEqual(f(range(0.5, 3), range(0, 2.5)), [], "an offset that is not a whole number");
  assert.deepEqual(f(range(Number.NaN, 3), range(0, Number.POSITIVE_INFINITY)), [], "an offset that is no number a script has");
});

test("a count above nothing ran, and a count of nothing or less did not", () => {
  const f = (count: number) => linesOf(OWN(covering(range(0, 3, count))), ["src/svc.ts"], "src/svc.ts");

  assert.deepEqual([f(1), f(2_000_000)], [[1], [1]]);
  assert.deepEqual([f(0), f(-1)], [[], []]);
});

test("a script with nothing in it, or no ranges, or no functions covers nothing", () => {
  assert.equal(defaultParseV8Coverage(OWN(covering(range(0, 3)), "") as never, ["src/svc.ts"]).size, 0);
  assert.equal(defaultParseV8Coverage(OWN(covering()) as never, ["src/svc.ts"]).size, 0);
  assert.equal(defaultParseV8Coverage(OWN([]) as never, ["src/svc.ts"]).size, 0);
  assert.equal(defaultParseV8Coverage(OWN(undefined) as never, ["src/svc.ts"]).size, 0);
});

test("a script that is no changed file and maps to none is not decoded: nothing of it is read, so what is wrong with it is no matter", () => {
  const unrelated = [{ url: "https://dev.example/vendor/other.js", source: SOURCE, functions: 5, map: { sources: ["../vendor/other.ts"], mappings: "AAAA" } }];

  assert.equal(defaultParseV8Coverage(unrelated as never, ["src/svc.ts"]).size, 0);
  assert.throws(() => defaultParseV8Coverage(OWN(5) as never, ["src/svc.ts"]), "while the same fault in a script that is a changed file makes the dump unusable");
});

test("an entry without a script or a URL, or that is no object, is skipped", () => {
  const entries = [null, 7, "x", { url: "https://dev.example/src/svc.ts" }, { source: SOURCE }, { url: 5, source: SOURCE }, { url: "https://dev.example/src/svc.ts", source: 9 }];

  assert.equal(defaultParseV8Coverage(entries as never, ["src/svc.ts"]).size, 0);
});

/* The URL a script is served at is matched to a changed file by the end of its path, either way round. */
test("a script is a changed file when the end of its path is the file's path, or the file's path ends in the script's, and the longest match wins", () => {
  const at = (url: string, changed: string[]) => [...defaultParseV8Coverage([{ url, source: SOURCE, functions: covering(range(0, 3)) }] as never, changed).keys()];

  assert.deepEqual(at("https://dev.example/assets/src/svc.ts", ["src/svc.ts"]), ["src/svc.ts"]);
  assert.deepEqual(at("https://dev.example/svc.ts", ["src/svc.ts"]), ["src/svc.ts"]);
  assert.deepEqual(at("https://dev.example/src/svc.ts", ["other/svc2.ts", "svc.ts", "app/src/svc.ts"]), ["app/src/svc.ts"]);
  assert.deepEqual(at("https://dev.example/src/svc.ts", ["src/other.ts"]), []);
});

/* ── a script served as a bundle, with the source map that says where its bytes came from ─────── */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(n: number): string {
  let rest = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += B64[digit];
  } while (rest > 0);
  return out;
}

/* `mappings` of a source map from generated lines of [column, source, line, column] segments (absolute values), the way a bundler writes them: relative to the one before. */
function mappingsOf(lines: Array<Array<[number, number, number, number]>>): string {
  let source = 0;
  let line = 0;
  let column = 0;
  return lines
    .map((segments) => {
      let genColumn = 0;
      return segments
        .map(([gen, src, origLine, origColumn]) => {
          const text = vlq(gen - genColumn) + vlq(src - source) + vlq(origLine - line) + vlq(origColumn - column);
          [genColumn, source, line, column] = [gen, src, origLine, origColumn];
          return text;
        })
        .join(",");
    })
    .join(";");
}

/* A bundle of three lines of generated code; line 1 is from src/a.ts line 1, line 2 from src/b.ts line 5, line 3 from src/a.ts line 9. */
const BUNDLE = "a();\nb();\nc();\n";
const MAP = (over: Record<string, unknown> = {}) => ({ version: 3, sources: ["../src/a.ts", "../src/b.ts"], mappings: mappingsOf([[[0, 0, 0, 0]], [[0, 1, 4, 0]], [[0, 0, 8, 0]]]), ...over });
const BUNDLED = (functions: unknown, map: unknown = MAP(), source = BUNDLE) => [{ url: "https://dev.example/assets/main.js", source, functions, map }];

test("a bundle covers the lines of the changed files its covered bytes come from, and only those", () => {
  const covered = defaultParseV8Coverage(BUNDLED(covering(range(0, 5), range(10, 15))) as never, ["src/a.ts", "src/b.ts"]);

  assert.deepEqual([...covered.get("src/a.ts")!].sort(), [1, 9].sort(), "generated lines 1 and 3 are from a.ts lines 1 and 9");
  assert.equal(covered.has("src/b.ts"), false, "generated line 2 did not run");
  assert.deepEqual(defaultParseV8Coverage(BUNDLED(covering(range(0, 5), range(10, 15))) as never, ["src/b.ts"]).size, 0, "and a source that is not a changed file is not in it");
});

test("a bundle covers a changed file on the line of each segment whose generated byte ran, whatever else the line holds", () => {
  const map = MAP({ mappings: mappingsOf([[[0, 0, 0, 0], [2, 0, 3, 0]], [[0, 1, 4, 0]]]) });
  const source = "a();b();\nc();\n";

  assert.deepEqual([...defaultParseV8Coverage(BUNDLED(covering(range(0, 1)), map, source) as never, ["src/a.ts"]).get("src/a.ts")!], [1], "the first segment's byte ran");
  assert.deepEqual([...defaultParseV8Coverage(BUNDLED(covering(range(2, 3)), map, source) as never, ["src/a.ts"]).get("src/a.ts")!], [4], "the second segment's byte ran");
  assert.equal(defaultParseV8Coverage(BUNDLED(covering(range(1, 2)), map, source) as never, ["src/a.ts"]).size, 0, "a byte between the two that ran belongs to neither");
});

test("a source path is matched to a changed file after the source root is put before it and the scheme, the dot segments and the leading separators are taken off", () => {
  const covered = (sources: string[], sourceRoot?: string) =>
    [...defaultParseV8Coverage(BUNDLED(covering(range(0, BUNDLE.length)), MAP({ sources, ...(sourceRoot ? { sourceRoot } : {}) })) as never, ["src/a.ts"]).keys()];

  assert.deepEqual(covered(["../src/a.ts", "../src/b.ts"]), ["src/a.ts"]);
  assert.deepEqual(covered(["webpack:///src/a.ts", "x"]), ["src/a.ts"]);
  assert.deepEqual(covered(["./src/a.ts", "x"]), ["src/a.ts"]);
  assert.deepEqual(covered(["a.ts", "x"], "src/"), ["src/a.ts"]);
  assert.deepEqual(covered(["/src/a.ts", "x"]), ["src/a.ts"]);
  assert.deepEqual(covered(["../vendor/a.ts", "x"]), [], "another file");
});

test("a segment with fewer than four fields moves the generated column and maps nothing, and the segments around it still do", () => {
  /* On line 1 the first segment has one field (column 4), and the second maps column 4 + 0... to src/a.ts line 7. */
  const mappings = `${vlq(4)},${vlq(0)}${vlq(0)}${vlq(6)}${vlq(0)}`;

  const covered = defaultParseV8Coverage(BUNDLED(covering(range(0, BUNDLE.length)), MAP({ sources: ["../src/a.ts"], mappings }), "abcdefgh();\n") as never, ["src/a.ts"]);

  assert.deepEqual([...covered.get("src/a.ts")!], [7]);
});

test("a segment past the last generated line or past the end of its line is no coverage, and a source index the map does not have is none", () => {
  const map = (mappings: string) => MAP({ sources: ["../src/a.ts"], mappings });

  assert.equal(defaultParseV8Coverage(BUNDLED(covering(range(0, BUNDLE.length)), map(`${mappingsOf([[], [], [], [], [[0, 0, 0, 0]]])}`)) as never, ["src/a.ts"]).size, 0, "line 5 of a script of 3");
  assert.equal(defaultParseV8Coverage(BUNDLED(covering(range(0, BUNDLE.length)), map(mappingsOf([[[900, 0, 0, 0]]]))) as never, ["src/a.ts"]).size, 0, "column 900 of a line of 4 bytes");
  assert.equal(defaultParseV8Coverage(BUNDLED(covering(range(0, BUNDLE.length)), map(mappingsOf([[[0, 5, 0, 0]]]))) as never, ["src/a.ts"]).size, 0, "a source the map does not list");
});

test("a bundle whose map is missing, has no mappings, or has no list of sources is skipped, and a script that is a changed file is not read through its map", () => {
  for (const map of [null, { sources: ["../src/a.ts"] }, { sources: ["../src/a.ts"], mappings: "" }, { mappings: "AAAA", sources: "../src/a.ts" }]) {
    assert.equal(defaultParseV8Coverage(BUNDLED(covering(range(0, BUNDLE.length)), map) as never, ["src/a.ts"]).size, 0, JSON.stringify(map));
  }
  const own = [{ url: "https://dev.example/src/a.ts", source: BUNDLE, functions: covering(range(0, 5)), map: MAP({ sources: ["../src/b.ts"] }) }];
  assert.deepEqual([...defaultParseV8Coverage(own as never, ["src/a.ts", "src/b.ts"]).keys()], ["src/a.ts"], "its own URL decides, not what its map says");
});

test("the dumps of two scripts of one dump add up, and a file is covered on the lines of both", () => {
  const entries = [
    { url: "https://dev.example/src/svc.ts", source: SOURCE, functions: covering(range(0, 3)) },
    { url: "https://dev.example/other/src/svc.ts", source: SOURCE, functions: covering(range(20, 22)) },
  ];

  assert.deepEqual(linesOf(entries, ["src/svc.ts"], "src/svc.ts"), [1, 3]);
});

/* ── what decoding costs ───────────────────────────────────────────────────────────────────────── */

/* The reference: the bytes of a script painted range by range in order, a later range over an earlier one. */
function reference(length: number, ranges: Range[]): Uint8Array {
  const ran = new Uint8Array(length);
  for (const r of ranges) {
    const start = Math.max(0, r.startOffset);
    const end = Math.min(length, r.endOffset);
    for (let i = start; i < end; i++) ran[i] = r.count > 0 ? 1 : 0;
  }
  return ran;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("the bytes that ran are the same as painting the ranges one by one in order, over scripts and ranges chosen at random", () => {
  const random = mulberry32(20260511);
  for (let round = 0; round < 400; round++) {
    const lines = Array.from({ length: 1 + Math.floor(random() * 6) }, () => "x".repeat(Math.floor(random() * 9)));
    const source = `${lines.join("\n")}${random() < 0.5 ? "\n" : ""}`;
    if (source === "") continue;
    const ranges: Range[] = Array.from({ length: Math.floor(random() * 9) }, () => {
      const start = Math.floor(random() * (source.length + 6)) - 3;
      return range(start, start + Math.floor(random() * 12) - 2, random() < 0.5 ? 0 : 1 + Math.floor(random() * 3));
    });
    const expected = reference(source.length, ranges);
    const starts = [0, ...[...source].flatMap((c, i) => (c === "\n" ? [i + 1] : []))];
    const wantLines = starts.flatMap((from, i) => {
      const to = i + 1 < starts.length ? starts[i + 1]! : source.length;
      return expected.subarray(from, to).includes(1) ? [i + 1] : [];
    });

    const got = linesOf(OWN(ranges.map((r) => ({ ranges: [r] })), source), ["src/svc.ts"], "src/svc.ts");

    assert.deepEqual(got, wantLines, JSON.stringify({ source, ranges }));
  }
});

test("ranges that each cover the whole script cost the script once, not once each: a dump of twenty thousand of them is decoded in moments", { timeout: 60_000 }, () => {
  const source = `${"x".repeat(79)}\n`.repeat(13_000);
  const everything = range(0, source.length);
  const functions = [{ ranges: Array.from({ length: 20_000 }, () => everything) }];
  const started = Date.now();

  const lines = linesOf(OWN(functions, source), ["src/svc.ts"], "src/svc.ts");

  assert.equal(lines.length, 13_000);
  assert.ok(Date.now() - started < 3_000, `decoded in ${Date.now() - started} ms`);
});

test("a script of exactly the most lines is decoded and one line more is not, so a dump of line breaks does not make a list of its own length", () => {
  const entry = (lines: number) => OWN(covering(range(0, 3)), "\n".repeat(lines - 1));

  assert.doesNotThrow(() => defaultParseV8Coverage(entry(MAX_V8_SCRIPT_LINES) as never, ["src/svc.ts"]));
  assert.throws(() => defaultParseV8Coverage(entry(MAX_V8_SCRIPT_LINES + 1) as never, ["src/svc.ts"]));
});

test("a changed file covered on exactly the most lines is decoded and one more makes the dump unusable, so a source map that claims a line for every byte does not make a list of its own length", () => {
  const segments = (count: number): string => {
    let source = "";
    for (let i = 0; i < count; i++) source += `${i === 0 ? "" : ","}${vlq(i === 0 ? 0 : 1)}${vlq(0)}${vlq(1)}${vlq(0)}`;
    return source;
  };
  const bundle = (count: number) => BUNDLED(covering(range(0, count)), MAP({ sources: ["../src/a.ts"], mappings: segments(count) }), "x".repeat(count));

  const exact = defaultParseV8Coverage(bundle(MAX_V8_COVERED_LINES_PER_FILE) as never, ["src/a.ts"]);

  assert.equal(exact.get("src/a.ts")!.size, MAX_V8_COVERED_LINES_PER_FILE);
  assert.throws(() => defaultParseV8Coverage(bundle(MAX_V8_COVERED_LINES_PER_FILE + 1) as never, ["src/a.ts"]));
});

test("the bounds are far beyond any real script: some hundreds of thousands of lines at the most", () => {
  assert.ok(MAX_V8_SCRIPT_LINES >= 500_000 && MAX_V8_SCRIPT_LINES <= 10_000_000, `${MAX_V8_SCRIPT_LINES}`);
  assert.ok(MAX_V8_COVERED_LINES_PER_FILE >= 500_000 && MAX_V8_COVERED_LINES_PER_FILE <= 10_000_000, `${MAX_V8_COVERED_LINES_PER_FILE}`);
});

/* ── what is read of a source map's numbers ────────────────────────────────────────────────────── */

/* What the entries cover, as the lines of each changed file in order. */
const filesOf = (entries: unknown[], changed: string[]): Record<string, number[]> =>
  Object.fromEntries([...defaultParseV8Coverage(entries as never, changed)].map(([file, lines]) => [file, [...lines].sort((a, b) => a - b)]));

test("a number of a source map takes as many digits as it needs and is negative when its low bit says so: a column of hundreds, a line of hundreds and a step back of hundreds", () => {
  const source = "x".repeat(2000);
  /* One generated line: a segment at column 900 from a.ts line 501, then one at column 1500 from line 201, a step of -300 back. */
  const map = MAP({ mappings: mappingsOf([[[900, 0, 500, 0], [1500, 0, 200, 0]]]) });

  assert.deepEqual(filesOf(BUNDLED(covering(range(900, 901)), map, source), ["src/a.ts"]), { "src/a.ts": [501] });
  assert.deepEqual(filesOf(BUNDLED(covering(range(1500, 1501)), map, source), ["src/a.ts"]), { "src/a.ts": [201] });
  assert.deepEqual(filesOf(BUNDLED(covering(range(899, 900), range(901, 1500)), map, source), ["src/a.ts"]), {}, "and no other column is the segment's");
});

test("a character that is no digit of a source map is skipped, wherever it falls in a segment", () => {
  /* "A?CAA" is "ACAA" with a stray character in it: a segment of the second source. */
  const strayed = filesOf(BUNDLED(covering(range(0, 1)), MAP({ mappings: "A?CAA" })), ["src/a.ts", "src/b.ts"]);
  const only = filesOf(BUNDLED(covering(range(0, 1)), MAP({ mappings: "A??" })), ["src/a.ts", "src/b.ts"]);

  assert.deepEqual(strayed, { "src/b.ts": [1] });
  assert.deepEqual(only, {}, "and a segment of nothing else is no segment");
});

test("the column of a segment starts again at every generated line, and a generated line with no segment is still a line", () => {
  /* Line 1 has a segment at column 3, line 2 has none, and line 3 has one at column 0 and one at column 2. */
  const source = "abcdef\n\nxyzxyz\n";
  const map = MAP({ mappings: mappingsOf([[[3, 0, 0, 0]], [], [[0, 1, 4, 0], [2, 1, 6, 0]]]) });
  const covered = (from: number, to: number) => filesOf(BUNDLED(covering(range(from, to)), map, source), ["src/a.ts", "src/b.ts"]);

  assert.deepEqual(covered(3, 4), { "src/a.ts": [1] }, "the first line's segment");
  assert.deepEqual(covered(8, 9), { "src/b.ts": [5] }, "the first segment of the third line, at its own column 0");
  assert.deepEqual(covered(10, 11), { "src/b.ts": [7] }, "and the second, at column 2");
  assert.deepEqual(covered(7, 8), {}, "the empty line holds none");
});

test("a segment of five fields, with the index of a name, maps like one of four, and one of two or three maps nothing", () => {
  const covered = (mappings: string) => filesOf(BUNDLED(covering(range(0, 15)), MAP({ mappings })), ["src/a.ts", "src/b.ts"]);

  assert.deepEqual(covered("AAAAA"), { "src/a.ts": [1] });
  assert.deepEqual(covered("AAAA"), { "src/a.ts": [1] });
  assert.deepEqual(covered("EA,AAA"), {}, "two fields and then three");
  assert.deepEqual(covered("EA,EAA,EAAA"), { "src/a.ts": [1] }, "the segments of two and three fields still move the column: the one of four is at column 6");
});

test("segments with nothing in them are nothing: a comma at the start, a doubled comma and a trailing comma", () => {
  const covered = (mappings: string) => filesOf(BUNDLED(covering(range(0, 15)), MAP({ mappings })), ["src/a.ts", "src/b.ts"]);

  assert.deepEqual(covered(",AAAA,,CCAA,"), { "src/a.ts": [1], "src/b.ts": [1] }, "the segment of the first source and the one a step on, into the second");
  assert.deepEqual(covered(";;,;"), {});
});

/* ── which changed file a URL or a source is ────────────────────────────────────────────────────── */

test("of the changed files a URL matches, the one with the most in common with it is the file, whatever the order they are listed in", () => {
  const at = (changed: string[]) => [...defaultParseV8Coverage([{ url: "https://dev.example/a/b.ts", source: SOURCE, functions: covering(range(0, 3)) }] as never, changed).keys()];

  assert.deepEqual(at(["b.ts", "a/b.ts"]), ["a/b.ts"]);
  assert.deepEqual(at(["a/b.ts", "b.ts"]), ["a/b.ts"]);
});

test("a URL matches a changed file by whole names of its path: a name that only ends the same way is another file, and any number of separators before the path are none", () => {
  const at = (url: string, changed: string[]) => [...defaultParseV8Coverage([{ url, source: SOURCE, functions: covering(range(0, 3)) }] as never, changed).keys()];

  assert.deepEqual(at("https://dev.example/xsrc/svc.ts", ["src/svc.ts"]), [], "a script whose path ends in the file's path, but in the middle of a name");
  assert.deepEqual(at("https://dev.example/svc.ts", ["src/xsvc.ts"]), [], "and a file whose path ends in the script's, but in the middle of a name");
  assert.deepEqual(at("https://dev.example//svc.ts", ["src/svc.ts"]), ["src/svc.ts"], "a doubled separator before the path");
  assert.deepEqual(at("src/svc.ts", ["src/svc.ts"]), ["src/svc.ts"], "a script that is the file's path");
});

test("of changed files that match a URL equally well, the first listed is the file", () => {
  const at = (changed: string[]) => [...defaultParseV8Coverage([{ url: "https://dev.example/svc.ts", source: SOURCE, functions: covering(range(0, 3)) }] as never, changed).keys()];

  assert.deepEqual(at(["a/svc.ts", "b/svc.ts"]), ["a/svc.ts"]);
  assert.deepEqual(at(["b/svc.ts", "a/svc.ts"]), ["b/svc.ts"]);
});

test("backslashes are separators in a changed file and in a script that is no URL, and the file keeps the spelling it was given", () => {
  const entry = (url: string) => [{ url, source: SOURCE, functions: covering(range(0, 3)) }];

  assert.deepEqual([...defaultParseV8Coverage(entry("https://dev.example/src/svc.ts") as never, ["src\\svc.ts"]).keys()], ["src\\svc.ts"]);
  assert.deepEqual([...defaultParseV8Coverage(entry("src\\svc.ts") as never, ["src/svc.ts"]).keys()], ["src/svc.ts"]);
});

test("a source root is put before a source with one separator between them, whether the root ends in one or the source starts with one", () => {
  /* Two changed files share a name: only the root says which one the source is. */
  const covered = (sources: string[], sourceRoot: string) => Object.keys(filesOf(BUNDLED(covering(range(0, BUNDLE.length)), MAP({ sources, sourceRoot })), ["src/a.ts", "lib/a.ts"]));

  assert.deepEqual(covered(["a.ts", "x"], "lib"), ["lib/a.ts"]);
  assert.deepEqual(covered(["a.ts", "x"], "lib/"), ["lib/a.ts"]);
  assert.deepEqual(covered(["/a.ts", "x"], "lib"), ["lib/a.ts"]);
  assert.deepEqual(covered(["/a.ts", "x"], "lib/"), ["lib/a.ts"]);
  assert.deepEqual(covered(["a.ts", "x"], ""), ["src/a.ts"], "an empty root is no root: the source is a.ts, which the first of the two files listed is");
});

test("a source root and a source keep the separators inside them, and only the one between them is made", () => {
  const covered = (sources: string[], sourceRoot: string, changed: string[]) => Object.keys(filesOf(BUNDLED(covering(range(0, BUNDLE.length)), MAP({ sources, sourceRoot })), changed));

  assert.deepEqual(covered(["pkg/a.ts", "x"], "lib", ["src/pkg/a.ts", "lib/pkg/a.ts"]), ["lib/pkg/a.ts"], "a source with a separator in it");
  assert.deepEqual(covered(["a.ts", "x"], "app/lib", ["src/a.ts", "app/lib/a.ts"]), ["app/lib/a.ts"], "a root with a separator in it");
  assert.deepEqual(covered(["a.ts", "x"], "app/lib/", ["src/a.ts", "app/lib/a.ts"]), ["app/lib/a.ts"], "and one that ends in one");
});

test("an entry with no URL is skipped", () => {
  assert.equal(defaultParseV8Coverage([{ url: "", source: SOURCE, functions: covering(range(0, 3)) }] as never, ["svc.ts", ""]).size, 0);
});
