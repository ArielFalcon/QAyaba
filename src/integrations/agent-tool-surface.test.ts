/* that WIDENING it requires a conscious update here. The ADR-001 evaluation rejected exposing the
   orchestrator as an MCP server, but kept its best idea: "the agent only reads + proposes". The two
   dangerous ways that erodes silently are (a) adding an MCP server that can execute the
   authoritative test suite or reach the orchestrator's write path, and (b) flipping a read-only
   judge/assistant/reflector to writable or MCP-capable. Both should force a pause.
   array. It does not exist in the OpenCode 1.17.7 SDK's `AgentConfig` — verified
   against `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`, which declares `tools?:
   {[key:string]: boolean}`, `maxSteps?: number`, `permission?`, `mode?`, and NO `mcp` key. The old
   test was certifying a security posture the runtime never enforced (the fictional field was
   silently ignored by OpenCode). The step cap goes by two names: `steps` (declared by the v2
   `AgentConfig`, and what `GET /agent` returns) and the legacy `maxSteps`, which the server maps into
   it. This version:
   (a) pins the config against the SDK's real `AgentConfig` type at compile time (below);
   (b) asserts the fiction is gone (no per-agent `mcp` arrays) and that an agent names its step cap once;
   (c) asserts the REAL denial mechanism — `tools.<key>: false` — covers every MCP toolset for
   read-only/tool-less roles.
   Empirical grounding (done in-slice, not assumed): started a real `opencode serve` (v1.17.13,
   closest available to the pinned 1.17.7) against an isolated probe config and used
   `opencode debug agent <name>` to inspect the RESOLVED agent. Confirmed a controlled A/B: an agent
   with a `"<server>*": false` key in `tools` resolves to a `{ permission: "<server>*", action: "deny",
   pattern: "*" }` rule; an otherwise-identical agent without that key has no such rule. So the
   `tools` map's keys are NOT restricted to the built-in tool names — arbitrary string keys
   (including glob-shaped ones like `serena*`) compile into real permission-deny rules. Separately,
   probing the real Playwright MCP server directly (raw JSON-RPC `tools/list` against
   `npx @playwright/mcp`) showed its tools are not prefixed with its own server name: it exposes
   `browser_navigate`, `browser_click`, etc. Serena's tool names are documented in this repo's own
   prompts (`agents/AGENTS.md`, `agents/agent/*.md`) as `find_symbol`, `get_symbols_overview`,
   `find_referencing_symbols`, `activate_project`, etc. — same unprefixed convention. What the
   server itself lists is not what the runtime reports: OpenCode namespaces an MCP tool with its
   server name, and the run telemetry (`run_events` tool names) shows them as
   `playwright_browser_navigate`, never `browser_navigate`. So the config uses BELT-AND-BRACES: both the
   wildcard key (`"playwright*": false`, verified to compile) AND the enumerated per-tool names
   (`browser_navigate: false`, `find_symbol: false`, etc.) — harmless if one form turns out
   redundant, safe if only one form is honored. An agent that holds a server but is deliberately
   denied some of its tools has no wildcard to lean on, so it names the runtime's prefixed id
   (the load-bearing denial) and the bare twin; DELIBERATE_MCP_TOOL_DENIALS lists exactly those.
   If you trip this test, you are changing the security posture — update the allowlist
   deliberately, and confirm the new capability cannot write a watched repo or trigger the
   authoritative Filter-C run (which is the orchestrator's job, never the agent's).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "@opencode-ai/sdk";
import { AGENT_NAME_FOR_ROLE, capabilitiesForRole } from "../agent-runtime/types";
import { AGENT_BROWSER_TOOLS } from "../../qa-engine/src/shared-kernel/agent-browser";
import { CODE_GRAPH_AGENT, CODE_GRAPH_TOOLS } from "../../qa-engine/src/shared-kernel/code-graph-tools";
import { AGENT_BROWSER_AGENTS } from "../../qa-engine/src/contexts/test-execution/domain/agent-browser-capability";
import { NO_TOOLS } from "./opencode-client";
import type { AgentRole } from "../agent-runtime/types";

/* The ONLY MCP servers the agents may reach. None of these runs the orchestrator's
   authoritative test execution or carries a git-write capability:
   serena — read-only code navigation
   playwright — LIVE DEV *exploration* while authoring (NOT the authoritative suite run)
   No memory server: no role keeps a memory across runs (see the test that pins it).
 */
const MCP_ALLOWLIST = new Set(["serena", "playwright"]);

/* Real, unprefixed MCP tool names per server (empirically confirmed for playwright via raw
   JSON-RPC `tools/list`; sourced from this repo's own Serena prompt references for serena — see the
   header comment). These are the enumeration half of the belt-and-braces denial.
 */
const PLAYWRIGHT_TOOL_NAMES = [
  "browser_close",
  "browser_resize",
  "browser_console_messages",
  "browser_handle_dialog",
  "browser_evaluate",
  "browser_file_upload",
  "browser_drop",
  "browser_fill_form",
  "browser_press_key",
  "browser_type",
  "browser_navigate",
  "browser_navigate_back",
  "browser_network_requests",
  "browser_network_request",
  "browser_run_code_unsafe",
  "browser_take_screenshot",
  "browser_snapshot",
  "browser_click",
  "browser_drag",
  "browser_hover",
  "browser_select_option",
  "browser_tabs",
  "browser_wait_for",
];

/* Grounding honesty for this list: Serena could NOT be probed offline (not installed on this host;
   it lives only in the agents Docker image). Only the first four names — activate_project,
   find_symbol, find_referencing_symbols, get_symbols_overview — are grounded in this repo's own
   prompt files (agents/AGENTS.md, agents/agent/qa-proposer.md, qa-generator.md).
   The remaining names are best-effort from upstream Serena documentation and were NOT verified
   against the pinned server. The wildcard "serena*" key (empirically verified to compile into a
   permission-deny rule — see the header comment) is the actual load-bearing denial; this
   enumeration is the harmless redundant half of the belt-and-braces.
 */
const SERENA_TOOL_NAMES = [
  "activate_project",
  "find_symbol",
  "find_referencing_symbols",
  "get_symbols_overview",
  "search_for_pattern",
  "list_dir",
  "find_file",
  "read_memory",
  "write_memory",
  "list_memories",
  "delete_memory",
  "insert_after_symbol",
  "insert_before_symbol",
  "replace_symbol_body",
  "execute_shell_command",
  "restart_language_server",
  "check_onboarding_performed",
  "onboarding",
  "think_about_collected_information",
  "think_about_task_adherence",
  "think_about_whether_you_are_done",
  "prepare_for_new_conversation",
  "switch_modes",
];

const MCP_TOOL_NAMES_BY_SERVER: Record<string, string[]> = {
  serena: SERENA_TOOL_NAMES,
  playwright: PLAYWRIGHT_TOOL_NAMES,
};

type ToolDenials = Readonly<Record<string, Readonly<Record<string, string>>>>;

const ARBITRARY_CODE_REASON =
  "It runs code of the agent's own choosing in the page or in the browser process. Live DEV is observed while " +
  "authoring (navigate, snapshot, click, type); a script that logs in and submits a record writes to DEV outside " +
  "the harness and without the app's test-data prefix. Code that touches DEV belongs in a generated spec.";

const FILE_PUSH_REASON =
  "It pushes a file from the agent's disk into the live app (an upload, a drop). An upload is a write to DEV, " +
  "which only a generated spec may do, under the app's test-data prefix.";

const SHELL_REASON =
  "A shell tool of the code-navigation server would be a second route around the denial of the built-in shell.";

/* What a role that authors against live DEV is denied of the servers it holds. The Playwright ids are the
   ones the MCP lists (`tools/list` of `@playwright/mcp`, PLAYWRIGHT_TOOL_NAMES); the runtime reports them
   prefixed with the server name. */
const AUTHORING_EXECUTION_DENIALS: Readonly<Record<string, string>> = {
  playwright_browser_run_code_unsafe: ARBITRARY_CODE_REASON,
  playwright_browser_evaluate: ARBITRARY_CODE_REASON,
  playwright_browser_file_upload: FILE_PUSH_REASON,
  playwright_browser_drop: FILE_PUSH_REASON,
  serena_execute_shell_command: SHELL_REASON,
};

/* Tools of a server an agent otherwise holds that it is DELIBERATELY denied, by agent and then by the
   id the runtime reports (server name, an underscore, the tool), each with the reason. The prefixed
   id is the denial that binds; its bare twin is the redundant half of the belt-and-braces. Adding an
   entry is a decision, so it lives here with its reason rather than as a silent hole in the
   allowed-server checks.
 */
const DELIBERATE_MCP_TOOL_DENIALS: ToolDenials = {
  "qa-generator": AUTHORING_EXECUTION_DENIALS,
  "qa-sidekick": AUTHORING_EXECUTION_DENIALS,
};

const BUILTIN_TOOL_KEYS = new Set([
  "write",
  "edit",
  "read",
  "bash",
  "webfetch",
  "glob",
  "grep",
  "task",
  "todowrite",
  "websearch",
  "skill",
  "question",
  "invalid",
  "apply_patch",
]);

/* Tools the repo ships itself (agents/tool/*.ts) rather than OpenCode or an MCP server: run_spec lets an authoring role ask the orchestrator to run a spec it wrote, and set_geolocation moves the run's authoring location. */
const CUSTOM_TOOL_KEYS = new Set<string>(["run_spec", "set_geolocation", ...AGENT_BROWSER_TOOLS, ...CODE_GRAPH_TOOLS]);

function loadRawConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(process.cwd(), "agents", "opencode.json"), "utf8")) as Record<string, unknown>;
}

function loadAgentConfig(): { agents: Record<string, unknown>; mcpServers: string[] } {
  const raw = loadRawConfig();
  const agent = (raw.agent && typeof raw.agent === "object" ? raw.agent : {}) as Record<string, unknown>;
  const mcp = (raw.mcp && typeof raw.mcp === "object" ? raw.mcp : {}) as Record<string, unknown>;
  return { agents: agent, mcpServers: Object.keys(mcp) };
}

function agentTools(agent: unknown): Record<string, unknown> {
  if (!agent || typeof agent !== "object") return {};
  const tools = (agent as Record<string, unknown>).tools;
  return tools && typeof tools === "object" ? (tools as Record<string, unknown>) : {};
}

/* The names an agent's step cap goes by: `steps`, which the SDK's v2 AgentConfig declares and the server
   returns, and the legacy `maxSteps`, which the server maps into it (`steps` first). */
const STEP_CAP_FIELDS = ["steps", "maxSteps"] as const;

/* What is wrong with the step cap an agent declares, or undefined: both names at once (the server reads
   `steps` and ignores `maxSteps`, so one of the two numbers is dead) or no numeric cap at all. */
function stepCapProblem(agent: unknown): string | undefined {
  const cfg = agent as Record<string, unknown>;
  const declared = STEP_CAP_FIELDS.filter((field) => field in cfg);
  if (declared.length > 1) return `declares both ${declared.join(" and ")}`;
  const [only] = declared;
  return only !== undefined && typeof cfg[only] === "number" ? undefined : `declares no numeric step cap (${STEP_CAP_FIELDS.join(" or ")})`;
}

/* Type-level tripwire: every declared agent must structurally satisfy the SDK's REAL
   AgentConfig type. This forces a compile error the moment someone re-introduces a field the SDK
   does not recognize as a KNOWN key with the wrong shape (e.g. `mode: "invalid-value"`), or a wrong
   type for a known key (e.g. `maxSteps: "50"` as a string). Note `AgentConfig` carries a permissive
   index signature (`[key: string]: unknown | ...`), so this does NOT catch unknown extra keys by
   itself — that is what the runtime-shape assertions below are for.
 */
function assertAgentConfigShape(agents: Record<string, unknown>): void {
  for (const [name, cfg] of Object.entries(agents)) {
    const typed: AgentConfig = cfg as AgentConfig;
    /* Touch a couple of known fields so this is a real assignment-compatibility check, not a
       no-op cast that the compiler could elide.
     */
    void typed.model;
    void typed.mode;
    void typed.maxSteps;
    void typed.tools;
    if (!typed) throw new Error(`unreachable: ${name}`);
  }
}

test("every agent in opencode.json structurally satisfies the SDK's AgentConfig type", () => {
  const { agents } = loadAgentConfig();
  assert.ok(Object.keys(agents).length > 0, "expected opencode.json to declare agents");
  assertAgentConfigShape(agents);
});

test("the fiction is gone: no per-agent `mcp` array remains", () => {
  const { agents } = loadAgentConfig();
  for (const [name, agent] of Object.entries(agents)) {
    const cfg = agent as Record<string, unknown>;
    assert.equal(
      "mcp" in cfg,
      false,
      `SECURITY: agent "${name}" still declares a per-agent "mcp" array. This key is not part of the ` +
        `OpenCode 1.17.7 AgentConfig and is silently ignored by the runtime — it is inert and must not ` +
        `be reintroduced as a stand-in for real tool denial.`,
    );
  }
});

test("an agent names its step cap once: `steps`, or the legacy `maxSteps` the server maps into it", () => {
  assert.equal(stepCapProblem({ steps: 40 }), undefined);
  assert.equal(stepCapProblem({ maxSteps: 30 }), undefined);
  assert.match(stepCapProblem({ steps: 40, maxSteps: 30 })!, /both steps and maxSteps/, "the server reads steps and ignores maxSteps, so naming both hides one of them");
  assert.match(stepCapProblem({})!, /no numeric step cap/);
  assert.match(stepCapProblem({ steps: "40" })!, /no numeric step cap/);
});

test("no dead top-level compaction/tool_output keys remain in opencode.json", () => {
  const raw = loadRawConfig();
  assert.equal("compaction" in raw, false, "top-level 'compaction' is not part of AgentConfig/opencode.json's real schema and was inert");
  assert.equal("tool_output" in raw, false, "top-level 'tool_output' is not part of AgentConfig/opencode.json's real schema and was inert");
});

test("every agent in opencode.json declares one numeric step cap", () => {
  const { agents } = loadAgentConfig();
  for (const [name, agent] of Object.entries(agents)) {
    assert.equal(stepCapProblem(agent), undefined, `agent "${name}": ${stepCapProblem(agent)}`);
  }
});

test("no agent's tools map denies with a bare global wildcard (would kill built-ins)", () => {
  const { agents } = loadAgentConfig();
  for (const [name, agent] of Object.entries(agents)) {
    const tools = agentTools(agent);
    assert.equal(
      Object.prototype.hasOwnProperty.call(tools, "*"),
      false,
      `SECURITY: agent "${name}" has a bare "*" key in tools{} — this would deny/allow every tool ` +
        `indiscriminately, including built-in read/write/edit, which is never the intent here.`,
    );
  }
});

test("every declared MCP server is on the agent allowlist (catches a new tool surface)", () => {
  const { mcpServers } = loadAgentConfig();
  /* Meaningfulness guard: there is a real, non-empty MCP block to check. */
  assert.ok(mcpServers.length > 0, "expected opencode.json to declare MCP servers");
  for (const server of mcpServers) {
    assert.ok(
      MCP_ALLOWLIST.has(server),
      `SECURITY: opencode.json declares an MCP server "${server}" not on the agent allowlist {${[...MCP_ALLOWLIST].join(", ")}}. ` +
        `Adding an MCP server widens the agent's capability surface — confirm it cannot write a watched repo or run the authoritative suite, then add it here on purpose.`,
    );
  }
});

/* No role carries a memory from one run to the next. A memory the agent writes holds what it believed, with no
   SHA, no expiry and no check against DEV: beliefs about DEV's data and a hypothesis a failing run had not yet
   tested came back in later runs as facts and outranked what the Context Pack read live. What a run may reuse
   reaches it from the orchestrator (the suite store, the governed learning ledger, the Context Pack). */
test("no role keeps a memory across runs: no memory server is declared and no agent names one", () => {
  const { agents, mcpServers } = loadAgentConfig();
  assert.equal(mcpServers.includes("engram"), false, "opencode.json must not declare the engram memory server");
  for (const [name, agent] of Object.entries(agents)) {
    const memoryKeys = Object.keys(agentTools(agent)).filter((key) => /^(engram|mem_)/.test(key));
    assert.deepEqual(memoryKeys, [], `agent "${name}" still names memory tools`);
  }
});

/* Belt-and-braces denial check: for a role that must NOT reach a given MCP server, both the
   wildcard key (`"<server>*": false`) AND every enumerated real tool name for that server must be
   explicitly denied (`false`) in the agent's `tools` map. This is deliberately redundant — whichever
   mechanism OpenCode actually honors at runtime, the deny is present.
 */
function assertMcpServerDenied(agentName: string, tools: Record<string, unknown>, server: string): void {
  const wildcardKey = `${server}*`;
  assert.equal(
    tools[wildcardKey],
    false,
    `SECURITY: agent "${agentName}" must deny the "${wildcardKey}" wildcard tool key for the "${server}" MCP server.`,
  );
  const names = MCP_TOOL_NAMES_BY_SERVER[server] ?? [];
  assert.ok(names.length > 0, `no known real tool-name enumeration for MCP server "${server}" — test setup bug`);
  for (const toolName of names) {
    assert.equal(
      tools[toolName],
      false,
      `SECURITY: agent "${agentName}" must explicitly deny "${toolName}" (a real "${server}" MCP tool) — ` +
        `relying on the wildcard alone is not verifiable offline against the pinned OpenCode version.`,
    );
  }
}

/* The ids an agent's exemption list names for a server: the runtime's prefixed ids and their bare
   twins. */
function exemptedToolIds(
  agentName: string,
  server: string,
  denials: ToolDenials,
): { prefixed: string[]; bare: string[] } {
  const prefix = `${server}_`;
  const prefixed = Object.keys(denials[agentName] ?? {}).filter((id) => id.startsWith(prefix));
  return { prefixed, bare: prefixed.map((id) => id.slice(prefix.length)) };
}

/* An agent that is designed to use a server keeps every one of its tools except the ones its
   exemption list names, and those it must deny — under the prefixed id and the bare one. */
function assertMcpServerAllowed(
  agentName: string,
  tools: Record<string, unknown>,
  server: string,
  denials: ToolDenials = DELIBERATE_MCP_TOOL_DENIALS,
): void {
  const wildcardKey = `${server}*`;
  assert.notEqual(
    tools[wildcardKey],
    false,
    `agent "${agentName}" is designed to use the "${server}" MCP server but its tools{} denies "${wildcardKey}".`,
  );
  const { prefixed, bare } = exemptedToolIds(agentName, server, denials);
  for (const id of [...prefixed, ...bare]) {
    assert.equal(
      tools[id],
      false,
      `SECURITY: agent "${agentName}" deliberately denies the "${server}" tool "${id}" but its tools{} does not.`,
    );
  }
  const names = MCP_TOOL_NAMES_BY_SERVER[server] ?? [];
  for (const toolName of names) {
    if (bare.includes(toolName)) continue;
    assert.notEqual(
      tools[toolName],
      false,
      `agent "${agentName}" is designed to use the "${server}" MCP server but denies its real tool "${toolName}".`,
    );
    assert.notEqual(
      tools[`${server}_${toolName}`],
      false,
      `agent "${agentName}" is designed to use the "${server}" MCP server but denies its prefixed tool "${server}_${toolName}".`,
    );
  }
}

/* The tools of a server an agent's map denies, under either id. */
function deniedToolIdsOf(tools: Record<string, unknown>, server: string): string[] {
  const known = new Set((MCP_TOOL_NAMES_BY_SERVER[server] ?? []).flatMap((name) => [name, `${server}_${name}`]));
  return Object.keys(tools)
    .filter((key) => tools[key] === false && known.has(key))
    .sort();
}

/* For an agent that holds a server, the tools it denies are exactly the ones its exemption list names:
   a denial nobody listed and a listed tool nobody denies both fail. */
function assertDeniedToolsAreTheExemptionList(
  agentName: string,
  tools: Record<string, unknown>,
  server: string,
  denials: ToolDenials = DELIBERATE_MCP_TOOL_DENIALS,
): void {
  const { prefixed, bare } = exemptedToolIds(agentName, server, denials);
  assert.deepEqual(
    deniedToolIdsOf(tools, server),
    [...prefixed, ...bare].sort(),
    `SECURITY: agent "${agentName}" holds the "${server}" MCP server, so the tools it denies must be exactly the ones ` +
      `DELIBERATE_MCP_TOOL_DENIALS lists for it.`,
  );
}

test("the reviewer is a non-mutating judge with NO MCP access (independence + read-only, runtime-enforced)", () => {
  const { agents } = loadAgentConfig();
  const reviewer = agents["qa-reviewer"];
  assert.ok(reviewer, "expected a qa-reviewer agent");
  const tools = agentTools(reviewer);
  /* Meaningfulness guard: an absent `tools` block would make every read-only check below
     pass vacuously (and may inherit permissive defaults). Require it to be explicit.
   */
  assert.ok(Object.keys(tools).length > 0, "qa-reviewer must declare an explicit tools block");
  /* The reviewer must never write/edit/bash: it judges the artifact and emits a verdict.
     A writable reviewer could "fix" what it is judging, destroying the independence that
     makes its verdict trustworthy.
   */
  assert.notEqual(tools.write, true, "qa-reviewer must not have write");
  assert.notEqual(tools.edit, true, "qa-reviewer must not have edit");
  assert.notEqual(tools.bash, true, "qa-reviewer must not have bash");
  /* independence must be runtime-enforced, not prompt etiquette — deny every MCP toolset. */
  for (const server of MCP_ALLOWLIST) assertMcpServerDenied("qa-reviewer", tools, server);
});

test("the run-Q&A assistant is tool-less: no fs/shell tools and NO MCP at all", () => {
  const { agents } = loadAgentConfig();
  const assistant = agents["qa-assistant"];
  assert.ok(assistant, "expected a qa-assistant agent");
  const tools = agentTools(assistant);
  /* Meaningfulness guard: an absent `tools` block would make the checks below vacuous. */
  assert.ok(Object.keys(tools).length > 0, "qa-assistant must declare an explicit tools block");
  /* The TUI chat assistant answers from provided run context only — it must not touch
     the filesystem, shell, or the watched repo in any way.
   */
  for (const cap of ["write", "edit", "bash", "read"]) {
    assert.notEqual(tools[cap], true, `qa-assistant must not have ${cap}`);
  }
  /* The assistant holds NO MCP. Its own prompt (agents/agent/qa-assistant.md:
     "You have no tools — do not read files, run commands, or call any MCP") and the orchestrator's
     chat context builder (src/server/chat.ts buildRunChatContext: "You have NO tools") both declare
     it tool-less; the run outcomes / learning rules / curriculum it answers about are injected
     deterministically as TEXT by chat.ts, and an MCP grant would contradict the
     prompt contract and widen the surface for no functional reason.
   */
  for (const server of MCP_ALLOWLIST) assertMcpServerDenied("qa-assistant", tools, server);
});

test("the reflector is tool-less: no fs/shell tools and NO MCP at all (a pure failure->rule transform)", () => {
  const { agents } = loadAgentConfig();
  const reflector = agents["qa-reflector"];
  assert.ok(reflector, "expected a qa-reflector agent");
  const tools = agentTools(reflector);
  assert.ok(Object.keys(tools).length > 0, "qa-reflector must declare an explicit tools block");
  for (const cap of ["write", "edit", "bash", "read"]) {
    assert.notEqual(tools[cap], true, `qa-reflector must not have ${cap}`);
  }
  /* The reflector holds NO MCP at all. Reflection is a
     pure transform of the provided failure context into a rule; any recall/memory access would make
     it non-deterministic and let it touch state beyond the prompt.
   */
  for (const server of MCP_ALLOWLIST) assertMcpServerDenied("qa-reflector", tools, server);
});

test("read-only roles in the capability policy map to non-writable OpenCode agents (no drift)", () => {
  /* Ties the provider-agnostic policy (capabilitiesForRole) to its OpenCode enforcement
     (opencode.json tools{}). Without this they could silently diverge: a role declared read-only in
     the policy could still map to a write-capable agent, re-opening exactly the gap this work closed.
     The mutating caps (write/edit/bash) are the security-relevant ones for a read-only judge/reflector.
   */
  const { agents } = loadAgentConfig();
  let checkedReadOnly = 0;
  for (const [role, agentName] of Object.entries(AGENT_NAME_FOR_ROLE)) {
    if (capabilitiesForRole(role as AgentRole).canWrite) continue;
    checkedReadOnly++;
    const agent = agents[agentName];
    assert.ok(agent, `read-only role "${role}" maps to OpenCode agent "${agentName}" not declared in opencode.json`);
    const tools = agentTools(agent);
    for (const cap of ["write", "edit", "bash"]) {
      assert.notEqual(
        tools[cap],
        true,
        `SECURITY: role "${role}" is read-only in capabilitiesForRole, but its OpenCode agent "${agentName}" grants ${cap}.`,
      );
    }
  }
  /* Meaningfulness guard: the loop actually exercised the read-only roles (reviewer, chat, reflector,
     proposer).
   */
  assert.ok(checkedReadOnly >= 4, `expected >=4 read-only roles checked against opencode.json, got ${checkedReadOnly}`);
});

test("every role maps to an agent that opencode.json declares", () => {
  const { agents } = loadAgentConfig();
  for (const [role, agentName] of Object.entries(AGENT_NAME_FOR_ROLE)) {
    assert.ok(agents[agentName], `role "${role}" maps to agent "${agentName}", which opencode.json does not declare`);
  }
});

test("qa-proposer keeps serena but denies playwright", () => {
  /* The proposer is read-only (no write/edit/bash) but IS designed to hold serena per the design
     intent; only playwright (browser driving) is out of scope for it, since it navigates no live app.
   */
  const { agents } = loadAgentConfig();
  const proposer = agents["qa-proposer"];
  assert.ok(proposer, "expected a qa-proposer agent");

  const proposerTools = agentTools(proposer);
  assertMcpServerAllowed("qa-proposer", proposerTools, "serena");
  assertMcpServerDenied("qa-proposer", proposerTools, "playwright");
});

test("qa-generator keeps serena+playwright as the test author", () => {
  const { agents } = loadAgentConfig();
  const generator = agents["qa-generator"];
  assert.ok(generator, "expected a qa-generator agent");
  const tools = agentTools(generator);
  assert.equal(tools.write, true, "qa-generator must have write");
  assert.equal(tools.edit, true, "qa-generator must have edit");
  for (const server of MCP_ALLOWLIST) assertMcpServerAllowed("qa-generator", tools, server);
});

/* The generator has no shell at all. A command allow-list is not an execution boundary: even the suite listing
   (`npx playwright test --list`) loads the Playwright config and every spec module, which the generator itself
   writes, and `npx` resolves whatever a planted `node_modules/.bin` offers. The orchestrator's Validate and
   Execute phases run tsc, ESLint, the listing and the suite, so the author has nothing left to run. */
test("the generator has no shell: bash is denied outright, for every target", () => {
  const { agents } = loadAgentConfig();
  const generator = agents["qa-generator"] as { permission?: Record<string, unknown> };
  assert.equal(generator.permission?.bash, "deny", "permission.bash must be a plain deny, not a pattern map");
  assert.notEqual(
    agentTools(generator).bash,
    true,
    "a tools.bash:true could be merged over the denial by a runtime; the tool stays absent from tools{}",
  );
  assert.equal(agentTools(generator).serena_execute_shell_command, false, "serena's shell would be a second route");
});

/* Rules that apply to every role (the file's top-level `permission`, merged under each agent's own). */
function globalPermission(): Record<string, unknown> {
  const permission = loadRawConfig().permission;
  assert.ok(permission && typeof permission === "object", "expected a top-level permission block");
  return permission as Record<string, unknown>;
}

test("every role answers doom_loop and external_directory with a denial, since nobody answers an 'ask' in a run", () => {
  const permission = globalPermission();
  assert.equal(permission.doom_loop, "deny");
  const external = permission.external_directory as Record<string, unknown>;
  assert.equal(external["*"], "deny", "the catch-all denies a directory outside the project");
  assert.equal(Object.keys(external)[0], "*", "the catch-all comes first so that the exceptions after it are the last match");
  for (const [pattern, action] of Object.entries(external)) {
    if (pattern !== "*") assert.equal(action, "allow", `"${pattern}" is an exception to the catch-all and must allow`);
  }
});

function actionsIn(rule: unknown): unknown[] {
  return typeof rule === "string" ? [rule] : Object.values(rule as Record<string, unknown>);
}

test("no declared permission block answers 'ask' (a run has nobody to answer, so it would hang)", () => {
  const { agents } = loadAgentConfig();
  const blocks: Array<[string, Record<string, unknown>]> = [["the top level", globalPermission()]];
  for (const [name, agent] of Object.entries(agents)) {
    const permission = (agent as { permission?: Record<string, unknown> }).permission;
    if (permission) blocks.push([`agent "${name}"`, permission]);
  }
  assert.ok(blocks.length >= 2, "expected the top level and at least one agent to declare a permission block");
  for (const [owner, permission] of blocks) {
    for (const [tool, rule] of Object.entries(permission)) {
      assert.ok(!actionsIn(rule).includes("ask"), `${owner} answers "ask" for ${tool}`);
    }
  }
});

interface ResolvedRule {
  permission: string;
  pattern: string;
  action: string;
}

/* An agent as `GET /agent` returns it. The recording is made on the pinned OpenCode build with the same
   `permission` blocks the real config declares (src/integrations/fixtures/README.md). */
function recordedAgents(): Array<{ name: string; native?: boolean; permission: ResolvedRule[] }> {
  return JSON.parse(readFileSync(join(process.cwd(), "src", "integrations", "fixtures", "opencode-agent-list.json"), "utf8"));
}

/* The runtime's own defaults carry 'ask' rules (doom_loop, external_directory, an env file read); the
   configuration is merged after them and the last rule that matches decides. A default 'ask' is therefore
   still in force unless a later rule of the same permission answers the same pattern, or every path (`*`),
   with something else: that later rule is the last match for whatever the 'ask' would have covered. */
function unansweredAsks(rules: ResolvedRule[]): ResolvedRule[] {
  return rules.filter(
    (rule, index) =>
      rule.action === "ask" &&
      !rules
        .slice(index + 1)
        .some((later) => later.permission === rule.permission && (later.pattern === rule.pattern || later.pattern === "*") && later.action !== "ask"),
  );
}

test("the resolved permissions of every configured role leave no 'ask' standing", () => {
  /* The `qa-` agents of the recording carry the real roles' `tools` and `permission`; the `probe-` ones exist
     for their step caps and carry neither. */
  const configured = recordedAgents().filter((agent) => agent.name.startsWith("qa-"));
  assert.ok(configured.length >= 3, "expected the recorded generator, reviewer and sidekick");
  for (const agent of configured) {
    assert.deepEqual(unansweredAsks(agent.permission), [], `the server resolves an 'ask' for "${agent.name}"`);
  }
});

/* A path pattern as OpenCode's permission matcher reads it: `*` is any run of characters (a `/` too), `?` is one. */
function patternMatches(pattern: string, path: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "s").test(path);
}

/* The rule that decides a read: the last one of the resolved list that matches (the runtime's defaults come
   first, the configuration after them). */
function readDecision(rules: ResolvedRule[], path: string): string | undefined {
  return rules.filter((rule) => rule.permission === "read" && patternMatches(rule.pattern, path)).pop()?.action;
}

/* Files that hold a credential or a login session, wherever a watched repo's working copy keeps them. */
const SECRET_PATHS = [
  "/mirrors/shop/.env",
  "/mirrors/shop/e2e/.env",
  "/mirrors/shop/service.env",
  "/mirrors/shop/e2e/.env.local",
  "/mirrors/shop/e2e/.env.production",
  "/mirrors/shop/e2e/.auth/user.json",
  "/mirrors/shop/e2e/.auth/client.p12",
  "/mirrors/shop/e2e/storageState.json",
  "/mirrors/shop/e2e/storageState.admin.json",
  "/mirrors/shop/e2e/cert.pass",
];

/* Folders and files of a watched app that merely look like auth material: its own code is what a test author reads to learn the app. The orchestrator's auth directory is not mounted into the agents container, so no rule names it. */
const APP_AUTH_SOURCES = [
  "/mirrors/shop/src/app/data/auth/auth.service.ts",
  "/mirrors/shop/src/app/data/auth/login.component.html",
  "/mirrors/shop/src/app/.auth/session.ts",
  "/mirrors/shop/e2e/flows/auth/login.spec.ts",
];

test("every role of the real configuration is in the recording, so the resolved rules below cover all of them", () => {
  const recorded = new Set(recordedAgents().map((agent) => agent.name));
  for (const name of Object.keys(loadAgentConfig().agents)) {
    assert.ok(recorded.has(name), `"${name}" is configured but absent from the recorded GET /agent body: re-record it (fixtures/README.md)`);
  }
});

test("no role can read an env file, a stored login session or the orchestrator's auth material, whatever else its tools allow", () => {
  /* The runtime's default allows every read, asks for an env file and is followed by the role's own
     `tools.read: true` (`read * allow`): a rule that only the role's `permission` block, merged last, can outweigh. */
  const configured = recordedAgents().filter((agent) => agent.name.startsWith("qa-"));
  assert.ok(configured.length >= 7, `expected every configured role in the recording, got ${configured.length}`);
  for (const agent of configured) {
    for (const path of SECRET_PATHS) {
      assert.equal(readDecision(agent.permission, path), "deny", `"${agent.name}" resolves a read of ${path} to ${readDecision(agent.permission, path)}`);
    }
  }
});

test("a role still reads an app's own auth source code: only the suite's session directory and storage-state files are closed", () => {
  const { agents } = loadAgentConfig();
  const readers = recordedAgents().filter((agent) => agent.name.startsWith("qa-") && agentTools(agents[agent.name]).read === true);
  assert.ok(readers.length >= 5, `expected the reading roles to be checked, got ${readers.length}`);
  for (const agent of readers) {
    for (const path of APP_AUTH_SOURCES) {
      assert.equal(readDecision(agent.permission, path), "allow", `"${agent.name}" resolves a read of ${path} to ${readDecision(agent.permission, path)}`);
    }
  }
});

test("a role still reads the example env file and an ordinary source file when its tools allow reading", () => {
  const generator = recordedAgents().find((agent) => agent.name === "qa-generator");
  assert.ok(generator, "expected the recorded qa-generator");
  assert.equal(readDecision(generator.permission, "/mirrors/shop/e2e/tests/login.spec.ts"), "allow");
  assert.equal(readDecision(generator.permission, "/mirrors/shop/.env.example"), "allow", "an example file carries no secret and the runtime allows it");
});

test("every role that reads declares the same read denial in its own permission block, which overrides its tools.read", () => {
  /* `tools.read: true` becomes the permission key "read" and a `permission.read` of the same agent replaces it: the
     map therefore restates the catch-all allow first, and the denials after it are the last match. A role whose
     tools turn reading off keeps the `read: deny` that tools map gives it, so a map there would re-open it. */
  const { agents } = loadAgentConfig();
  let canonical: string | undefined;
  let readers = 0;
  for (const [name, agent] of Object.entries(agents)) {
    const read = (agent as { permission?: { read?: unknown } }).permission?.read;
    if (agentTools(agent).read !== true) {
      assert.equal(read, undefined, `"${name}" cannot read, and a permission.read would replace the denial its tools give it`);
      continue;
    }
    readers += 1;
    assert.ok(read && typeof read === "object", `"${name}" reads and must declare permission.read as a pattern map`);
    const entries = Object.entries(read as Record<string, unknown>);
    assert.deepEqual(entries[0], ["*", "allow"], `"${name}": the catch-all allow comes first so that every denial after it is the last match`);
    assert.ok(entries.every(([, action]) => action === "deny" || action === "allow"), `"${name}" answers a read with neither deny nor allow`);
    const serialized = JSON.stringify(entries);
    canonical ??= serialized;
    assert.equal(serialized, canonical, `"${name}" declares a different read denial than the other roles`);
  }
  assert.ok(readers >= 5, `expected the reading roles to be checked, got ${readers}`);
});

test("the resolved generator has no allowed shell command and keeps the runtime's tool-output directory", () => {
  const generator = recordedAgents().find((agent) => agent.name === "qa-generator");
  assert.ok(generator, "expected the recorded qa-generator");
  const bash = generator.permission.filter((rule) => rule.permission === "bash");
  assert.ok(bash.length > 0, "the generator carries a bash rule");
  assert.deepEqual(
    bash.filter((rule) => rule.action !== "deny"),
    [],
    "every bash rule the server resolves for the generator denies",
  );
  const external = generator.permission.filter((rule) => rule.permission === "external_directory");
  assert.equal(external[external.length - 1]?.action, "allow", "the runtime's tool-output directory stays allowed last");
});

test("the Playwright tools that run code or push a file are denied to every role that drives the browser and writes", () => {
  const { agents } = loadAgentConfig();
  let checked = 0;
  for (const [name, agent] of Object.entries(agents)) {
    const tools = agentTools(agent);
    const writes = tools.write === true || tools.edit === true;
    const drivesBrowser = tools["playwright*"] !== false;
    if (!writes || !drivesBrowser) continue;
    checked++;
    for (const tool of ["browser_run_code_unsafe", "browser_evaluate", "browser_file_upload", "browser_drop"]) {
      assert.equal(tools[`playwright_${tool}`], false, `SECURITY: ${name} must deny "playwright_${tool}"`);
      assert.equal(tools[tool], false, `SECURITY: ${name} must deny "${tool}"`);
    }
  }
  assert.ok(checked >= 2, `expected the generator and the sidekick, got ${checked} role(s)`);
});

test("every agent that holds an MCP server denies exactly the tools its exemption list names", () => {
  const { agents } = loadAgentConfig();
  let checked = 0;
  for (const [name, agent] of Object.entries(agents)) {
    const tools = agentTools(agent);
    for (const server of MCP_ALLOWLIST) {
      if (tools[`${server}*`] === false) continue;
      checked++;
      assertDeniedToolsAreTheExemptionList(name, tools, server);
    }
  }
  /* Meaningfulness guard: agents do hold servers, and the exemption lists are exercised. */
  assert.ok(checked >= 5, `expected >=5 (agent, held server) pairs checked, got ${checked}`);
  assert.ok(Object.keys(DELIBERATE_MCP_TOOL_DENIALS["qa-generator"] ?? {}).length > 0);
  assert.ok(Object.keys(DELIBERATE_MCP_TOOL_DENIALS["qa-sidekick"] ?? {}).length > 0);
});

test("the exemption list of a held server is enforced both ways", () => {
  const denied = {
    playwright_browser_run_code_unsafe: false,
    playwright_browser_evaluate: false,
    playwright_browser_file_upload: false,
    playwright_browser_drop: false,
    browser_run_code_unsafe: false,
    browser_evaluate: false,
    browser_file_upload: false,
    browser_drop: false,
  };
  const allowed = (tools: Record<string, unknown>, denials?: ToolDenials) =>
    assertMcpServerAllowed("qa-generator", tools, "playwright", denials);
  const exact = (tools: Record<string, unknown>, denials?: ToolDenials) =>
    assertDeniedToolsAreTheExemptionList("qa-generator", tools, "playwright", denials);

  allowed(denied);
  exact(denied);

  /* The denial removed while the exemption stays. */
  const withoutPrefixedDenial = { ...denied, playwright_browser_evaluate: true };
  assert.throws(() => allowed(withoutPrefixedDenial), /deliberately denies/);
  assert.throws(() => exact(withoutPrefixedDenial));

  /* The exemption removed while the denial stays. */
  assert.throws(() => allowed(denied, {}), /denies its real tool/);
  assert.throws(() => exact(denied, {}));

  /* A denial nobody listed. */
  const withStrayDenial = { ...denied, playwright_browser_navigate: false };
  assert.throws(() => allowed(withStrayDenial), /denies its prefixed tool/);
  assert.throws(() => exact(withStrayDenial));
});

test("qa-maintainer keeps serena but denies playwright (never drives a browser)", () => {
  const { agents } = loadAgentConfig();
  const maintainer = agents["qa-maintainer"];
  assert.ok(maintainer, "expected a qa-maintainer agent");
  const tools = agentTools(maintainer);
  assert.equal(tools.write, true, "qa-maintainer must have write");
  assertMcpServerAllowed("qa-maintainer", tools, "serena");
  assertMcpServerDenied("qa-maintainer", tools, "playwright");
});

test("qa-reviewer's mode matches how it is actually invoked (direct prompt, not subagent delegation)", () => {
  /* qa-engine review-port bridge) — no other opencode agent delegates to it, so the old
     "subagent" label mischaracterized the invocation path. The SDK's AgentConfig documents the
     mode union ("subagent" | "primary" | "all") without describing any semantic difference
     between "primary" and "all"; "all" was chosen as the least-restrictive option for a
     directly-prompted agent. If OpenCode ever documents a real distinction, revisit this choice —
     the load-bearing claim here is only "not subagent".
   */
  const { agents } = loadAgentConfig();
  const reviewer = agents["qa-reviewer"] as Record<string, unknown>;
  assert.ok(reviewer, "expected a qa-reviewer agent");
  assert.equal(reviewer.mode, "all", 'qa-reviewer must declare mode "all" (direct invocation, not subagent delegation)');
});

test("known built-in tool keys are recognized (sanity check for the BUILTIN_TOOL_KEYS fixture)", () => {
  /* Guards against silently drifting the fixture out of sync with reality: every built-in boolean
     actually used across the agents in opencode.json must be one we know about.
   */
  const { agents } = loadAgentConfig();
  const allMcpToolNames = new Set([
    ...Object.values(MCP_TOOL_NAMES_BY_SERVER).flat(),
    ...Object.values(DELIBERATE_MCP_TOOL_DENIALS).flatMap((denials) => Object.keys(denials)),
  ]);
  for (const [name, agent] of Object.entries(agents)) {
    const tools = agentTools(agent);
    for (const key of Object.keys(tools)) {
      const isWildcard = key.endsWith("*");
      const isKnownMcpTool = allMcpToolNames.has(key);
      const isBuiltin = BUILTIN_TOOL_KEYS.has(key) || CUSTOM_TOOL_KEYS.has(key);
      assert.ok(
        isWildcard || isKnownMcpTool || isBuiltin,
        `agent "${name}" declares tools key "${key}" that is neither a known built-in, a known MCP ` +
          `tool name, nor a wildcard — likely a typo or an undocumented capability.`,
      );
    }
  }
});

test("run_spec is off for every agent by the global tools map and on for the two authoring roles alone", () => {
  const raw = loadRawConfig();
  assert.deepEqual((raw.tools as Record<string, unknown> | undefined)?.run_spec, false, "the global default switches the tool off");
  const { agents } = loadAgentConfig();
  const on = Object.entries(agents).filter(([, agent]) => agentTools(agent).run_spec === true).map(([name]) => name);
  assert.deepEqual(on.sort(), ["qa-generator", "qa-sidekick"]);
  for (const [name, agent] of Object.entries(agents)) {
    if (name !== "qa-generator" && name !== "qa-sidekick") assert.notEqual(agentTools(agent).run_spec, true, `${name} must not call run_spec`);
  }
});

test("the run_spec tool file exists and its package is installed in the agents image", () => {
  assert.ok(existsSync(join(process.cwd(), "agents", "tool", "run_spec.ts")), "the tool file the config enables exists");
  const dockerfile = readFileSync(join(process.cwd(), "agents", "Dockerfile"), "utf8");
  assert.match(dockerfile, /npm ci/, "the tool's package is installed in the image, not taken from a host folder");
});

/* Whether a tools-map key switches the named tool: the exact name, or a wildcard whose prefix the name starts with. */
function keyCovers(key: string, name: string): boolean {
  return key === name || (key.endsWith("*") && name.startsWith(key.slice(0, -1)));
}

test("the authenticated browser tools are off for every agent by the global tools map and on for the authoring roles alone", () => {
  const raw = loadRawConfig();
  const globalTools = (raw.tools ?? {}) as Record<string, unknown>;
  for (const tool of AGENT_BROWSER_TOOLS) assert.equal(globalTools[tool], false, `the global default switches ${tool} off`);

  const { agents } = loadAgentConfig();
  const authoring = [...AGENT_BROWSER_AGENTS].sort();
  const on = Object.entries(agents)
    .filter(([, agent]) => AGENT_BROWSER_TOOLS.every((tool) => agentTools(agent)[tool] === true))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(on, authoring, "all four tools are on for the authoring roles and for no other agent");
  for (const [name, agent] of Object.entries(agents)) {
    if (AGENT_BROWSER_AGENTS.has(name)) continue;
    for (const [key, value] of Object.entries(agentTools(agent))) {
      for (const tool of AGENT_BROWSER_TOOLS) assert.ok(!(value === true && keyCovers(key, tool)), `${name} must not enable ${tool} (via "${key}")`);
    }
  }
});

test("every role granted the authenticated browser tools denies webfetch, declared and as the server resolves it", () => {
  const { agents } = loadAgentConfig();
  const granted = Object.entries(agents)
    .filter(([, agent]) => AGENT_BROWSER_TOOLS.some((tool) => agentTools(agent)[tool] === true))
    .map(([name]) => name);
  assert.ok(granted.length > 0, "expected at least one role holding the browser tools");
  const recorded = recordedAgents();
  for (const name of granted) {
    assert.equal(agentTools(agents[name]).webfetch, false, `${name} must switch webfetch off in its tools map`);
    const rules = recorded.find((agent) => agent.name === name)?.permission ?? [];
    assert.equal(rules.filter((rule) => rule.permission === "webfetch").pop()?.action, "deny", `${name} resolves webfetch to a denial`);
  }
});

test("a prompt that asks for no tool at all denies the browser tools too", () => {
  for (const tool of AGENT_BROWSER_TOOLS) assert.equal(NO_TOOLS[tool] === false || NO_TOOLS["authbrowser*"] === false, true, tool);
});

test("the browser tool file exists, where the tools directory of the config puts it", () => {
  assert.ok(existsSync(join(process.cwd(), "agents", "tool", "authbrowser.ts")), "the file whose exports are the four tools exists");
  assert.ok(existsSync(join(process.cwd(), "agents", "lib", "authbrowser-client.mjs")), "and so does the client it calls through");
});

test("the code-graph tools are off for every agent by the global tools map and on for the lead alone", () => {
  const raw = loadRawConfig();
  const globalTools = (raw.tools ?? {}) as Record<string, unknown>;
  for (const tool of CODE_GRAPH_TOOLS) assert.equal(globalTools[tool], false, `the global default switches ${tool} off`);
  const { agents } = loadAgentConfig();
  const on = Object.entries(agents)
    .filter(([, agent]) => CODE_GRAPH_TOOLS.every((tool) => agentTools(agent)[tool] === true))
    .map(([name]) => name);
  assert.deepEqual(on, [CODE_GRAPH_AGENT]);
  for (const [name, agent] of Object.entries(agents)) {
    if (name === CODE_GRAPH_AGENT) continue;
    for (const [key, value] of Object.entries(agentTools(agent))) {
      for (const tool of CODE_GRAPH_TOOLS) assert.ok(!(value === true && keyCovers(key, tool)), `${name} must not enable ${tool} (via "${key}")`);
    }
  }
});

test("a prompt that asks for no tool at all denies the code-graph tools, and their tool file and client exist", () => {
  for (const tool of CODE_GRAPH_TOOLS) assert.equal(NO_TOOLS[tool] === false || NO_TOOLS["codegraph*"] === false, true, tool);
  assert.ok(existsSync(join(process.cwd(), "agents", "tool", "codegraph.ts")));
  assert.ok(existsSync(join(process.cwd(), "agents", "lib", "codegraph-client.mjs")));
});

test("the location tool is off for every agent by the global tools map and on for the two authoring roles alone", () => {
  const raw = loadRawConfig();
  assert.deepEqual((raw.tools as Record<string, unknown> | undefined)?.set_geolocation, false, "the global default switches the tool off");
  const { agents } = loadAgentConfig();
  const on = Object.entries(agents).filter(([, agent]) => agentTools(agent).set_geolocation === true).map(([name]) => name);
  assert.deepEqual(on.sort(), ["qa-generator", "qa-sidekick"]);
  for (const [name, agent] of Object.entries(agents)) {
    if (name !== "qa-generator" && name !== "qa-sidekick") assert.notEqual(agentTools(agent).set_geolocation, true, `${name} must not move the authoring location`);
  }
  assert.ok(existsSync(join(process.cwd(), "agents", "tool", "set_geolocation.ts")), "the tool file the config enables exists");
});
