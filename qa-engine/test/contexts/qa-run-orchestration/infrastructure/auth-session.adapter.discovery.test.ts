import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRECONDITION_KIND, AuthPreconditionError } from "@contexts/qa-run-orchestration/domain/auth-precondition.ts";
import { AuthSessionAdapter, type AuthDiscoveryDeps } from "@contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts";
import type { LoginDiscoveryInput, LoginDiscoveryResult } from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.runner.ts";
import { AUTH_RESOLUTION_METHOD, type AuthDeclaration, type AuthSessionRequest } from "@contexts/qa-run-orchestration/application/ports/auth-session.port.ts";
import { AUTH_MATERIAL_FILES } from "../../../../src/shared-infrastructure/process-sandbox/auth-session-env.ts";
import { scriptedLoginEvidence } from "../../../support/login-evidence.ts";

const SEED = readFileSync(fileURLToPath(new URL("../../../../../config/e2e/auth.setup.ts", import.meta.url)), "utf8");
const USER = "qa.user@demo.example";
const PASS = "p4ss w0rd&1";
const FORM: AuthDeclaration = { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" };

/* What each kind of attempt leaves behind, as the discovery child would print it. */
const SIGNED_IN = { requests: [{ method: "POST", pathname: "/api/session", status: 200 }], passwordGone: true, freshContextChecked: true, freshContextPasswordGone: true, storageStateWritten: true, finalPath: "/home" };
const REJECTED = scriptedLoginEvidence();
const SILENT = scriptedLoginEvidence({ requests: [] });
const UNSETTLED = scriptedLoginEvidence({ requests: [], inFlightAtDeadline: true });

interface Scenario {
  discover?: (input: LoginDiscoveryInput, signal?: AbortSignal) => Promise<LoginDiscoveryResult> | LoginDiscoveryResult;
  /** What the stock seed does when it runs; by default it does not sign in. */
  seed?: (env: Record<string, string>) => { exitCode: number; logs: string };
  setup?: string | null;
  contextMap?: AuthDiscoveryDeps["loadContextMap"];
  redact?: (text: string) => string;
  clock?: number[];
  actionTimeoutMs?: string;
  env?: Record<string, string>;
  unwired?: boolean;
}

interface Run {
  discovered: LoginDiscoveryInput[];
  seeded: number;
  authDir: string;
  specDir: string;
  prepare(over?: Partial<AuthSessionRequest>, signal?: AbortSignal): ReturnType<AuthSessionAdapter["prepare"]>;
  cleanup(): void;
}

function scenario(s: Scenario = {}): Run {
  const specDir = mkdtempSync(join(tmpdir(), "auth-spec-"));
  const authDir = mkdtempSync(join(tmpdir(), "auth-dir-"));
  if (s.setup !== null) writeFileSync(join(specDir, "auth.setup.ts"), s.setup ?? SEED);
  const run: Run = {
    discovered: [],
    seeded: 0,
    authDir,
    specDir,
    prepare: (over = {}, signal) => adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate", auth: FORM, ...over }, signal),
    cleanup: () => {
      rmSync(specDir, { recursive: true, force: true });
      rmSync(authDir, { recursive: true, force: true });
    },
  };
  const ticks = [...(s.clock ?? [1_000, 1_450])];
  const discovery: AuthDiscoveryDeps = {
    discoverLogin: async (input, signal) => {
      run.discovered.push(input);
      return (s.discover ?? (() => ({ crashed: true, attempted: false })))(input, signal);
    },
    redact: s.redact ?? ((text) => text),
    ...(s.contextMap ? { loadContextMap: s.contextMap } : {}),
    now: () => ticks.shift() ?? 9_999,
  };
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: USER, QA_PASS: PASS, ...s.env },
    authDir,
    ...(s.actionTimeoutMs ? { actionTimeoutMs: s.actionTimeoutMs } : {}),
    ...(s.unwired ? {} : { discovery }),
    spawnSetup: async (_dir, env) => {
      run.seeded += 1;
      return (s.seed ?? (() => ({ exitCode: 1, logs: "seed-log-marker" })))(env);
    },
  });
  return run;
}

/* The child writes the session where it was told to; a stub of that. */
const writesSession = (input: LoginDiscoveryInput): void => writeFileSync(input.storageStatePath, "{\"cookies\":[]}");
const seedSignsIn = (env: Record<string, string>): { exitCode: number; logs: string } => {
  writeFileSync(env.PW_STORAGE_STATE!, "{\"cookies\":[]}");
  return { exitCode: 0, logs: "" };
};

async function withScenario<T>(s: Scenario, body: (run: Run) => Promise<T>): Promise<T> {
  const run = scenario(s);
  try {
    return await body(run);
  } finally {
    run.cleanup();
  }
}

test("a login that discovery confirms is the session, with how it was resolved, and the stock seed never runs", async () => {
  await withScenario({ discover: (input) => { writesSession(input); return scriptedLoginEvidence(SIGNED_IN); }, clock: [1_000, 1_450] }, async (run) => {
    const session = await run.prepare();
    assert.equal(session.storageStatePath, join(run.authDir, AUTH_MATERIAL_FILES.storageState));
    assert.equal(session.unauthored, false);
    assert.equal(session.resolution?.method, AUTH_RESOLUTION_METHOD.DISCOVERY);
    assert.equal(session.resolution?.ms, 450);
    assert.equal(statSync(session.storageStatePath!).mode & 0o777, 0o600);
    assert.equal(run.seeded, 0);
  });
});

test("a session the child claims but did not leave behind is an attempt that could not be confirmed", async () => {
  await withScenario({ discover: () => scriptedLoginEvidence(SIGNED_IN) }, async (run) => {
    assert.deepEqual(await run.prepare(), { unauthored: true });
    assert.equal(run.seeded, 0);
  });
});

test("a positively evidenced failure is a typed error with its kind, a note free of the account, and the time it took; the seed is not tried", async () => {
  const leaky = scriptedLoginEvidence({ firstAlert: `Invalid sign-in for ${USER} using ${PASS}`, requests: [{ method: "POST", pathname: "/api/session", status: 401 }] });
  await withScenario({ discover: (input) => { writesSession(input); return leaky; }, clock: [1_000, 1_900] }, async (run) => {
    await assert.rejects(run.prepare(), (error: unknown) => {
      assert.ok(error instanceof AuthPreconditionError);
      assert.equal(error.kind, PRECONDITION_KIND.CREDENTIALS_REJECTED);
      assert.equal(error.ms, 900);
      assert.ok(error.note.includes("/api/session"), "the note carries the structural facts");
      assert.equal(error.note.includes(USER) || error.note.includes(PASS), false);
      return true;
    });
    assert.equal(run.seeded, 0);
    assert.equal(existsSync(join(run.authDir, AUTH_MATERIAL_FILES.storageState)), false, "a session left by a failed attempt is removed");
  });
});

test("the note also goes through the shell's redaction", async () => {
  await withScenario({ discover: () => REJECTED, redact: (text) => `redacted(${text})` }, async (run) => {
    await assert.rejects(run.prepare(), (error: unknown) => error instanceof AuthPreconditionError && error.note.startsWith("redacted("));
  });
});

test("an attempt that proved nothing and submitted nothing leaves the login to the stock seed", async () => {
  await withScenario({ discover: () => SILENT, seed: seedSignsIn }, async (run) => {
    const session = await run.prepare();
    assert.equal(run.seeded, 1);
    assert.equal(session.unauthored, false);
    assert.equal(session.storageStatePath, join(run.authDir, AUTH_MATERIAL_FILES.storageState));
  });
  await withScenario({ discover: () => SILENT }, async (run) => {
    assert.deepEqual(await run.prepare(), { unauthored: true });
    await assert.rejects(run.prepare({ phase: "pre-execute" }), /auth setup failed/);
    assert.equal(run.seeded, 2);
  });
});

test("a crash before any submit is treated like an attempt that proved nothing", async () => {
  await withScenario({ discover: () => ({ crashed: true, attempted: false }), seed: seedSignsIn }, async (run) => {
    assert.equal((await run.prepare()).unauthored, false);
    assert.equal(run.seeded, 1);
  });
});

test("after a submit that could not be confirmed the seed does not submit again: unauthored before generation, a scrubbed generic failure before execute", async () => {
  for (const discover of [() => UNSETTLED, () => ({ crashed: true as const, attempted: true })]) {
    await withScenario({ discover, seed: seedSignsIn }, async (run) => {
      assert.deepEqual(await run.prepare(), { unauthored: true });
      await assert.rejects(run.prepare({ phase: "pre-execute" }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof AuthPreconditionError, false);
        assert.equal(error.message.includes("seed-log-marker"), false);
        return true;
      });
      assert.equal(run.seeded, 0);
    });
  }
});

test("a session the child left behind is removed unless the login was confirmed", async () => {
  for (const discover of [SILENT, UNSETTLED]) {
    await withScenario({ discover: (input) => { writesSession(input); return discover; } }, async (run) => {
      await run.prepare();
      assert.equal(existsSync(join(run.authDir, AUTH_MATERIAL_FILES.storageState)), false);
    });
  }
});

test("a run that is aborted during discovery does not start the seed", async () => {
  const controller = new AbortController();
  await withScenario({ discover: () => { controller.abort(); return SILENT; }, seed: seedSignsIn }, async (run) => {
    assert.deepEqual(await run.prepare({}, controller.signal), { unauthored: true });
    assert.equal(run.seeded, 0);
  });
});

test("an app's own login script bypasses discovery", async () => {
  await withScenario({ setup: "/* app-owned login */\n", discover: () => REJECTED, seed: seedSignsIn }, async (run) => {
    assert.equal((await run.prepare()).unauthored, false);
    assert.equal(run.discovered.length, 0);
    assert.equal(run.seeded, 1);
  });
});

test("a repo with no login script yet is still discovered", async () => {
  await withScenario({ setup: null, discover: () => REJECTED }, async (run) => {
    await assert.rejects(run.prepare(), AuthPreconditionError);
    assert.equal(run.discovered.length, 1);
  });
});

test("without a discovery collaborator the login is exactly today's: the stock seed", async () => {
  await withScenario({ unwired: true, seed: seedSignsIn }, async (run) => {
    assert.equal((await run.prepare()).unauthored, false);
    assert.equal(run.seeded, 1);
  });
});

test("a public app and a certificate app never start discovery", async () => {
  await withScenario({ discover: () => REJECTED, env: { QA_CERT: Buffer.from("p12").toString("base64"), QA_CERT_PASS: "x" } }, async (run) => {
    await run.prepare({ auth: undefined as unknown as AuthDeclaration });
    await run.prepare({ auth: { kind: "mtls", certEnv: "QA_CERT", certPassEnv: "QA_CERT_PASS" } });
    assert.equal(run.discovered.length, 0);
  });
});

test("discovery is given the declared login path, the app's capturable routes, the session path and the account only in its env", async () => {
  const contextMap = () => ({ routes: ["/reports", "/orders/:id", "//evil.example/x", "https://elsewhere.example/a", "/a b", "/ok-2", "/reports", "/x?y=1"].map((path) => ({ path })) });
  await withScenario({ discover: () => SILENT, contextMap, actionTimeoutMs: "12000", env: { DEV_ENV_USER: "gate", DEV_ENV_PASS: "gate-pass" } }, async (run) => {
    await run.prepare({ auth: { ...FORM, loginPath: "/signin" } });
    const [input] = run.discovered;
    assert.equal(input?.loginPath, "/signin");
    assert.deepEqual(input?.routes, ["/reports", "/ok-2"]);
    assert.equal(input?.baseUrl, "https://dev.example");
    assert.equal(input?.specDir, run.specDir);
    assert.equal(input?.storageStatePath, join(run.authDir, AUTH_MATERIAL_FILES.storageState));
    assert.equal(input?.actionTimeoutMs, 12_000);
    assert.equal(input?.env.DEV_TEST_USER, USER);
    assert.equal(input?.env.DEV_TEST_PASS, PASS);
    assert.equal(input?.env.DEV_ENV_USER, "gate");
    assert.equal(input?.env.DEV_ENV_PASS, "gate-pass");
    assert.equal(JSON.stringify({ ...input, env: undefined }).includes(PASS), false);
  });
});

test("an action timeout that is not a positive number is not handed to discovery", async () => {
  for (const actionTimeoutMs of ["0", "-5", "soon"]) {
    await withScenario({ discover: () => SILENT, actionTimeoutMs }, async (run) => {
      await run.prepare();
      const [input] = run.discovered;
      assert.equal(input !== undefined && "actionTimeoutMs" in input, false, `an action timeout of ${actionTimeoutMs} was passed on`);
    });
  }
});

test("with no login path declared, no context map and no action timeout, discovery is given none of them", async () => {
  await withScenario({ discover: () => SILENT }, async (run) => {
    await run.prepare();
    const [input] = run.discovered;
    assert.equal(input !== undefined && "loginPath" in input, false);
    assert.equal(input !== undefined && "actionTimeoutMs" in input, false);
    assert.deepEqual(input?.routes, []);
  });
});
