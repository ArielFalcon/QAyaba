import { test } from "node:test";
import assert from "node:assert/strict";
import { STEP_INTENTS, classifyStepIntents, type StepIntentContext, type StepCall } from "@contexts/generation/domain/step-intent.ts";

const e2eApp: StepIntentContext = {
  specTargets: { kind: "dir", relDir: "e2e" },
  authFiles: ["e2e/auth.setup.ts"],
  loginUrls: ["https://app.example/signin"],
  authOnlyOrigins: [],
  reviewAgents: ["qa-reviewer"],
};
const codeApp: StepIntentContext = { ...e2eApp, specTargets: { kind: "any-write" }, authFiles: [], loginUrls: [] };
const ssoApp: StepIntentContext = { ...e2eApp, loginUrls: ["https://sso.example/login"], authOnlyOrigins: ["https://sso.example"] };

const call = (tool: string, bucket: StepCall["bucket"], extra: Partial<StepCall> = {}): StepCall => ({ tool, bucket, targetKind: null, target: null, ...extra });
const read = (relPath: string) => call("read", "code_read", { targetKind: "path", target: relPath, relPath });
const write = (relPath: string) => call("write", "write", { targetKind: "path", target: relPath, relPath });
const navigate = (url: string, tool = "playwright_browser_navigate") => call(tool, "browser", { targetKind: "url", target: url });
const intents = (ctx: StepIntentContext, agent: string, ...steps: StepCall[][]) => classifyStepIntents(steps.map((calls) => ({ calls })), ctx, agent);

test("a write under the app's spec directory is writing a spec; elsewhere it is not", () => {
  assert.deepEqual(intents(e2eApp, "qa-author", [write("e2e/flows/cart.spec.ts")], [write("src/app.ts")]), ["write_spec", "other"]);
});

test("a code-target app declares that every write is a test", () => {
  assert.deepEqual(intents(codeApp, "qa-author", [write("src/test/CartTest.java")]), ["write_spec"]);
});

test("running a spec is run_spec, even next to a write", () => {
  assert.deepEqual(intents(e2eApp, "qa-author", [call("run_spec", "other"), write("e2e/a.spec.ts")]), ["run_spec"]);
});

test("touching the declared auth setup file is auth, a write to it included", () => {
  assert.deepEqual(intents(e2eApp, "qa-author", [read("e2e/auth.setup.ts")], [write("e2e/auth.setup.ts")]), ["auth", "auth"]);
});

test("navigating to the declared login url, then typing on that page, is auth until the agent leaves it", () => {
  const steps = [
    [navigate("https://app.example/signin")],
    [call("playwright_browser_type", "browser", { targetKind: "element", target: "Email" })],
    [navigate("https://app.example/dashboard")],
    [call("playwright_browser_click", "browser", { targetKind: "element", target: "Cart" })],
  ];
  assert.deepEqual(intents(e2eApp, "qa-author", ...steps), ["auth", "auth", "explore", "explore"]);
});

test("a login on another origin classifies by the declared origin, not by a name", () => {
  assert.deepEqual(intents(ssoApp, "qa-author", [navigate("https://sso.example/anything/at/all")], [navigate("https://app.example/home")]), ["auth", "explore"]);
  assert.deepEqual(intents(e2eApp, "qa-author", [navigate("https://sso.example/anything/at/all")]), ["explore"]);
});

test("an app with no declared login never reads a path named like one as auth", () => {
  assert.deepEqual(intents(codeApp, "qa-author", [navigate("https://app.example/login")]), ["explore"]);
});

test("the authenticated browser's tools count as browser calls", () => {
  assert.deepEqual(intents(ssoApp, "qa-author", [navigate("https://sso.example/login", "authbrowser_navigate")], [call("authbrowser_snapshot", "other")]), ["auth", "auth"]);
  assert.deepEqual(intents(e2eApp, "qa-author", [call("authbrowser_snapshot", "other")]), ["explore"]);
});

test("reads, searches, the browser and memory are exploring", () => {
  assert.deepEqual(intents(e2eApp, "qa-author", [read("src/a.ts")], [call("grep", "code_read")], [call("mem_search", "memory")]), ["explore", "explore", "explore"]);
});

test("a reviewer's steps are review work", () => {
  assert.deepEqual(intents(e2eApp, "qa-reviewer", [read("e2e/a.spec.ts")], [navigate("https://app.example/home")]), ["review", "review"]);
});

test("a step with no call, or only unclassifiable ones, is other", () => {
  assert.deepEqual(intents(e2eApp, "qa-author", [], [call("todowrite", "other")]), ["other", "other"]);
});

test("every intent the classifier answers is a member of the exported set", () => {
  const answered = intents(e2eApp, "qa-author", [write("e2e/a.spec.ts")], [call("run_spec", "other")], [read("e2e/auth.setup.ts")], [], [read("src/a.ts")]);
  for (const intent of answered) assert.ok((STEP_INTENTS as readonly string[]).includes(intent), intent);
});
