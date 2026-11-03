import { test } from "node:test";
import assert from "node:assert/strict";
import { readAgentBrowserAnswer } from "@kernel/agent-browser.ts";

const full = JSON.stringify({ ok: true, page: { url: "https://app.example/dashboard", title: "Dashboard", snapshot: "- heading Welcome", status: 200 }, blocked: [], requests: { listed: [], otherHosts: [], omitted: 0 }, notes: [], budget: { callsLeft: 9 } });

test("the facts of an answer are its fields, whether it arrives as text or as a value", () => {
  assert.deepEqual(readAgentBrowserAnswer(full), { ok: true, url: "https://app.example/dashboard", documentStatus: 200 });
  assert.deepEqual(readAgentBrowserAnswer(JSON.parse(full)), { ok: true, url: "https://app.example/dashboard", documentStatus: 200 });
});

test("a refusal carries its code, and a code outside the closed set names nothing", () => {
  assert.deepEqual(readAgentBrowserAnswer(JSON.stringify({ ok: false, code: "blocked", message: "POST /api/x would write to DEV" })), { ok: false, code: "blocked" });
  assert.deepEqual(readAgentBrowserAnswer(JSON.stringify({ ok: false, code: "something-else" })), { ok: false });
});

test("an answer cut short is not an answer: the prefix of the JSON never parses", () => {
  assert.equal(readAgentBrowserAnswer(full.slice(0, 120)), undefined);
  assert.equal(readAgentBrowserAnswer(""), undefined);
});

test("another tool's text names no facts", () => {
  assert.equal(readAgentBrowserAnswer("### Ran Playwright code\nawait page.goto('/x');\n\n### Page state\n- Page URL: https://app.example/x"), undefined);
});

test("a value that is not an object or holds no `ok` names nothing", () => {
  assert.equal(readAgentBrowserAnswer(42), undefined);
  assert.equal(readAgentBrowserAnswer(null), undefined);
  assert.equal(readAgentBrowserAnswer("[]"), undefined);
  assert.equal(readAgentBrowserAnswer(JSON.stringify({ page: { url: "https://app.example/x" } })), undefined);
});
