import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeRuntimeStrategy } from "./opencode-strategy";
import { AGENT_NAME_FOR_ROLE, AGENT_ROLES } from "./types";

describe("OpenCodeRuntimeStrategy.listModels", () => {
  it("parsing logic: distinct agent models in a config are surfaced exactly (temp-config shape test)", async () => {
    /* Build a tiny temp config mirroring the SHAPE this parser reads (agent -> model) and confirm
       the parse path surfaces exactly the distinct assigned ids.
     */
    const dir = mkdtempSync(join(tmpdir(), "opencode-config-test-"));
    const configPath = join(dir, "opencode.json");
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          agent: {
            "qa-author": { model: "opencode-go/deepseek-v4-pro" },
            "qa-reviewer": { model: "opencode-go/minimax-m3" },
            "qa-maintainer": { model: "opencode-go/kimi-k2.7-code" },
            "qa-assistant": { model: "opencode-go/deepseek-v4-flash" },
          },
        }),
      );
      const strategy = new OpenCodeRuntimeStrategy({
        env: { OPENCODE_API_KEY: "test-key" },
        configPath,
      });
      const liveIds = (await strategy.listModels()).map((m) => m.id).sort();
      assert.deepEqual(
        liveIds,
        [
          "opencode-go/deepseek-v4-flash",
          "opencode-go/deepseek-v4-pro",
          "opencode-go/kimi-k2.7-code",
          "opencode-go/minimax-m3",
        ],
        "the live-config parse path must surface exactly the distinct models assigned",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [name, content] of [
    ["is missing", undefined],
    ["cannot be parsed", "{ not valid json"],
    ["assigns no model", JSON.stringify({ agent: { "qa-author": {} } })],
  ] as const) {
    it(`lists no model when the roster ${name}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "opencode-config-test-"));
      try {
        const configPath = join(dir, "opencode.json");
        if (content !== undefined) writeFileSync(configPath, content);
        const strategy = new OpenCodeRuntimeStrategy({ env: { OPENCODE_API_KEY: "test-key" }, configPath });
        assert.deepEqual(await strategy.listModels(), []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("OpenCodeRuntimeStrategy.stepLimits", () => {
  type Listed = Array<{ name: string; cap: unknown }>;

  /* A strategy whose server lists `listed`, recording the directory of every read it makes. */
  function strategyListing(listed: Listed, reads: string[] = [], configPath?: string): OpenCodeRuntimeStrategy {
    return new OpenCodeRuntimeStrategy({
      env: {},
      ...(configPath === undefined ? {} : { configPath }),
      listAgentCaps: async (directory) => {
        reads.push(directory);
        return listed;
      },
    });
  }

  /* Every role's agent, each with a cap of its own that follows from the role's place in the table. */
  const capOfRole = (index: number): number => 10 + index;
  const everyRoleCapped = (): Listed => AGENT_ROLES.map((role, index) => ({ name: AGENT_NAME_FOR_ROLE[role], cap: capOfRole(index) }));

  it("maps the caps the server lists through the role-to-agent table, from one read of the directory it is given", async () => {
    const reads: string[] = [];
    const limits = await strategyListing(everyRoleCapped(), reads).stepLimits("/m/app");
    AGENT_ROLES.forEach((role, index) => {
      assert.equal(limits[role], capOfRole(index), `${role} takes the cap of ${AGENT_NAME_FOR_ROLE[role]}`);
    });
    assert.deepEqual(reads, ["/m/app"]);
  });

  it("states the live cap, not the one the baked config declares, and never the baked one for a role the server lists without a cap", async (t) => {
    t.mock.method(console, "warn", () => {});
    const dir = mkdtempSync(join(tmpdir(), "opencode-limits-test-"));
    try {
      const configPath = join(dir, "opencode.json");
      writeFileSync(configPath, JSON.stringify({ agent: { "qa-author": { maxSteps: 50 }, "qa-reviewer": { maxSteps: 25 } } }));
      const listed: Listed = [
        { name: AGENT_NAME_FOR_ROLE.author, cap: 40 },
        { name: AGENT_NAME_FOR_ROLE.reviewer, cap: undefined },
      ];
      const limits = await strategyListing(listed, [], configPath).stepLimits("/m/app");
      assert.equal(limits.author, 40, "the live cap beats the baked one");
      assert.equal(limits.reviewer, undefined, "a baked cap does not stand in for a missing live one");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes no limit from a cap that is not a safe positive integer", async (t) => {
    t.mock.method(console, "warn", () => {});
    const listed: Listed = [
      { name: AGENT_NAME_FOR_ROLE.author, cap: 0 },
      { name: AGENT_NAME_FOR_ROLE.reviewer, cap: -1 },
      { name: AGENT_NAME_FOR_ROLE.author, cap: 2.5 },
      { name: AGENT_NAME_FOR_ROLE.chat, cap: "40" },
      { name: AGENT_NAME_FOR_ROLE.reflector, cap: 5 },
    ];
    const limits = await strategyListing(listed).stepLimits("/m/app");
    assert.equal(limits.author, undefined);
    assert.equal(limits.reviewer, undefined);
    assert.equal(limits.author, undefined);
    assert.equal(limits.chat, undefined);
    assert.equal(limits.reflector, 5, "a valid cap beside the invalid ones is unaffected");
  });

  it("warns once, naming the role, for each role whose agent is listed without a cap, with an unusable cap or not listed", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const listed = everyRoleCapped()
      .filter((agent) => agent.name !== AGENT_NAME_FOR_ROLE.reflector)
      .map((agent) =>
        agent.name === AGENT_NAME_FOR_ROLE.reviewer ? { name: agent.name, cap: undefined } : agent.name === AGENT_NAME_FOR_ROLE.author ? { name: agent.name, cap: "forty" } : agent,
      );
    const limits = await strategyListing(listed).stepLimits("/m/app");
    const warnings = warn.mock.calls.map((call) => String(call.arguments[0]));
    /* A role is named as a token of its own: "reviewer" in "qa-reviewer", an agent name another warning may list, is not it. */
    const namesRole = (warning: string, role: string): boolean => new RegExp(`(?<![\\w-])${role}(?![\\w-])`).test(warning);
    for (const role of ["reviewer", "reflector", "author"] as const) {
      assert.equal(limits[role], undefined, `${role} has no limit`);
      assert.equal(warnings.filter((w) => namesRole(w, role)).length, 1, `exactly one warning names ${role}`);
    }
    assert.equal(warnings.length, 3, "no role with a usable cap is reported");
    const warningOf = (role: string): string => warnings.find((w) => namesRole(w, role))!;
    for (const role of ["reviewer", "reflector", "author"] as const) {
      assert.match(warningOf(role), new RegExp(AGENT_NAME_FOR_ROLE[role]), `the warning for ${role} names its agent`);
    }
    assert.doesNotMatch(warningOf("reviewer"), /undefined/, "a role listed without a cap is not told its cap is a value");
    const anotherAgent = AGENT_NAME_FOR_ROLE.lead;
    assert.match(warningOf("reflector"), new RegExp(anotherAgent), "a role whose agent is not listed is told what the server does list");
    assert.match(warningOf("author"), /forty/, "a warning about an unusable cap carries it");
    assert.doesNotMatch(warningOf("author"), new RegExp(anotherAgent), "only a role whose agent is not listed is told what the server lists");
    assert.doesNotMatch(warningOf("reviewer"), new RegExp(anotherAgent), "nor is a role whose agent is listed without a cap");
  });

  it("warns for every role when the server lists none of the agents", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const limits = await strategyListing([{ name: "qa-unrelated", cap: 99 }]).stepLimits("/m/app");
    assert.deepEqual(limits, {});
    assert.equal(warn.mock.callCount(), AGENT_ROLES.length, "one warning per role");
  });

  it("answers no limit for any role, and says why once, when the server cannot be read", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const strategy = new OpenCodeRuntimeStrategy({
      env: {},
      listAgentCaps: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.9:4096");
      },
    });
    assert.deepEqual(await strategy.stepLimits("/m/app"), {});
    assert.equal(warn.mock.callCount(), 1, "one warning for the failed read, none per role");
    const warning = String(warn.mock.calls[0]!.arguments[0]);
    assert.match(warning, /\/m\/app/, "it names the directory");
    assert.match(warning, /ECONNREFUSED/, "it carries what failed");
  });
});

describe("OpenCodeRuntimeStrategy.health", () => {
  it("reports a supervisor it cannot reach without quoting a secret the failure carried", async () => {
    const token = `ghp_${"a1B2c3D4".repeat(4)}abcd`;
    /* A URL with credentials makes fetch fail with a message that quotes the whole URL. */
    const strategy = new OpenCodeRuntimeStrategy({ env: { OPENCODE_API_KEY: "test-key", AGENT_SUPERVISOR_URL: `http://agent:${token}@127.0.0.1:1` } });
    const health = await strategy.health();
    assert.equal(health.status, "failed");
    assert.ok(!JSON.stringify(health).includes(token), "the health report carries no raw token");
  });
});
