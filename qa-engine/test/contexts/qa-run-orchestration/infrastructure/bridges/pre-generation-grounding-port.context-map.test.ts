/* The architecture map, `.qa/context.json`, is what the agent writes in context mode and what the orchestrator reads back: from a directory the agent writes into, so a link or a named pipe planted at the file or at `.qa` must not be followed or waited on, and nothing the file holds may be quoted in a warning, which goes to logs and to Issues. Every case runs against real files, links and pipes under os.tmpdir(). */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_CONTEXT_MAP_BYTES,
  loadContextMapFromDisk,
} from "@contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter.ts";
import { defaultSpecReadDeps } from "../../../../../src/shared-infrastructure/spec-path-confinement.ts";
import { withoutWaitingOnNamedPipe } from "../../../../support/named-pipe-watch.ts";

const VALID_CONTEXT = {
  builtAtSha: "abc1234",
  routes: [{ path: "/owners" }],
  api: [{ operationId: "getOwners", method: "GET", path: "/api/owners" }],
  feBe: [{ route: "/owners", operationId: "getOwners" }],
};
/* Short enough to sit whole inside the first characters of a file, which is all a JSON parse error quotes. */
const SECRET_MARK = "SECRETv1";

/* <tmp>/e2e is the spec directory; <tmp>/outside is what no read may reach. */
async function withSuite(run: (e2e: string, outside: string) => Promise<void> | void): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-context-map-"));
  const e2e = join(tmp, "e2e");
  const outside = join(tmp, "outside");
  mkdirSync(e2e);
  mkdirSync(outside);
  try {
    await run(e2e, outside);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function load(e2e: string): { map: ReturnType<typeof loadContextMapFromDisk>; warnings: string[] } {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    return { map: loadContextMapFromDisk(e2e), warnings };
  } finally {
    warn.mock.restore();
  }
}

const contextPath = (e2e: string): string => join(e2e, ".qa", "context.json");
const writeContext = (e2e: string, text: string): void => {
  mkdirSync(join(e2e, ".qa"), { recursive: true });
  writeFileSync(contextPath(e2e), text);
};

const NO_NAMED_PIPES = (() => {
  const probe = mkdtempSync(join(tmpdir(), "qa-context-map-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(probe, "p")]);
    return false as const;
  } catch {
    return "mkfifo is not available on this platform, so the named-pipe case is not exercised";
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/* A file whose mode is 000 cannot be read by an account that the mode binds: not by root, and not on a platform without modes. */
const NO_MODE_RESTRICTIONS = process.platform === "win32" || process.getuid?.() === 0 ? "the account that runs the tests is not bound by file modes, so the case that relies on them is not exercised" : false;

test("a valid context map is returned, and nothing is said", async () => {
  await withSuite((e2e) => {
    writeContext(e2e, JSON.stringify(VALID_CONTEXT));

    const { map, warnings } = load(e2e);

    assert.deepEqual(map, VALID_CONTEXT);
    assert.deepEqual(warnings, []);
  });
});

test("a context map that is not there is no map, and nothing is said: the first run of an app has none", async () => {
  await withSuite((e2e) => {
    const missingFile = load(e2e);
    mkdirSync(join(e2e, ".qa"));
    const missingDirectory = load(e2e);

    assert.equal(missingFile.map, undefined);
    assert.equal(missingDirectory.map, undefined);
    assert.deepEqual([...missingFile.warnings, ...missingDirectory.warnings], []);
  });
});

test("a context map reached through a symlink is no map, said aloud, whatever the link points at", async () => {
  await withSuite((e2e, outside) => {
    mkdirSync(join(e2e, ".qa"));
    writeFileSync(join(outside, "valid.json"), JSON.stringify(VALID_CONTEXT));
    writeFileSync(join(e2e, "inside.json"), JSON.stringify(VALID_CONTEXT));
    for (const target of [join(outside, "valid.json"), join(e2e, "inside.json"), join(outside, "no-such-file")]) {
      symlinkSync(target, contextPath(e2e));

      const { map, warnings } = load(e2e);

      assert.equal(map, undefined, `the link to ${target} is not read`);
      assert.ok(warnings.some((w) => w.includes(contextPath(e2e))), `a warning names the file: ${JSON.stringify(warnings)}`);
      rmSync(contextPath(e2e));
    }
  });
});

test("a .qa directory that is a symlink is no map, though the map behind it is valid", async () => {
  await withSuite((e2e, outside) => {
    mkdirSync(join(outside, "qa"));
    writeFileSync(join(outside, "qa", "context.json"), JSON.stringify(VALID_CONTEXT));
    symlinkSync(join(outside, "qa"), join(e2e, ".qa"));

    const { map, warnings } = load(e2e);

    assert.equal(map, undefined);
    assert.ok(warnings.some((w) => w.includes(contextPath(e2e))));
  });
});

test("a context map that is a directory, or whose directory is a regular file, is no map, said aloud", async () => {
  await withSuite((e2e) => {
    mkdirSync(contextPath(e2e), { recursive: true });
    const asDirectory = load(e2e);
    rmSync(join(e2e, ".qa"), { recursive: true });
    writeFileSync(join(e2e, ".qa"), "not a directory");
    const asFile = load(e2e);

    for (const { map, warnings } of [asDirectory, asFile]) {
      assert.equal(map, undefined);
      assert.ok(warnings.some((w) => w.includes(contextPath(e2e))), JSON.stringify(warnings));
    }
    assert.notEqual(asDirectory.warnings.join("\n"), asFile.warnings.join("\n"), "two different refusals are not told in the same words: each says why");
  });
});

test("a context map that is a named pipe is no map, said aloud, and the read does not wait on it", { skip: NO_NAMED_PIPES }, async () => {
  await withSuite(async (e2e) => {
    mkdirSync(join(e2e, ".qa"));
    execFileSync("mkfifo", [contextPath(e2e)]);

    const { map, warnings } = await withoutWaitingOnNamedPipe(contextPath(e2e), () => load(e2e));

    assert.equal(map, undefined);
    assert.ok(warnings.some((w) => w.includes(contextPath(e2e))));
  });
});

test("a context map that cannot be read is no map, said aloud", { skip: NO_MODE_RESTRICTIONS }, async () => {
  await withSuite((e2e) => {
    writeContext(e2e, JSON.stringify(VALID_CONTEXT));
    chmodSync(contextPath(e2e), 0o000);
    try {
      const { map, warnings } = load(e2e);

      assert.equal(map, undefined);
      assert.ok(warnings.some((w) => w.includes(contextPath(e2e)) && w.includes("EACCES")), `a warning names the file and the failure's code: ${JSON.stringify(warnings)}`);
    } finally {
      chmodSync(contextPath(e2e), 0o644);
    }
  });
});

test("a context map larger than the cap is no map, said aloud, and one of exactly the cap is read", async () => {
  await withSuite((e2e) => {
    const padded = (bytes: number): string => {
      const text = JSON.stringify({ ...VALID_CONTEXT, pad: "" });
      return text.replace('"pad":""', `"pad":"${"x".repeat(bytes - text.length)}"`);
    };
    writeContext(e2e, padded(MAX_CONTEXT_MAP_BYTES));
    assert.deepEqual(load(e2e).map?.routes, VALID_CONTEXT.routes, "exactly the cap is read");

    writeContext(e2e, padded(MAX_CONTEXT_MAP_BYTES + 1));
    const { map, warnings } = load(e2e);

    assert.equal(map, undefined);
    assert.ok(warnings.some((w) => w.includes(contextPath(e2e))));
  });
});

test("a context map that is not JSON is no map, and the warning names the file but quotes nothing of what it holds", async () => {
  await withSuite((e2e) => {
    writeContext(e2e, `${SECRET_MARK}=hunter2 { not json`);

    const { map, warnings } = load(e2e);

    assert.equal(map, undefined);
    assert.ok(warnings.some((w) => w.includes(contextPath(e2e))), JSON.stringify(warnings));
    assert.ok(!warnings.join("\n").includes(SECRET_MARK), "no character of the file is quoted");
    assert.ok(!warnings.join("\n").includes("hunter2"));
  });
});

test("a link to a file that is not JSON is no map, and no character of the file it points at reaches a warning", async () => {
  await withSuite((e2e, outside) => {
    mkdirSync(join(e2e, ".qa"));
    writeFileSync(join(outside, "secret.env"), `${SECRET_MARK}=hunter2`);
    symlinkSync(join(outside, "secret.env"), contextPath(e2e));

    const { map, warnings } = load(e2e);

    assert.equal(map, undefined);
    assert.ok(!warnings.join("\n").includes(SECRET_MARK));
    assert.ok(!warnings.join("\n").includes("hunter2"));
  });
});

test("a context map that fails the form validation is no map, said aloud, naming the file", async () => {
  await withSuite((e2e) => {
    writeContext(e2e, JSON.stringify({ ...VALID_CONTEXT, feBe: [{ route: "/missing", operationId: "getOwners" }], note: SECRET_MARK }));

    const { map, warnings } = load(e2e);

    assert.equal(map, undefined);
    assert.ok(warnings.some((w) => w.includes(contextPath(e2e))));
    assert.ok(!warnings.join("\n").includes(SECRET_MARK));
  });
});

test("a context map that is not JSON and one that is JSON but not a map are not told in the same words: each says why", async () => {
  await withSuite((e2e) => {
    writeContext(e2e, "{ not json");
    const notJson = load(e2e);
    writeContext(e2e, JSON.stringify({ ...VALID_CONTEXT, feBe: [{ route: "/missing", operationId: "getOwners" }] }));
    const notAMap = load(e2e);

    assert.equal(notJson.warnings.length, 1);
    assert.equal(notAMap.warnings.length, 1);
    assert.notEqual(notJson.warnings[0], notAMap.warnings[0]);
  });
});

test("a context map that is JSON but not an object is no map", async () => {
  await withSuite((e2e) => {
    for (const text of ["null", "[]", "42", '"text"']) {
      writeContext(e2e, text);
      assert.equal(load(e2e).map, undefined, text);
    }
  });
});

/* A failure that is not a call's own has no code: the warning must not say "undefined", and an error's message can quote what was read. */
test("a context map whose read fails with no code is no map, said by a fixed reason: not 'undefined', and not the failure's message", async () => {
  await withSuite((e2e) => {
    writeContext(e2e, JSON.stringify(VALID_CONTEXT));
    const open = mock.method(defaultSpecReadDeps, "open", () => {
      throw new TypeError(`a failure that is not a call's own, quoting ${SECRET_MARK}`);
    });
    try {
      const { map, warnings } = load(e2e);

      assert.equal(map, undefined);
      const warning = warnings.find((w) => w.includes(contextPath(e2e)));
      assert.ok(warning, JSON.stringify(warnings));
      assert.ok(!warning.includes("undefined"), warning);
      assert.ok(!warning.includes(SECRET_MARK) && !warning.includes("not a call's own"), "the failure's message is not quoted");
    } finally {
      open.mock.restore();
    }
  });
});
