/*
 * patchAppYaml edits the config text an operator already has, so what it does NOT touch is as
 * much the behavior as what it writes: comments, `${VAR}` placeholders, keys the patcher does not
 * manage and every managed field the caller did not supply must come out as they went in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { AppConfigSchema } from "../../orchestrator/schemas";
import { expandEnv } from "../../orchestrator/config-loader";
import { patchAppYaml } from "./patch-app-yaml";

const ENV = { DEMO_DEV_URL: "https://dev.demo.example", DEMO_SVC_URL: "https://svc.demo.example/version" };

/* A synthetic, generic config in the writer's own canonical layout, with everything the patcher must keep. */
const CONFIG = `# Watched app (synthetic fixture).
name: "demo"
repo: "org/demo" # primary repo
baseBranch: "main"

# The DEV site.
dev:
  baseUrl: \${DEMO_DEV_URL}
  versionUrl: "https://dev.example/version"
  pollIntervalMs: 5000

openapi:
  - "**/openapi/*.yaml"

auth:
  kind: form
  usernameEnv: DEMO_USER
  passwordEnv: DEMO_PASS
  futureOption: keep-me

e2e:
  testIdAttribute: data-cy

qa:
  needsReview: true
  shadow: true
  testDataPrefix: "qa-demo" # keeps test data apart
  changeCoverage:
    mode: enforce
    minRatio: 0.8

boundaries:
  - transport: http
    frontFiles: "**/*.api.ts"
    frontCallSite: { kind: receiver-verb-call, receiver: "this.rest" }
    servicePrefixTemplate: "{service}-api"
    serviceRepoTemplate: "svc-{service}"
    openApiPath: "openapi/api.yaml"

report:
  onFailure: "github-issue"
customKey: keep-me
`;

const WITH_SERVICES = CONFIG.replace(
  "\nauth:",
  `
services:
  - repo: "org/svc-a"
    openapi: "api/*.yaml"
    pollIntervalMs: 3000
  - repo: "org/svc-old"

auth:`,
);

/* Inline comments an operator aligned by hand: the writer would collapse the gap if it re-emitted the line. */
const ALIGNED = CONFIG.replace('repo: "org/demo" # primary repo', 'repo: "org/demo"      # primary repo');
const ALIGNED_WITH_SERVICES = WITH_SERVICES.replace('repo: "org/demo" # primary repo', 'repo: "org/demo"      # primary repo');

const CODE_CONFIG = `name: "lib"
repo: "org/lib"
baseBranch: "main"

code: true

qa:
  needsReview: true
  testDataPrefix: "qa-lib"

report:
  onFailure: "github-issue"
`;

/* Reads a patched config the way the loader does: env-expanded, then the app schema. */
function load(yaml: string): ReturnType<typeof AppConfigSchema.parse> {
  return AppConfigSchema.parse(parse(expandEnv(yaml, ENV)));
}

function raw(yaml: string): Record<string, unknown> {
  return parse(yaml) as Record<string, unknown>;
}

test("a patch that supplies nothing returns the config exactly as it came", () => {
  assert.equal(patchAppYaml(CONFIG, {}), CONFIG);
  assert.equal(patchAppYaml(ALIGNED, {}), ALIGNED);
});

test("patching one managed field changes that line and nothing else", () => {
  assert.equal(patchAppYaml(CONFIG, { shadow: false }), CONFIG.replace("shadow: true", "shadow: false"));
  assert.equal(patchAppYaml(CONFIG, { needsReview: false }), CONFIG.replace("needsReview: true", "needsReview: false"));
});

test("a value equal to the one already written is not rewritten", () => {
  assert.equal(patchAppYaml(ALIGNED, { repo: "org/demo", shadow: true, testDataPrefix: "qa-demo", baseBranch: "main" }), ALIGNED);
  assert.equal(patchAppYaml(ALIGNED, { auth: { kind: "form", usernameEnv: "DEMO_USER" } }), ALIGNED);
});

test("a supplied string is written double-quoted and keeps the comment on its line", () => {
  const out = patchAppYaml(CONFIG, { repo: "org/other", testDataPrefix: "qa-other" });
  assert.ok(out.includes('repo: "org/other" # primary repo'));
  assert.ok(out.includes('testDataPrefix: "qa-other" # keeps test data apart'));
});

test("supplied baseUrl replaces a placeholder, while an unsupplied placeholder is never expanded", () => {
  const replaced = patchAppYaml(CONFIG, { baseUrl: "https://new.demo.example" });
  assert.equal((raw(replaced)["dev"] as Record<string, unknown>)["baseUrl"], "https://new.demo.example");
  const untouched = patchAppYaml(CONFIG, { shadow: false });
  assert.ok(untouched.includes("baseUrl: ${DEMO_DEV_URL}"));
  assert.equal(untouched.includes(ENV.DEMO_DEV_URL), false);
});

test("several managed fields patched together leave every unmanaged key, block and comment as it was", () => {
  const out = patchAppYaml(CONFIG, {
    repo: "org/other",
    baseBranch: "trunk",
    baseUrl: "https://new.demo.example",
    versionUrl: "https://new.demo.example/version",
    needsReview: false,
    shadow: false,
    testDataPrefix: "qa-other",
  });
  const before = raw(CONFIG);
  const after = raw(out);
  for (const key of ["name", "openapi", "e2e", "boundaries", "report", "customKey"]) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.deepEqual(after["auth"], before["auth"]);
  assert.deepEqual((after["qa"] as Record<string, unknown>)["changeCoverage"], (before["qa"] as Record<string, unknown>)["changeCoverage"]);
  assert.equal((after["dev"] as Record<string, unknown>)["pollIntervalMs"], 5000);
  assert.ok(out.includes("# Watched app (synthetic fixture)."));
  assert.ok(out.includes("# The DEV site."));
  assert.equal(load(out).repo, "org/other");
});

test("an empty versionUrl removes the key instead of writing an empty string", () => {
  const out = patchAppYaml(CONFIG, { versionUrl: "" });
  assert.equal((raw(out)["dev"] as Record<string, unknown>)["versionUrl"], undefined);
  assert.ok(out.includes("baseUrl: ${DEMO_DEV_URL}"));
});

test("a string with quotes, backslashes and a newline is written so it reads back exactly", () => {
  for (const prefix of ['qa "x"', "qa\\path", "line1\nline2", "qa #not-a-comment", "  padded  "]) {
    const out = patchAppYaml(CONFIG, { testDataPrefix: prefix });
    assert.equal((raw(out)["qa"] as Record<string, unknown>)["testDataPrefix"], prefix, JSON.stringify(prefix));
  }
});

test("auth: supplied keys overwrite, absent keys are kept, and keys the patcher does not know survive", () => {
  const out = patchAppYaml(CONFIG, { auth: { kind: "form", usernameEnv: "OTHER_USER" } });
  const auth = raw(out)["auth"] as Record<string, unknown>;
  assert.equal(auth["kind"], "form");
  assert.equal(auth["usernameEnv"], "OTHER_USER");
  assert.equal(auth["passwordEnv"], "DEMO_PASS");
  assert.equal(auth["futureOption"], "keep-me");
});

test("auth: a form login added to a config that had none is written under a blank line", () => {
  const out = patchAppYaml(CODE_CONFIG.replace("code: true\n\n", ""), {
    baseUrl: "https://dev.demo.example",
    auth: { kind: "form", usernameEnv: "NEW_USER", passwordEnv: "NEW_PASS" },
  });
  const auth = raw(out)["auth"] as Record<string, unknown>;
  assert.equal(auth["kind"], "form");
  assert.equal(auth["usernameEnv"], "NEW_USER");
  assert.equal(auth["passwordEnv"], "NEW_PASS");
  assert.match(out, /\n\nauth:\n/);
  assert.ok(out.includes("kind: form\n"), "the login kind stays a bare keyword");
  assert.ok(out.includes('usernameEnv: "NEW_USER"'), "the variable names are double-quoted");
});

test("auth: a bare `auth:` with nothing under it is replaced by the supplied login", () => {
  const out = patchAppYaml(CONFIG.replace(/auth:\n(?: {2}.*\n)+/, "auth:\n"), { auth: { kind: "form", usernameEnv: "NEW_USER", passwordEnv: "NEW_PASS" } });
  assert.deepEqual(raw(out)["auth"], { kind: "form", usernameEnv: "NEW_USER", passwordEnv: "NEW_PASS" });
});

test("auth: a kind change drops the keys that only the old kind uses and keeps the unknown ones", () => {
  const toMtls = raw(patchAppYaml(CONFIG, { auth: { kind: "mtls", certEnv: "DEMO_CERT", certPassEnv: "DEMO_CERT_PASS" } }))["auth"] as Record<string, unknown>;
  assert.equal(toMtls["kind"], "mtls");
  assert.equal(toMtls["certEnv"], "DEMO_CERT");
  assert.equal(toMtls["usernameEnv"], undefined);
  assert.equal(toMtls["passwordEnv"], undefined);
  assert.equal(toMtls["futureOption"], "keep-me");

  const mtlsConfig = patchAppYaml(CONFIG, { auth: { kind: "mtls", certEnv: "DEMO_CERT", certPassEnv: "DEMO_CERT_PASS" } });
  const backToForm = raw(patchAppYaml(mtlsConfig, { auth: { kind: "form", usernameEnv: "DEMO_USER", passwordEnv: "DEMO_PASS" } }))["auth"] as Record<string, unknown>;
  assert.equal(backToForm["kind"], "form");
  assert.equal(backToForm["certEnv"], undefined);
  assert.equal(backToForm["certPassEnv"], undefined);
});

test("clearAuth removes the auth block and leaves the rest alone", () => {
  const out = patchAppYaml(CONFIG, { clearAuth: true });
  assert.equal(raw(out)["auth"], undefined);
  assert.equal(out, CONFIG.replace(/auth:\n {2}kind: form\n {2}usernameEnv: DEMO_USER\n {2}passwordEnv: DEMO_PASS\n {2}futureOption: keep-me\n\n/, ""));
});

test("a code target sets code: true and drops the keys a code app cannot have", () => {
  const out = patchAppYaml(WITH_SERVICES, { target: "code" });
  const cfg = raw(out);
  assert.equal(cfg["code"], true);
  assert.equal(cfg["auth"], undefined);
  assert.equal(cfg["services"], undefined);
  assert.equal((cfg["dev"] as Record<string, unknown>)["versionUrl"], undefined);
  assert.ok(out.includes("baseUrl: ${DEMO_DEV_URL}"));
  assert.deepEqual(cfg["boundaries"], raw(CONFIG)["boundaries"]);
});

test("an auth or services patch on a code app is not written", () => {
  const out = patchAppYaml(CODE_CONFIG, { auth: { kind: "form", usernameEnv: "X_USER", passwordEnv: "X_PASS" }, services: [{ repo: "org/svc" }] });
  assert.equal(out, CODE_CONFIG);
});

test("an e2e target on a code app removes code: true and writes the DEV url it was given", () => {
  const out = patchAppYaml(CODE_CONFIG, { target: "e2e", baseUrl: "https://dev.demo.example" });
  const cfg = raw(out);
  assert.equal(cfg["code"], undefined);
  assert.equal((cfg["dev"] as Record<string, unknown>)["baseUrl"], "https://dev.demo.example");
  assert.equal(load(out).code, undefined);
});

test("services: the supplied list is the list, and a kept service keeps the keys the patcher does not manage", () => {
  const out = patchAppYaml(WITH_SERVICES, {
    services: [{ repo: "org/svc-a", openapi: "api/v2/*.yaml" }, { repo: "org/svc-b", versionUrl: ENV.DEMO_SVC_URL }],
  });
  const services = raw(out)["services"] as Array<Record<string, unknown>>;
  assert.deepEqual(services.map((s) => s["repo"]), ["org/svc-a", "org/svc-b"]);
  assert.equal(services[0]!["openapi"], "api/v2/*.yaml");
  assert.equal(services[0]!["pollIntervalMs"], 3000);
  assert.equal(services[1]!["versionUrl"], ENV.DEMO_SVC_URL);
  assert.equal(load(out).services?.length, 2);
});

test("services: the same list is patched where it stands, without re-emitting the config", () => {
  const same = [{ repo: "org/svc-a", openapi: "api/*.yaml" }, { repo: "org/svc-old" }];
  assert.equal(patchAppYaml(ALIGNED_WITH_SERVICES, { services: same }), ALIGNED_WITH_SERVICES);
  const out = patchAppYaml(ALIGNED_WITH_SERVICES, { services: [{ repo: "org/svc-a", openapi: "api/v3/*.yaml" }, { repo: "org/svc-old" }] });
  const services = raw(out)["services"] as Array<Record<string, unknown>>;
  assert.deepEqual(services.map((entry) => entry["repo"]), ["org/svc-a", "org/svc-old"]);
  assert.equal(services[0]!["openapi"], "api/v3/*.yaml");
  assert.equal(services[0]!["pollIntervalMs"], 3000);
  assert.ok(out.includes("# primary repo"));
});

test("services: an empty openapi or versionUrl removes that key from the service", () => {
  const out = patchAppYaml(WITH_SERVICES, { services: [{ repo: "org/svc-a", openapi: "" }, { repo: "org/svc-old" }] });
  const services = raw(out)["services"] as Array<Record<string, unknown>>;
  assert.equal(services[0]!["openapi"], undefined);
  assert.equal(services[0]!["pollIntervalMs"], 3000);
});

test("services: an empty list removes the block, and an absent list leaves it alone", () => {
  assert.equal(raw(patchAppYaml(WITH_SERVICES, { services: [] }))["services"], undefined);
  assert.equal(patchAppYaml(WITH_SERVICES, {}), WITH_SERVICES);
});

test("the patched config still reads under the app schema once its placeholders expand", () => {
  const out = patchAppYaml(WITH_SERVICES, {
    baseBranch: "trunk",
    shadow: false,
    auth: { kind: "form", usernameEnv: "OTHER_USER", passwordEnv: "OTHER_PASS" },
    services: [{ repo: "org/svc-a" }],
  });
  const cfg = load(out);
  assert.equal(cfg.baseBranch, "trunk");
  assert.equal(cfg.qa.shadow, false);
  assert.equal(cfg.dev?.baseUrl, ENV.DEMO_DEV_URL);
  assert.equal(cfg.e2e?.testIdAttribute, "data-cy");
  assert.equal(cfg.qa.changeCoverage?.mode, "enforce");
  assert.equal(cfg.boundaries?.length, 1);
  assert.equal(cfg.auth?.usernameEnv, "OTHER_USER");
});

test("a config the YAML parser rejects is refused, never written over", () => {
  assert.throws(() => patchAppYaml("name: [unclosed\nrepo: x\n", { shadow: false }), /./);
});
