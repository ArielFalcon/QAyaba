/*
 * The console's LLM gateway key panel (console.js over api.js), booted in live mode against a
 * scripted control API. Assertions read what the operator sees and what the browser asks of the
 * server; the key itself must reach the server and nowhere else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appView, controlApi, loadConsole, type ConsoleRequest, type Reply } from "./console-harness";

const KEY = "Zk8#mQ2!vL9-gateway";
const KEY_FIELD = "agent-key";

function agentConfig(keySet: boolean, status: string, error?: string) {
  const assignment = { provider: "opencode", model: "m" };
  return {
    mode: "single",
    singleProvider: "opencode",
    assignments: { primary: assignment, reviewer: assignment, chat: assignment },
    keys: { opencode: keySet, codex: false },
    validation: { ok: keySet, errors: [] },
    health: {
      opencode: { provider: "opencode", status, configured: keySet, ...(error ? { error } : {}) },
      codex: { provider: "codex", status: "needs_config", configured: false },
    },
  };
}

/* A control API whose agent runtime starts as `initial` and moves to `afterApply` once a key is accepted. */
function consoleWith(opts: {
  initial: ReturnType<typeof agentConfig> | null;
  afterApply?: ReturnType<typeof agentConfig>;
  put?: (req: ConsoleRequest) => Reply;
}) {
  let current = opts.initial;
  return controlApi({
    apps: [appView("shop")],
    runs: [],
    extra: (req) => {
      if (req.path !== "/api/v1/agent/config") return undefined;
      if (req.method === "PUT") {
        const reply = opts.put?.(req) ?? { status: 200, json: { config: opts.afterApply ?? current, restarted: ["opencode"] } };
        if (reply.status === 200 && opts.afterApply) current = opts.afterApply;
        return reply;
      }
      return current ? { status: 200, json: current } : { status: 404, json: { error: "not found" } };
    },
  });
}

/* Everything the console writes to the browser console while `fn` runs. */
async function consoleOutputDuring(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original = Object.fromEntries(methods.map((m) => [m, console[m]]));
  for (const m of methods) console[m] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    for (const m of methods) console[m] = original[m] as never;
  }
  return lines.join("\n");
}

const puts = (h: { requests: ConsoleRequest[] }) => h.requests.filter((r) => r.method === "PUT" && r.path === "/api/v1/agent/config");

test("the panel tells the operator that no key is set and the provider needs configuration", async () => {
  const h = await loadConsole({ withConsole: true, token: "t", routes: consoleWith({ initial: agentConfig(false, "needs_config") }) });

  assert.match(h.text(), /no key/i);
  assert.match(h.text(), /needs config/i);
});

test("the panel shows a set key and a healthy provider", async () => {
  const h = await loadConsole({ withConsole: true, token: "t", routes: consoleWith({ initial: agentConfig(true, "healthy") }) });

  assert.match(h.text(), /key set/i);
  assert.match(h.text(), /healthy/i);
  assert.doesNotMatch(h.text(), /needs config/i);
});

test("the panel shows the provider's failure detail", async () => {
  const h = await loadConsole({ withConsole: true, token: "t", routes: consoleWith({ initial: agentConfig(true, "failed", "opencode exited 1") }) });

  assert.match(h.text(), /failed/i);
  assert.match(h.text(), /opencode exited 1/);
});

test("the panel is still usable when the agent status cannot be read", async () => {
  const h = await loadConsole({ withConsole: true, token: "t", routes: consoleWith({ initial: null }) });

  h.type(KEY_FIELD, KEY);
  h.click("agent-key-apply");
  await h.advance(1_000);

  assert.equal(puts(h).length, 1);
});

test("applying a key sends it to the server and then shows the refreshed status", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: consoleWith({ initial: agentConfig(false, "needs_config"), afterApply: agentConfig(true, "healthy") }),
  });

  h.type(KEY_FIELD, KEY);
  h.click("agent-key-apply");
  await h.advance(1_000);

  const sent = puts(h);
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0]!.body as { apiKeys?: { opencode?: string } }).apiKeys, { opencode: KEY });
  assert.equal(sent[0]!.headers.authorization, "Bearer t");
  assert.match(h.text(), /key set/i);
  assert.match(h.text(), /healthy/i);
  assert.doesNotMatch(h.text(), /needs config/i);
});

test("a provider that is still starting is checked again once it has had time to come up", async () => {
  /* The status the console reads, in order: before the key, right after applying it, then once the provider is up. */
  const reads = [agentConfig(false, "needs_config"), agentConfig(true, "starting")];
  let read = 0;
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: controlApi({
      apps: [appView("shop")],
      runs: [],
      extra: (req) => {
        if (req.path !== "/api/v1/agent/config") return undefined;
        if (req.method === "PUT") return { status: 200, json: { config: agentConfig(true, "starting"), restarted: ["opencode"] } };
        return { status: 200, json: reads[read++] ?? agentConfig(true, "healthy") };
      },
    }),
  });

  h.type(KEY_FIELD, KEY);
  h.click("agent-key-apply");
  await h.advance(1_000);
  assert.match(h.text(), /starting/i);

  await h.advance(10_000);

  assert.match(h.text(), /healthy/i);
});

test("the key is cleared from the field and never stored, shown, put in a URL or logged", async () => {
  let h!: Awaited<ReturnType<typeof loadConsole>>;
  const logged = await consoleOutputDuring(async () => {
    h = await loadConsole({
      withConsole: true,
      token: "t",
      routes: consoleWith({ initial: agentConfig(false, "needs_config"), afterApply: agentConfig(true, "healthy") }),
    });
    h.type(KEY_FIELD, KEY);
    h.click("agent-key-apply");
    await h.advance(1_000);
  });

  assert.equal(h.fieldValue(KEY_FIELD), "");
  assert.ok(![...h.storage.values()].some((v) => v.includes(KEY)), "not in session storage");
  assert.ok(!h.text().includes(KEY), "not rendered");
  assert.ok(!h.toastText().includes(KEY), "not in a toast");
  assert.ok(!logged.includes(KEY), "not logged");
  assert.ok(!h.requests.some((r) => r.path.includes(KEY) || encodeURIComponent(r.path).includes(encodeURIComponent(KEY))), "not in any URL");
});

test("the field is cleared even when the server refuses the key", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: consoleWith({ initial: agentConfig(false, "needs_config"), put: () => ({ status: 422, json: { error: "OPENCODE_API_KEY is required" } }) }),
  });

  h.type(KEY_FIELD, KEY);
  h.click("agent-key-apply");
  await h.advance(1_000);

  assert.equal(h.fieldValue(KEY_FIELD), "");
});

test("a key refused while a run is active asks the operator to apply it when the run finishes", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: consoleWith({
      initial: agentConfig(true, "healthy"),
      put: () => ({ status: 409, json: { error: "agent runtime cannot be changed while a run or agent session is active" } }),
    }),
  });

  h.type(KEY_FIELD, KEY);
  h.click("agent-key-apply");
  await h.advance(1_000);

  assert.match(h.text(), /run is in progress/i);
  assert.match(h.text(), /when it finishes/i);
});

test("a key the server rejects is reported with the server's own reason", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: consoleWith({ initial: agentConfig(false, "needs_config"), put: () => ({ status: 422, json: { error: "reviewer model is not available" } }) }),
  });

  h.type(KEY_FIELD, KEY);
  h.click("agent-key-apply");
  await h.advance(1_000);

  assert.match(h.text(), /reviewer model is not available/);
});

test("a rejection that echoes the key does not show it", async () => {
  const h = await loadConsole({
    withConsole: true,
    token: "t",
    routes: consoleWith({ initial: agentConfig(false, "needs_config"), put: () => ({ status: 422, json: { error: `bad credentials ${KEY}` } }) }),
  });

  h.type(KEY_FIELD, KEY);
  h.click("agent-key-apply");
  await h.advance(1_000);

  assert.match(h.text(), /bad credentials/);
  assert.ok(!h.text().includes(KEY));
});

test("an empty field sends nothing and asks for a key", async () => {
  const h = await loadConsole({ withConsole: true, token: "t", routes: consoleWith({ initial: agentConfig(false, "needs_config") }) });

  h.type(KEY_FIELD, "   ");
  h.click("agent-key-apply");
  await h.advance(1_000);

  assert.equal(puts(h).length, 0);
  assert.match(h.text(), /paste/i);
});

test("the data layer sends the key as the OpenCode key of a PUT to the agent config", async () => {
  const h = await loadConsole({ routes: consoleWith({ initial: agentConfig(false, "needs_config") }) });

  await h.api.applyAgentKey(KEY);

  const sent = puts(h);
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0]!.body as { apiKeys?: unknown }).apiKeys, { opencode: KEY });
});

test("the data layer reports a refusal with its status and the server's reason", async () => {
  const h = await loadConsole({
    routes: consoleWith({ initial: agentConfig(true, "healthy"), put: () => ({ status: 409, json: { error: "busy" } }) }),
  });

  await assert.rejects(
    () => h.api.applyAgentKey(KEY),
    (err: { status?: number; reason?: string }) => err.status === 409 && err.reason === "busy",
  );
});

test("in the offline demo console the panel renders and applying a key contacts no server", async () => {
  const h = await loadConsole({ mode: "mock", withConsole: true, routes: () => ({ status: 404, json: {} }) });

  assert.match(h.text(), /key/i);
  h.type(KEY_FIELD, KEY);
  h.click("agent-key-apply");
  await h.advance(1_000);

  assert.equal(h.requests.length, 0);
});
