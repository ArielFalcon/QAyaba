/* What a run of the tests leaves in a directory is the agent's to shape, and the directory can hold more entries than any run makes. The reader lists it entry by entry up to a cap; a directory with more is cut there. A set of files that measures a whole (`readRunOutputDir`) is not used at all when it was cut, so its files are not even read; a set whose files each stand alone (`scanRunOutputDir`) is read up to the cap when the caller asks for it, and is otherwise left unread and said to be cut. Every case runs against real files under os.tmpdir(). */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunOutputDir, scanRunOutputDir, type RunOutputLimits } from "../../src/shared-infrastructure/run-output-reader.ts";

function withDir(run: (root: { mirrorDir: string; specDir: string }, rel: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "qa-run-output-"));
  try {
    mkdirSync(join(tmp, "out"));
    for (const name of ["a.json", "b.json", "c.json"]) writeFileSync(join(tmp, "out", name), `"${name}"`);
    run({ mirrorDir: tmp, specDir: tmp }, "out");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const everything = (name: string): boolean => name.endsWith(".json");
const LIMITS = (maxFiles: number): RunOutputLimits => ({ maxFileBytes: 1024, maxTotalBytes: 1024 * 1024, maxFiles });

function quiet<T>(run: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    return { value: run(), warnings };
  } finally {
    warn.mock.restore();
  }
}

test("a set used whole is not read at all when the directory holds more entries than the cap: no file is decoded, and the cut is said once", () => {
  withDir((root, rel) => {
    const decoded: string[] = [];

    const { value, warnings } = quiet(() => readRunOutputDir(root, rel, everything, (name) => { decoded.push(name); return name; }, LIMITS(2)));

    assert.equal(value, undefined);
    assert.deepEqual(decoded, [], "none of the files a cut set holds is read");
    assert.equal(warnings.length, 1);
  });
});

test("a set used whole is decoded when the directory holds exactly the cap", () => {
  withDir((root, rel) => {
    const { value, warnings } = quiet(() => readRunOutputDir(root, rel, everything, (name) => name, LIMITS(3)));

    assert.deepEqual(value, ["a.json", "b.json", "c.json"]);
    assert.deepEqual(warnings, []);
  });
});

test("a scan that does not read a cut directory says so and leaves everything unread; one that does reads what it looked at", () => {
  withDir((root, rel) => {
    const decoded: string[] = [];
    const decode = (name: string): string => { decoded.push(name); return name; };

    const unread = scanRunOutputDir(root, rel, everything, decode, LIMITS(2), { readCut: false });
    const none = decoded.length;
    const read = scanRunOutputDir(root, rel, everything, decode, LIMITS(2), { readCut: true });

    assert.deepEqual(unread, { files: [], leftOut: [], cut: true });
    assert.equal(none, 0, "a cut directory is left unread when the caller wants it whole or not at all");
    assert.ok("files" in read && read.cut && read.leftOut.length === 0 && read.files.length === 2, "two of the three were looked at, whichever the filesystem gave first, and decoded");
    assert.equal(decoded.length, 2);
  });
});

test("a scan of a directory that is whole reads every file whether or not the caller reads a cut one", () => {
  withDir((root, rel) => {
    for (const readCut of [false, true]) {
      assert.deepEqual(scanRunOutputDir(root, rel, everything, (name) => name, LIMITS(3), { readCut }), { files: ["a.json", "b.json", "c.json"], leftOut: [], cut: false }, `readCut ${readCut}`);
    }
  });
});

test("a directory that is not there is absent in a scan and no output in a set used whole", () => {
  withDir((root) => {
    assert.deepEqual(scanRunOutputDir(root, "missing", everything, (name) => name, LIMITS(3), { readCut: false }), { absent: true });
    assert.deepEqual(readRunOutputDir(root, "missing", everything, (name) => name, LIMITS(3)), []);
  });
});
