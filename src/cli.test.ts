import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, delegateRunInput } from "./cli";

describe("delegateRunInput", () => {
  it("carries --base-sha into the run delegated to the service, so its diff spans the range like the standalone and webhook paths", () => {
    const args = parseArgs(["--app", "x", "--sha", "bbbb222", "--base-sha", "aaaa111", "--mode", "diff"]);
    const input = delegateRunInput(args, "e2e");
    assert.equal(input.baseSha, "aaaa111");
    assert.equal(input.sha, "bbbb222");
    assert.equal(input.target, "e2e");
  });

  it("leaves baseSha out when --base-sha is not given (a single-commit run is unchanged)", () => {
    const input = delegateRunInput(parseArgs(["--app", "x", "--sha", "bbbb222"]), "code");
    assert.equal("baseSha" in input, false);
    assert.equal(input.target, "code");
  });
});

describe("parseArgs", () => {
  it("parseArgs reads --base-sha", () => {
    const a = parseArgs(["--app", "x", "--sha", "bbbb222", "--base-sha", "aaaa111"]);
    assert.equal(a.baseSha, "aaaa111");
  });
});

describe("--closed-loop", () => {
  it("is the run's own choice about the run_spec loop and reaches the service, and is absent unless given", () => {
    assert.equal(parseArgs(["--app", "x", "--sha", "bbbb222", "--closed-loop", "on"]).closedLoop, true);
    assert.equal(parseArgs(["--app", "x", "--sha", "bbbb222", "--closed-loop", "off"]).closedLoop, false);
    const plain = parseArgs(["--app", "x", "--sha", "bbbb222"]);
    assert.equal("closedLoop" in plain, false);
    assert.equal(delegateRunInput(parseArgs(["--app", "x", "--sha", "bbbb222", "--closed-loop", "off"]), "e2e").closedLoop, false);
    assert.equal("closedLoop" in delegateRunInput(plain, "e2e"), false);
  });
});

describe("--agent-browser", () => {
  it("is the run's own choice about the authenticated agent browser and reaches the service, and is absent unless given", () => {
    assert.equal(parseArgs(["--app", "x", "--sha", "bbbb222", "--agent-browser", "on"]).agentBrowser, true);
    assert.equal(parseArgs(["--app", "x", "--sha", "bbbb222", "--agent-browser", "off"]).agentBrowser, false);
    const plain = parseArgs(["--app", "x", "--sha", "bbbb222"]);
    assert.equal("agentBrowser" in plain, false);
    assert.equal(delegateRunInput(parseArgs(["--app", "x", "--sha", "bbbb222", "--agent-browser", "off"]), "e2e").agentBrowser, false);
    assert.equal("agentBrowser" in delegateRunInput(plain, "e2e"), false);
  });
});

describe("--dom-pack", () => {
  it("is the run's own choice about the pre-generation pack's live-DOM capture and reaches the service as grounding, absent unless given", () => {
    assert.equal(parseArgs(["--app", "x", "--sha", "bbbb222", "--dom-pack", "on"]).domPack, true);
    assert.equal(parseArgs(["--app", "x", "--sha", "bbbb222", "--dom-pack", "off"]).domPack, false);
    const plain = parseArgs(["--app", "x", "--sha", "bbbb222"]);
    assert.equal("domPack" in plain, false);
    assert.deepEqual(delegateRunInput(parseArgs(["--app", "x", "--sha", "bbbb222", "--dom-pack", "off"]), "e2e").grounding, { domPack: false });
    assert.equal("grounding" in delegateRunInput(plain, "e2e"), false);
  });

  it("rejects any value other than on or off", () => {
    const exit = mock.method(process, "exit", () => { throw new Error("process.exit called"); });
    const error = mock.method(console, "error", () => {});
    try {
      assert.throws(() => parseArgs(["--app", "x", "--sha", "bbbb222", "--dom-pack", "bogus"]));
      assert.equal(exit.mock.callCount(), 1, "an invalid --dom-pack value exits");
    } finally {
      exit.mock.restore();
      error.mock.restore();
    }
  });
});

describe("flags the CLI does not know", () => {
  it("are refused with the usage and exit code 2, the removed grounding flags included", () => {
    const exit = mock.method(process, "exit", () => { throw new Error("process.exit called"); });
    const error = mock.method(console, "error", () => {});
    try {
      assert.throws(() => parseArgs(["--app", "x", "--sha", "bbbb222", "--structural-signal", "off"]));
      assert.throws(() => parseArgs(["--app", "x", "--sha", "bbbb222", "--dossier", "off"]));
      assert.throws(() => parseArgs(["--app", "x", "--sha", "bbbb222", "--allow-concurrent"]));
      assert.equal(exit.mock.callCount(), 3);
      assert.deepEqual(exit.mock.calls.map((c) => c.arguments[0]), [2, 2, 2]);
    } finally {
      exit.mock.restore();
      error.mock.restore();
    }
  });

  it("leave the grounding choices that remain (--dom-pack) reaching the service as before", () => {
    assert.deepEqual(delegateRunInput(parseArgs(["--app", "x", "--sha", "bbbb222", "--dom-pack", "off"]), "e2e").grounding, { domPack: false });
    assert.equal("grounding" in delegateRunInput(parseArgs(["--app", "x", "--sha", "bbbb222"]), "e2e"), false);
  });
});
