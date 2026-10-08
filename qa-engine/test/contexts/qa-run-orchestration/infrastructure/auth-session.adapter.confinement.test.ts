/* Before a form login is attempted, the adapter asks whether e2e/auth.setup.ts is the stock seed or a login written for the app, and it asks after the agent has run: the file is in a directory the agent writes into, so an agent that put a named pipe there would hold the whole orchestrator for ever, and one that put a link there would have the orchestrator judge a file of its choosing. The file is read strictly: a file it cannot vouch for fails the login aloud, which the run reports as an infra-error, and nothing is spawned for it. Every case runs against real files, links and pipes under os.tmpdir(); the pipe case runs under the watch of test/support/named-pipe-watch.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthSessionAdapter } from "@contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts";
import { ConfinedPathError, MAX_SPEC_SOURCE_BYTES } from "../../../../src/shared-infrastructure/spec-path-confinement.ts";
import { withoutWaitingOnNamedPipe } from "../../../support/named-pipe-watch.ts";

/* The login seed as it ships today. */
const SEED = readFileSync(fileURLToPath(new URL("../../../../../config/e2e/auth.setup.ts", import.meta.url)), "utf8");
const SECRET_MARK = "SECRETv1-hunter2";
const APP_LOGIN = "/* a login written for the app */\n";

interface Dirs {
  specDir: string;
  outside: string;
  authDir: string;
}

async function withDirs(run: (d: Dirs) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-auth-confined-"));
  const specDir = join(tmp, "e2e");
  const outside = join(tmp, "outside");
  const authDir = join(tmp, "auth");
  mkdirSync(specDir);
  mkdirSync(outside);
  try {
    await run({ specDir, outside, authDir });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-auth-confined-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(dir, "probe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_NAMED_PIPES = canMakeNamedPipes() ? false : "mkfifo is not available on this platform, so the named-pipe case is not exercised";

/* An adapter whose setup spawn is counted, and a login attempt the way the run makes one. */
function attempt(d: Dirs, phase: "pre-generate" | "pre-execute" = "pre-generate"): { spawned: () => number; prepare: () => Promise<{ unauthored: boolean }> } {
  let spawns = 0;
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: "u", QA_PASS: "p" },
    authDir: d.authDir,
    spawnSetup: async () => {
      spawns += 1;
      return { exitCode: 1, logs: "the setup ran and did not log in" };
    },
  });
  return {
    spawned: () => spawns,
    prepare: () => adapter.prepare({ specDir: d.specDir, baseUrl: "https://dev.example", phase, auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } }),
  };
}

/* A refusal is the module's own error: it names the file and says why. */
const refusedAt = (path: string) => (err: unknown): boolean => err instanceof ConfinedPathError && err.path === path && err.reason !== "";

test("an auth.setup.ts that is a named pipe fails the login and is not waited on, and no setup is spawned", { skip: NO_NAMED_PIPES }, async () => {
  await withDirs(async (d) => {
    const file = join(d.specDir, "auth.setup.ts");
    execFileSync("mkfifo", [file]);
    const login = attempt(d);

    await withoutWaitingOnNamedPipe(file, () => assert.rejects(login.prepare, refusedAt(file)));

    assert.equal(login.spawned(), 0);
  });
});

test("an auth.setup.ts that is a link fails the login, though the file it points at is the stock seed, and no setup is spawned", async () => {
  await withDirs(async (d) => {
    const file = join(d.specDir, "auth.setup.ts");
    writeFileSync(join(d.outside, "login.ts"), SEED);
    symlinkSync(join(d.outside, "login.ts"), file);
    const login = attempt(d);

    await assert.rejects(login.prepare, refusedAt(file));

    assert.equal(login.spawned(), 0);
  });
});

test("an auth.setup.ts that is a directory fails the login", async () => {
  await withDirs(async (d) => {
    mkdirSync(join(d.specDir, "auth.setup.ts"));

    await assert.rejects(attempt(d).prepare, refusedAt(join(d.specDir, "auth.setup.ts")));
  });
});

test("an auth.setup.ts that is not read fails the login the same way before the run and before the execution", async () => {
  await withDirs(async (d) => {
    symlinkSync(join(d.outside, "login.ts"), join(d.specDir, "auth.setup.ts"));

    for (const phase of ["pre-generate", "pre-execute"] as const) {
      await assert.rejects(attempt(d, phase).prepare, refusedAt(join(d.specDir, "auth.setup.ts")), phase);
    }
  });
});

test("an auth.setup.ts larger than a source file's cap fails the login, and one of exactly the cap is a login written for the app", async () => {
  await withDirs(async (d) => {
    const file = join(d.specDir, "auth.setup.ts");
    writeFileSync(file, "x".repeat(MAX_SPEC_SOURCE_BYTES + 1));
    const over = attempt(d);
    await assert.rejects(over.prepare, refusedAt(file));
    assert.equal(over.spawned(), 0);

    writeFileSync(file, "x".repeat(MAX_SPEC_SOURCE_BYTES));
    const exact = attempt(d);
    await assert.rejects(exact.prepare, /the setup ran and did not log in/, "an app's own login whose setup fails is an error, not a fail-open");
    assert.equal(exact.spawned(), 1, "exactly the cap was read, and judged not stock");
  });
});

test("the refusal names the file and says why, and quotes nothing of what the file it points at holds", async () => {
  await withDirs(async (d) => {
    writeFileSync(join(d.outside, "secret.env"), `${SECRET_MARK}=hunter2`);
    symlinkSync(join(d.outside, "secret.env"), join(d.specDir, "auth.setup.ts"));

    let message = "";
    await attempt(d).prepare().catch((err: unknown) => {
      message = err instanceof Error ? err.message : String(err);
    });

    assert.ok(message.includes(join(d.specDir, "auth.setup.ts")), `the message names the file: ${message}`);
    assert.ok(!message.includes(SECRET_MARK) && !message.includes("hunter2"), "no character of the file behind the link is quoted");
  });
});

/* The stock check itself is unchanged: a missing file and a byte-for-byte shipped seed are stock, anything else is the app's own. */
test("a missing auth.setup.ts and a shipped seed are stock, so a login that fails before generation is left to generation, and an app's own login that fails is an error", async () => {
  await withDirs(async (d) => {
    assert.deepEqual(await attempt({ ...d, specDir: join(d.specDir, "not-made-yet") }).prepare(), { unauthored: true }, "no spec directory yet: there is no login of the app's own, so stock");
    assert.deepEqual(await attempt(d).prepare(), { unauthored: true }, "no file: stock");

    writeFileSync(join(d.specDir, "auth.setup.ts"), SEED);
    assert.deepEqual(await attempt(d).prepare(), { unauthored: true }, "the shipped seed: stock");

    writeFileSync(join(d.specDir, "auth.setup.ts"), APP_LOGIN);
    await assert.rejects(attempt(d).prepare, /the setup ran and did not log in/, "a login written for the app: not stock");
  });
});
