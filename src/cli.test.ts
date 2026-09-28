import { describe, it } from "node:test";
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

  /*
   * --allow-concurrent used to bypass the local-service refusal check in main() via an
   * allowConcurrent field threaded through parseArgs. That escape hatch is removed: the flag is
   * no longer special-cased, and the parsed result must carry no field that could gate — or
   * bypass — the health-probe refusal. Pinning the exact key set (rather than just checking
   * `allowConcurrent` is absent) guards against the bypass reappearing under a different name.
   */
  it("parseArgs no longer recognizes --allow-concurrent (no bypass field survives parsing)", () => {
    const a = parseArgs(["--app", "x", "--sha", "bbbb222", "--allow-concurrent"]);
    assert.deepEqual(
      Object.keys(a).sort(),
      ["app", "baseSha", "guidance", "learning", "mode", "sha", "target"].sort(),
    );
  });
});
