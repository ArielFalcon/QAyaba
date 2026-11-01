/*
 * Writes agents/lib/submit-contracts.json: the JSON Schema of each submit tool's arguments, rendered from the wire schema the owning
 * context declares for the contract the tool delivers. The agents service builds the tools' typed arguments from this file, so the
 * contract each context checks and the schema the model is shown are one definition.
 *
 *   npm run submit-contracts:gen
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DELEGATION_RESULT_WIRE, LEAD_CORRECTION_WIRE, LEAD_PLAN_WIRE, LEAD_REVIEW_WIRE } from "../engine/src/contexts/coordination/application/index";
import { GENERATOR_VERDICT_WIRE, REVIEWER_VERDICT_WIRE } from "../engine/src/contexts/generation/application/index";
import { PROPOSER_PROFILES_WIRE } from "../engine/src/contexts/service-topology/application/index";
import { SUBMIT_TOOL, SUBMIT_TOOLS, type SubmitTool } from "../engine/src/shared-kernel/submission";
import { installRedactingProcessLogger } from "../platform/telemetry/redacting-logger";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SUBMIT_CONTRACTS_PATH = join(ROOT, "agents", "lib", "submit-contracts.json");

/** A tool added to the kernel without a wire here is a compile error. */
export const SUBMIT_WIRES: Record<SubmitTool, z.ZodType> = {
  [SUBMIT_TOOL.PLAN]: LEAD_PLAN_WIRE,
  [SUBMIT_TOOL.FLOW_REVIEW]: LEAD_REVIEW_WIRE,
  [SUBMIT_TOOL.CORRECTIONS]: LEAD_CORRECTION_WIRE,
  [SUBMIT_TOOL.RESULT]: DELEGATION_RESULT_WIRE,
  [SUBMIT_TOOL.SPECS]: GENERATOR_VERDICT_WIRE,
  [SUBMIT_TOOL.REVIEW]: REVIEWER_VERDICT_WIRE,
  [SUBMIT_TOOL.PROFILES]: PROPOSER_PROFILES_WIRE,
};

export function renderSubmitContracts(wires: Record<SubmitTool, z.ZodType> = SUBMIT_WIRES): string {
  const schemas = SUBMIT_TOOLS.map((tool) => {
    const { $schema: _draft, ...schema } = z.toJSONSchema(wires[tool], { target: "draft-7", io: "input" });
    return [tool, schema] as const;
  });
  return `${JSON.stringify(Object.fromEntries(schemas), null, 2)}\n`;
}

function main(): void {
  installRedactingProcessLogger();
  writeFileSync(SUBMIT_CONTRACTS_PATH, renderSubmitContracts(), "utf8");
  console.log(`submit-contracts:gen — wrote ${SUBMIT_CONTRACTS_PATH}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
