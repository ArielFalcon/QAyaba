# E2E auth session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an e2e run enter an app that requires login, using Playwright's setup-project + `storageState` for form login and `clientCertificates` for a software PKCS#12, without a per-mechanism adapter hierarchy.

**Architecture:** App YAML declares `auth.kind` (`form` | `mtls`) and the env-var *names* that hold the secrets. One `AuthSessionPort.prepare()` runs after `setup()` and again after generation, before execute. Form login is `e2e/auth.setup.ts` (Playwright setup project) and writes `e2e/.auth/user.json`. Certificate material is decoded to `e2e/.auth/client.p12`. DOM capture and the Playwright runner read those files through `PW_STORAGE_STATE` and `PW_CLIENT_CERT_PATH`. Tests keep calling the `authenticate` fixture; the desktop project reuses the saved session. Code-mode apps skip this entirely.

**Tech Stack:** TypeScript via `tsx`, `node:test`, Playwright 1.50, Zod app schema, existing `SetupPort` / `PreGenerationGroundingPort` / `E2E_PUBLISH_EXCLUDES`.

## Global Constraints

- Implement on a linked worktree, not in the checkout that is currently running. That checkout is the primary working tree on `main` and has uncommitted work (including `setup.adapter.ts`).
- App-specific selectors stay in the watched repo's `e2e/auth.setup.ts`. No Keycloak/IdP branch in `qa-engine/` or `src/`.
- Secrets stay in the env store / Doppler. YAML stores variable names only. `e2e/.auth/` is never committed.
- Sequential queue stays one run at a time. Do not mutate `process.env` as the way to pass the session; pass env into the child spawn.
- A throw from an *authored* login is `infra-error`, same as `setup()` today. A still-stock seed that cannot log in yet is fail-open so generation can rewrite `auth.setup.ts`.
- Playwright stays pinned at `1.50.0`. `clientCertificates` exists since 1.46; do not bump Playwright for this feature.
- Code-mode (`code: true`) never prepares a browser session.
- Governance: this branch is only the auth session. Do not mix it with the uncommitted coordination work on the running checkout.
- English in code, comments, and this plan. Comments describe the final state.

## File structure

| Path | Responsibility |
|---|---|
| `src/orchestrator/schemas.ts` | `auth` block on `AppConfigSchema` |
| `qa-engine/src/contexts/qa-run-orchestration/application/ports/auth-session.port.ts` | `AuthSessionPort`, `AuthSessionRequest`, `AuthSession` |
| `qa-engine/src/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts` | The one implementation: materialize P12, spawn the setup project, classify seed vs authored |
| `qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts` | Call `prepare` after setup and again before execute |
| `qa-engine/src/contexts/qa-run-orchestration/composition/composition-root.ts` | Wire the port when not code-mode |
| `src/server/rewritten-engine-factory.ts` | Map YAML env names onto the child env; add `e2e/.auth/` to `E2E_PUBLISH_EXCLUDES` |
| `config/e2e/auth.setup.ts` | Playwright setup project (seed) |
| `config/e2e/playwright.config.ts` | `setup` project, `storageState`, `clientCertificates` |
| `config/e2e/fixtures.ts` | `authenticate()` loads `storageState` when `PW_STORAGE_STATE` is set; otherwise performs the form steps |
| `qa-engine/src/contexts/generation/infrastructure/dom-snapshot.ts` | `newContext` gains `storageState` + `clientCertificates` |
| `qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts` | Pass `PW_STORAGE_STATE` / `PW_CLIENT_CERT_*` when the files exist |
| `agents/skill/playwright-authoring/auth.md` and `agent/skills/playwright-authoring/auth.md` | Same contract, both prompt trees |
| `client/internal/ui/apps.go` | Onboarding rows for form and certificate (phase 2) |

Consumers do not grow a strategy class per login kind. `prepare()` returns one `AuthSession`. Playwright applies it.

---

### Task 1: Declare `auth` on the app schema

**Files:**
- Modify: `src/orchestrator/schemas.ts` (the `AppConfigSchema` object, next to `e2e`)
- Test: `src/orchestrator/schemas.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ValidatedAppConfig["auth"]` —
  `{ kind: "form" | "mtls"; usernameEnv?: string; passwordEnv?: string; certEnv?: string; certPassEnv?: string } | undefined`

- [ ] **Step 1: Write the failing test**

Add to `src/orchestrator/schemas.test.ts`, using the same `base` object the file already parses:

```ts
test("auth.kind form accepts env-var names and rejects a secret value shape", () => {
  const cfg = AppConfigSchema.parse({
    ...base,
    auth: { kind: "form", usernameEnv: "QA_SHOP_TEST_USER", passwordEnv: "QA_SHOP_TEST_PASS" },
  });
  assert.equal(cfg.auth?.kind, "form");
  assert.equal(cfg.auth?.usernameEnv, "QA_SHOP_TEST_USER");
});

test("auth is optional and code-mode stays valid without it", () => {
  const cfg = AppConfigSchema.parse({ ...base, code: true, dev: undefined });
  assert.equal(cfg.auth, undefined);
});

test("auth.kind mtls requires certEnv", () => {
  assert.throws(() => AppConfigSchema.parse({ ...base, auth: { kind: "mtls" } }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test --test-name-pattern="auth.kind" src/orchestrator/schemas.test.ts`

Expected: FAIL because `auth` is unrecognized or stripped. Zod object schemas strip unknown keys by default, so the first assertion fails with `cfg.auth` undefined. If the file's `base` is not named `base`, copy the minimal valid app object already used at the top of that test file.

- [ ] **Step 3: Add the schema**

Inside the `AppConfigSchema` object, after the `e2e` field:

```ts
auth: z
  .object({
    kind: z.enum(["form", "mtls"]),
    usernameEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    passwordEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    certEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    certPassEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  })
  .optional(),
```

Add a `.refine`: `kind === "form"` requires both `usernameEnv` and `passwordEnv`. `kind === "mtls"` requires `certEnv` and `certPassEnv`. `code: true` with `auth` set is an error (`auth` is e2e-only), same style as the existing `services` refine.

Absent `auth` means a public app. HTTP Basic of the DEV environment stays `DEV_ENV_USER` / `DEV_ENV_PASS` and is not part of this block.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test --test-name-pattern="auth.kind|code-mode stays valid" src/orchestrator/schemas.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/schemas.ts src/orchestrator/schemas.test.ts
git commit -m "feat(config): declare e2e auth kind and secret env names"
```

---

### Task 2: AuthSession port and pure prepare decisions

**Files:**
- Create: `qa-engine/src/contexts/qa-run-orchestration/application/ports/auth-session.port.ts`
- Create: `qa-engine/src/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts`
- Test: `qa-engine/test/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.test.ts`

**Interfaces:**
- Consumes: `ValidatedAppConfig["auth"]` shape (structural; the engine port must not import `src/orchestrator/schemas.ts`)
- Produces:

```ts
export interface AuthDeclaration {
  kind: "form" | "mtls";
  usernameEnv: string;
  passwordEnv: string;
  certEnv: string;
  certPassEnv: string;
}

export interface AuthSessionRequest {
  specDir: string;
  baseUrl: string;
  /** Absent means the app is public. */
  auth?: { kind: "form" | "mtls"; usernameEnv?: string; passwordEnv?: string; certEnv?: string; certPassEnv?: string };
  /** "pre-generate" fail-opens a stock seed. "pre-execute" treats an authored setup failure as fatal. */
  phase: "pre-generate" | "pre-execute";
}

export interface AuthSession {
  storageStatePath?: string;
  clientCertPath?: string;
  /** Stock seed could not log in. Generation may rewrite e2e/auth.setup.ts. */
  unauthored: boolean;
}

export interface AuthSessionPort {
  prepare(req: AuthSessionRequest, signal?: AbortSignal): Promise<AuthSession>;
}
```

`prepare` throws only when the run must become `infra-error`.

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthSessionAdapter } from "../../../../src/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts";

const SEED = "/* qa-auth-setup-seed */\nexport {};\n";

test("absent auth returns an empty session and does not spawn", async () => {
  let spawned = false;
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const adapter = new AuthSessionAdapter({
    env: {},
    seedAuthSetup: SEED,
    spawnSetup: async () => { spawned = true; return { exitCode: 0, logs: "" }; },
  });
  const session = await adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate" });
  assert.equal(spawned, false);
  assert.deepEqual(session, { unauthored: false });
});

test("mtls decodes the base64 P12 to e2e/.auth/client.p12 and does not spawn", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const adapter = new AuthSessionAdapter({
    env: { QA_CERT: Buffer.from("p12-bytes").toString("base64"), QA_CERT_PASS: "secret" },
    seedAuthSetup: SEED,
    spawnSetup: async () => { throw new Error("must not spawn"); },
  });
  const session = await adapter.prepare({
    specDir,
    baseUrl: "https://dev.example",
    phase: "pre-generate",
    auth: { kind: "mtls", certEnv: "QA_CERT", certPassEnv: "QA_CERT_PASS" },
  });
  assert.equal(readFileSync(session.clientCertPath!), "p12-bytes");
  assert.equal(session.unauthored, false);
});

test("form with missing username env throws", async () => {
  const adapter = new AuthSessionAdapter({
    env: {},
    seedAuthSetup: SEED,
    spawnSetup: async () => ({ exitCode: 0, logs: "" }),
  });
  await assert.rejects(
    () => adapter.prepare({
      specDir: mkdtempSync(join(tmpdir(), "auth-")),
      baseUrl: "https://dev.example",
      phase: "pre-generate",
      auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
    }),
    /QA_USER/,
  );
});

test("stock seed login failure on pre-generate is unauthored and does not throw", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, "auth.setup.ts"), SEED);
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: "u", QA_PASS: "p" },
    seedAuthSetup: SEED,
    spawnSetup: async () => ({ exitCode: 1, logs: "selector miss" }),
  });
  const session = await adapter.prepare({
    specDir,
    baseUrl: "https://dev.example",
    phase: "pre-generate",
    auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
  });
  assert.equal(session.unauthored, true);
  assert.equal(session.storageStatePath, undefined);
});

test("authored setup failure throws", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  writeFileSync(join(specDir, "auth.setup.ts"), "/* app-owned login */\n");
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: "u", QA_PASS: "p" },
    seedAuthSetup: SEED,
    spawnSetup: async () => ({ exitCode: 1, logs: "still on login" }),
  });
  await assert.rejects(
    () => adapter.prepare({
      specDir,
      baseUrl: "https://dev.example",
      phase: "pre-execute",
      auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
    }),
    /still on login/,
  );
});

test("successful form login returns the storageState path the spawn wrote", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  writeFileSync(join(specDir, "auth.setup.ts"), "/* app-owned login */\n");
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: "u", QA_PASS: "p" },
    seedAuthSetup: SEED,
    spawnSetup: async () => {
      mkdirSync(join(specDir, ".auth"), { recursive: true });
      writeFileSync(join(specDir, ".auth", "user.json"), "{\"cookies\":[]}");
      return { exitCode: 0, logs: "" };
    },
  });
  const session = await adapter.prepare({
    specDir,
    baseUrl: "https://dev.example",
    phase: "pre-execute",
    auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
  });
  assert.equal(existsSync(session.storageStatePath!), true);
  assert.equal(session.unauthored, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test qa-engine/test/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement the adapter**

`auth-session.port.ts` exports the interfaces in the Produces block.

`AuthSessionAdapter` constructor deps:

```ts
export interface AuthSessionAdapterDeps {
  env: NodeJS.ProcessEnv;
  seedAuthSetup: string;
  spawnSetup(specDir: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ exitCode: number; logs: string }>;
}
```

`prepare` behavior:

1. `req.auth` absent → `{ unauthored: false }`.
2. `kind === "mtls"`: read `env[certEnv]`, base64-decode to `specDir/.auth/client.p12` (mkdir, mode `0o600`). Missing or invalid base64 throws `auth certificate env ${certEnv} is missing or not base64`. Return `{ clientCertPath, unauthored: false }`. Do not spawn.
3. `kind === "form"`: if `env[usernameEnv]` or `env[passwordEnv]` is empty, throw `auth.kind form requires ${usernameEnv} and ${passwordEnv}`.
4. Compare `specDir/auth.setup.ts` bytes to `seedAuthSetup`. Missing file counts as stock. Spawn with an env that includes `PW_BASE_URL=req.baseUrl`, `DEV_TEST_USER=env[usernameEnv]`, `DEV_TEST_PASS=env[passwordEnv]`, plus the existing `DEV_ENV_*` if present (the setup browser must also pass HTTP Basic).
5. Exit code 0 and `specDir/.auth/user.json` exists → `{ storageStatePath: that file, clientCertPath if any, unauthored: false }`. Form+mtls is two declarations later; v1 is one kind. If both are needed, a follow-up allows `kind: form` plus optional cert fields on the same object. Do not build that until an app declares both. The schema in Task 1 is one `kind`.
6. Non-zero exit and the file is stock and `phase === "pre-generate"` → `{ unauthored: true }`.
7. Any other non-zero exit, or exit 0 without `user.json`, throws `Error` whose message includes the spawn logs. The use case maps that throw to `infra-error`.

The P12 and `user.json` live under `specDir/.auth/`. `prepare` does not delete them; the run's working copy is disposable. Do not copy them into the prompt.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test qa-engine/test/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add qa-engine/src/contexts/qa-run-orchestration/application/ports/auth-session.port.ts \
  qa-engine/src/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts \
  qa-engine/test/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.test.ts
git commit -m "feat(qa-engine): prepare an e2e auth session from form setup or a P12"
```

---

### Task 3: Playwright seed follows the official setup-project pattern

**Files:**
- Create: `config/e2e/auth.setup.ts`
- Modify: `config/e2e/playwright.config.ts`
- Modify: `config/e2e/fixtures.ts` (`authenticate` only)
- Modify: `agents/skill/playwright-authoring/auth.md`
- Modify: `agent/skills/playwright-authoring/auth.md` (keep the two trees in sync)

**Interfaces:**
- Consumes: `DEV_TEST_USER`, `DEV_TEST_PASS`, `PW_STORAGE_STATE`, `PW_CLIENT_CERT_PATH`, `DEV_CLIENT_CERT_PASS`, `DEV_ENV_USER` (already in the config)
- Produces: setup project name `"setup"`, storage file `e2e/.auth/user.json` relative to the `e2e/` cwd Playwright uses (`testDir: "."`, so the path written by the setup is `.auth/user.json`)

- [ ] **Step 1: Write `config/e2e/auth.setup.ts`**

The first line is the stock marker the adapter compares. Accessible-name locators, not Keycloak ids. The agent replaces this file in the watched repo when the labels differ; replacing it removes the marker, which is what flips fail-open off.

```ts
/* qa-auth-setup-seed */
import { test as setup } from "./fixtures";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const authFile = ".auth/user.json";

setup("authenticate", async ({ page }) => {
  const user = process.env.DEV_TEST_USER;
  const pass = process.env.DEV_TEST_PASS;
  if (!user || !pass) return;
  await page.goto("/");
  await page.getByLabel(/username|email|user/i).fill(user);
  await page.getByLabel(/^password$/i).fill(pass);
  await page.getByRole("button", { name: /log ?in|sign ?in|entrar/i }).click();
  await page.waitForLoadState("domcontentloaded");
  mkdirSync(dirname(authFile), { recursive: true });
  await page.context().storageState({ path: authFile });
});
```

- [ ] **Step 2: Point the desktop project at the saved session**

In `config/e2e/playwright.config.ts`, keep `httpCredentials` as it is. Add next to it:

```ts
storageState: process.env.PW_STORAGE_STATE,
clientCertificates: process.env.PW_CLIENT_CERT_PATH
  ? [{
      origin: appOrigin,
      pfxPath: process.env.PW_CLIENT_CERT_PATH,
      passphrase: process.env.DEV_CLIENT_CERT_PASS ?? "",
    }]
  : undefined,
```

Replace the `projects` array with:

```ts
projects: [
  { name: "setup", testMatch: "**/*.setup.ts" },
  {
    name: "desktop",
    testIgnore: "**/*.setup.ts",
    use: { ...devices["Desktop Chrome"] },
  },
],
```

The desktop project does not `dependencies: ["setup"]`. The orchestrator runs the setup project itself, twice at most (before generate, before execute). A dependency would log in a third time inside the suite.

- [ ] **Step 3: Make `authenticate()` reuse the session**

Replace the body of the `authenticate` fixture in `config/e2e/fixtures.ts`. When `PW_STORAGE_STATE` is set, the context already has the cookies (config `storageState`), so the fixture only waits until the app origin is showing. When it is unset, keep a single form login using the same locators as `auth.setup.ts`, still no-op when `DEV_TEST_USER` is unset (public apps). Delete the Keycloak-only selectors (`#username`, `#password`, `#kc-login`).

- [ ] **Step 4: Update both auth skills**

Replace the Keycloak-specific "Layer 2" section so it states:

- Layer 1 remains `DEV_ENV_*` / `httpCredentials`.
- App login is `e2e/auth.setup.ts`. The orchestrator runs that setup project and sets `PW_STORAGE_STATE`. Specs call `authenticate()` and do not repeat the form.
- A public test does not call `authenticate()`.
- Rewrite `auth.setup.ts` from the live login page when the seed locators miss. Credentials stay `process.env.DEV_TEST_USER` / `DEV_TEST_PASS`. Never write the password into the spec.
- `.auth/` is session state. Do not commit it.

- [ ] **Step 5: Commit**

```bash
git add config/e2e/auth.setup.ts config/e2e/playwright.config.ts config/e2e/fixtures.ts \
  agents/skill/playwright-authoring/auth.md agent/skills/playwright-authoring/auth.md
git commit -m "feat(e2e): seed Playwright setup project and storageState reuse"
```

There is no unit test for the seed TypeScript; Task 2's byte comparison uses this file's contents as `seedAuthSetup`. After this commit, the adapter test's `SEED` constant must be the exact file bytes of `config/e2e/auth.setup.ts`. Update that fixture string in the same commit if Task 2 already landed with the placeholder `SEED`.

---

### Task 4: Spawn the setup project and thread the session into capture and execute

**Files:**
- Modify: `qa-engine/src/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts` (real `spawnSetup` default)
- Modify: `qa-engine/src/contexts/generation/infrastructure/dom-snapshot.ts` (`buildCaptureScript` context options)
- Modify: `qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts` (the env object passed to the Playwright spawn, both the cleanup spawn and the main spawn)
- Modify: `qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts` (after setup, and immediately before execute)
- Modify: `qa-engine/src/contexts/qa-run-orchestration/composition/composition-root.ts`
- Modify: `src/server/rewritten-engine-factory.ts` (`E2E_PUBLISH_EXCLUDES` and config mapping)
- Test: `qa-engine/test/contexts/generation/infrastructure/dom-snapshot.test.ts`
- Test: `src/server/rewritten-engine-factory.publish-excludes.test.ts`
- Test: `qa-engine/test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts`

**Interfaces:**
- Consumes: `AuthSessionPort.prepare`
- Produces: child env `PW_STORAGE_STATE`, `PW_CLIENT_CERT_PATH`, `DEV_CLIENT_CERT_PASS`. `RunQaUseCaseDeps` gains optional `authSession?: AuthSessionPort`.

- [ ] **Step 1: Failing capture test**

In `dom-snapshot.test.ts`, next to the existing `DEV_ENV_USER` httpCredentials tests:

```ts
test("buildCaptureScript applies PW_STORAGE_STATE and PW_CLIENT_CERT_PATH on newContext()", () => {
  const script = buildCaptureScript();
  assert.match(script, /process\.env\.PW_STORAGE_STATE/);
  assert.match(script, /storageState/);
  assert.match(script, /process\.env\.PW_CLIENT_CERT_PATH/);
  assert.match(script, /clientCertificates/);
});
```

Run: `node --import tsx --test --test-name-pattern="PW_STORAGE_STATE" qa-engine/test/contexts/generation/infrastructure/dom-snapshot.test.ts`

Expected: FAIL

- [ ] **Step 2: Capture script reads the session**

In `buildCaptureScript`, build the context options object from env instead of only `httpCredentials`:

```js
const contextOptions = {};
if (process.env.DEV_ENV_USER) {
  contextOptions.httpCredentials = {
    username: process.env.DEV_ENV_USER,
    password: process.env.DEV_ENV_PASS ?? "",
    origin: new URL(baseUrl).origin,
  };
}
if (process.env.PW_STORAGE_STATE) contextOptions.storageState = process.env.PW_STORAGE_STATE;
if (process.env.PW_CLIENT_CERT_PATH) {
  contextOptions.clientCertificates = [{
    origin: new URL(baseUrl).origin,
    pfxPath: process.env.PW_CLIENT_CERT_PATH,
    passphrase: process.env.DEV_CLIENT_CERT_PASS ?? "",
  }];
}
const context = await browser.newContext(contextOptions);
```

Keep the existing `DEV_ENV_USER`-only gate tests green.

- [ ] **Step 3: Runner forwards the paths**

`e2e-execution.runner.ts` builds the spawn env in two places (cleanup and the main run). Add a helper:

```ts
function authSessionEnv(specDir: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const storage = join(specDir, ".auth", "user.json");
  const cert = join(specDir, ".auth", "client.p12");
  return {
    ...baseEnv,
    ...(existsSync(storage) ? { PW_STORAGE_STATE: storage } : {}),
    ...(existsSync(cert) ? { PW_CLIENT_CERT_PATH: cert, DEV_CLIENT_CERT_PASS: baseEnv.DEV_CLIENT_CERT_PASS ?? "" } : {}),
  };
}
```

Use it as the `env` of both spawns. `scrubEnv({ extraAllowed: /^DEV_/ })` already forwards `DEV_CLIENT_CERT_PASS` when the factory placed it on the child env. The factory, when `auth.kind === "mtls"`, copies `process.env[certPassEnv]` onto the orchestrator env key `DEV_CLIENT_CERT_PASS` for that spawn only (the env object, not a process-global write).

Default `spawnSetup` in the adapter:

```ts
spawn("npx", ["playwright", "test", "--project=setup"], {
  cwd: specDir,
  env: childEnv,
})
```

Reuse the sandboxed runner the e2e executor already uses (`SandboxedBinaryRunner`), with a timeout under the run's remaining budget. A timeout throws, which is `infra-error`.

- [ ] **Step 4: Use case call sites**

`RunQaUseCaseDeps` gains `authSession?: AuthSessionPort` and the static `auth` declaration + `baseUrl` already available on the run config (thread them the same way `baseUrl` reaches the executor; do not import the Zod schema into the use case).

After the existing `setup()` try/catch returns successfully, and only when `!cfg.isCode && this.deps.authSession`:

```ts
await this.deps.authSession.prepare({
  specDir: workspace.specDir,
  baseUrl: cfg.baseUrl,
  auth: cfg.auth,
  phase: "pre-generate",
}, signal);
```

A throw uses the same `infraErrorResult(\`auth session failed: ${msg}\`)` path as setup. `unauthored: true` does not throw; `onStep("setup", "auth setup is still the seed; generation may rewrite e2e/auth.setup.ts")`.

Immediately before `execution.execute` (the first execute, not the coverage regen's second execute unless that path also opens a browser against DEV — it does, so call `prepare` with `phase: "pre-execute"` once and reuse the files; the regen spawn picks them up via `authSessionEnv`). `pre-execute` is the fatal phase: an authored `auth.setup.ts` that still fails becomes `infra-error` before burning an execute.

Code-mode: `authSession` is undefined. No call.

- [ ] **Step 5: Publish exclude**

In `src/server/rewritten-engine-factory.ts`:

```ts
const E2E_PUBLISH_EXCLUDES = [
  "node_modules/",
  "e2e/.qa/coverage/",
  "e2e/.qa/measured.json",
  "e2e/.qa/service-context/",
  "e2e/.auth/",
];
```

Extend `rewritten-engine-factory.publish-excludes.test.ts` with one case: a file at `e2e/.auth/user.json` is not in the committed path list. Same fixture style as the existing `e2e/node_modules` test.

- [ ] **Step 6: Use-case test**

In `run-qa.use-case.test.ts`, one test with a fake `authSession`:

- `prepare` records the phases it saw.
- A public config (no `auth`) does not require the fake to be called when the dep is absent (current tests stay valid).
- When the dep is present and `prepare` throws on `pre-generate`, the result verdict is `infra-error` and `generation.generate` was not called.

Run:

```bash
node --import tsx --test --test-name-pattern="PW_STORAGE_STATE" qa-engine/test/contexts/generation/infrastructure/dom-snapshot.test.ts
node --import tsx --test --test-name-pattern="e2e/.auth" src/server/rewritten-engine-factory.publish-excludes.test.ts
node --import tsx --test --test-name-pattern="auth session" qa-engine/test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add qa-engine/src/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts \
  qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts \
  qa-engine/src/contexts/qa-run-orchestration/composition/composition-root.ts \
  qa-engine/src/contexts/generation/infrastructure/dom-snapshot.ts \
  qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts \
  src/server/rewritten-engine-factory.ts \
  qa-engine/test/contexts/generation/infrastructure/dom-snapshot.test.ts \
  src/server/rewritten-engine-factory.publish-excludes.test.ts \
  qa-engine/test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts
git commit -m "feat(qa-engine): inject the auth session into grounding and Playwright"
```

---

### Task 5: Onboarding UI writes the secret and the YAML kind

This task is independently shippable after Task 1. Until it lands, an operator can set the env vars and the `auth` block by hand.

**Files:**
- Modify: `client/internal/ui/apps.go`
- Test: `client/internal/ui/apps_test.go`
- Modify: the create/update app API payload the TUI already sends (`env` map + app YAML). The server path is `applyEnvVars` in `src/server/env-store.ts`. Do not change `applyEnvVars`; it already rejects multiline values, which is why the P12 is base64 (one line).

**Interfaces:**
- Consumes: `auth.kind`, env key regex `[A-Z][A-Z0-9_]*`
- Produces: for an app named `jhipster-store`:
  - form → env `QA_JHIPSTER_STORE_TEST_USER` / `QA_JHIPSTER_STORE_TEST_PASS` and YAML `auth.kind: form` with those `usernameEnv` / `passwordEnv`
  - mtls → env `QA_JHIPSTER_STORE_CLIENT_CERT` (base64 of the file at the path the operator typed) / `QA_JHIPSTER_STORE_CLIENT_CERT_PASS` and YAML `auth.kind: mtls` with `certEnv` / `certPassEnv`
  - basic → unchanged `DEV_ENV_USER` / `DEV_ENV_PASS` (environment gate, not app login)
  - disabled → no `auth` block and no new env keys

- [ ] **Step 1: Failing Go test**

Follow `apps_test.go`'s existing basic-auth test. Cycle `authMode` with space: `disabled` → `basic` → `form` → `mtls` → `disabled`.

```go
func TestFormAuthEnvKeysAreAppScoped(t *testing.T) {
    m := newOnboardModel(nil)
    m.nameInput.SetValue("jhipster-store")
    m.authMode = "form"
    m.userInput.SetValue("admin")
    m.passInput.SetValue("admin")
    env := m.envVars()
    if env["QA_JHIPSTER_STORE_TEST_USER"] != "admin" || env["QA_JHIPSTER_STORE_TEST_PASS"] != "admin" {
        t.Fatalf("form auth must persist app-scoped DEV test creds; got %+v", env)
    }
    if _, ok := env["DEV_ENV_USER"]; ok {
        t.Fatal("form auth must not write the environment Basic Auth keys")
    }
}
```

Add a second test: `authMode == "mtls"` with `certPath` pointing at a temp file whose bytes are `p12-bytes` and a passphrase, expects `QA_JHIPSTER_STORE_CLIENT_CERT` to equal `base64("p12-bytes")` and the pass key to hold the passphrase. A missing file returns an error from save, not an empty cert.

Run: `go test ./client/internal/ui/ -run 'TestFormAuthEnvKeysAreAppScoped|TestMtlsAuth'`

Expected: FAIL

- [ ] **Step 2: Implement the rows**

`authMode` values: `"disabled" | "basic" | "form" | "mtls"`. Space on the authentication row cycles in that order. `basic` keeps today's user/password rows and `DEV_ENV_*`. `form` shows the same two inputs but `envVars()` writes the app-scoped `QA_<NAME>_TEST_*` keys. `mtls` shows a path input and a passphrase input (password echo). On save, read the file, `base64.StdEncoding.EncodeToString`, reject the save if the file cannot be read. The YAML writer for the new app includes the `auth` block only when mode is `form` or `mtls`.

App name → env prefix: uppercase, replace `-` with `_`, drop any other character. `jhipster-store` → `QA_JHIPSTER_STORE_`.

Edit-app must keep today's rule: disabled sends no env map, so stored secrets are not wiped.

- [ ] **Step 3: Run the Go tests**

Run: `go test ./client/internal/ui/ -count=1`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add client/internal/ui/apps.go client/internal/ui/apps_test.go
git commit -m "feat(tui): collect app login and client certificate during onboarding"
```

---

## How a run behaves after this

1. Onboarding (or a hand-edited YAML) sets `auth.kind` and the secret env names. Values live in `.env` / Doppler.
2. `setup()` copies the seed, including `auth.setup.ts`, the first time the repo has no `e2e/`.
3. `prepare(pre-generate)` runs.
   - No `auth`: nothing changes. Public apps stay public.
   - `mtls`: writes `.auth/client.p12`. Capture and Playwright present it on the TLS handshake. No fixture click.
   - `form`: runs `npx playwright test --project=setup` with `DEV_TEST_USER` / `DEV_TEST_PASS` mapped from the app's env names. Success writes `.auth/user.json`.
   - Stock seed fails: `unauthored`, generation continues and may rewrite `auth.setup.ts` from the login page.
4. DOM capture's `newContext` receives `storageState` and/or `clientCertificates`, plus the existing `httpCredentials`.
5. Generation writes specs that call `authenticate()`. The desktop project already holds the cookies when `PW_STORAGE_STATE` is set, so the fixture does not log in per test.
6. `prepare(pre-execute)` runs again so a setup file written during generation is the one execute uses. An authored failure is `infra-error`.
7. Publish excludes `e2e/.auth/`.

The long-lived Playwright MCP in `agents/opencode.json` is not retargeted. It is process-wide, not per run. Authenticated pages reach the agent through the injected DOM pack, which is the path the generator already prefers over re-navigating.

## Out of scope

- A second role (admin vs user). Playwright's answer later is a second setup file and a second `storageState`, when an app needs it.
- DNIe, AutoFirma, Cl@ve. Those need a person and a reader. The supported certificate is a test PKCS#12.
- OAuth resource-owner password grant.
- Per-run restart of the agent Playwright MCP.
- Changing `DEV_ENV_*` HTTP Basic. It stays the environment gate and stacks with `auth`.

## Self-review

- Spec coverage: form login, storageState reuse, certificate, onboarding for both, grounding, execute, publish exclusion, fail-open seed vs fatal authored login, public apps unchanged. Each has a task.
- Placeholder scan: no TBD. Task 4 step 3 names the runner helper and the spawn. The use-case insertion is the two call sites, not a line-by-line paste of `run-qa.use-case.ts`.
- Type consistency: `AuthSessionPort.prepare(req, signal)`, `AuthSession.unauthored`, `storageStatePath`, `clientCertPath`, phases `pre-generate` | `pre-execute`, env `PW_STORAGE_STATE` and `PW_CLIENT_CERT_PATH`, YAML `auth.kind` `form` | `mtls`.
