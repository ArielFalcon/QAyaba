/* P0-2: when qa.valueOracle resolves to "off", the composition root must wire a no-op oracle
   that never re-runs the suite (no fault-injection, no Stryker). Signal-only contract: a null
   valueScore never gates publish.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NullValueOracleAdapter } from "@contexts/objective-signal/infrastructure/null-value-oracle.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

const br = BlastRadius.of(Sha.of("abcdef1"), ["src/svc.ts"]);

test("NullValueOracleAdapter.measure returns a null score without a DEV re-run", async () => {
  const adapter = new NullValueOracleAdapter();
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", ["a.spec.ts"]);
  assert.equal(r.valueScore, null);
  assert.equal(r.mutantCount, null, "not measured must be null, never a fabricated zero mutant count");
  assert.equal(r.killedCount, null, "not measured must be null, never a fabricated zero killed count");
  assert.match(r.details, /valueOracle.*off/i);
});
