/* A surviving mutant of a gap is handed to the flows whose spec files ran it, and only to those whose own pages moved when some did: a flow whose pages show nothing of the mutant is not told it moved. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gapFindings } from "@contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts";
import type { SurvivedMutant } from "@contexts/objective-signal/application/index.ts";

const DARK = "GET https://api.maps.example/styles/v1/acme/dark";
const MOVED = { kind: "moved" as const, requests: { added: [DARK], removed: [] }, dom: { added: [], removed: [] }, tests: ["flows/map.spec.ts › theme"] };
const SURVIVOR: SurvivedMutant = { file: "src/map-shell.ts", line: 67, operator: "negate condition", specFiles: ["flows/list.spec.ts", "flows/map.spec.ts"], moved: MOVED };

test("a survivor whose pages moved in one of the spec files that ran it is a finding of that spec only", () => {
  const findings = gapFindings("", [], [{ ...SURVIVOR, movedBySpec: [{ spec: "flows/list.spec.ts", moved: { kind: "unmoved", tests: 1 } }, { spec: "flows/map.spec.ts", moved: MOVED }] }]);
  assert.deepEqual(findings?.map((f) => f.finding.spec), ["flows/map.spec.ts"]);
  assert.ok(findings?.[0]?.finding.text.includes(DARK));
});

test("a survivor with no account per spec file is still a finding of every spec file that ran it", () => {
  const findings = gapFindings("", [], [SURVIVOR]);
  assert.deepEqual(findings?.map((f) => f.finding.spec), ["flows/list.spec.ts", "flows/map.spec.ts"]);
});
