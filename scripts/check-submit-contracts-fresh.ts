/*
 * Submit-contracts freshness gate (npm run submit-contracts:check): regenerates agents/lib/submit-contracts.json from the wire
 * schemas of the contexts and fails when the committed file differs, so a contract edit cannot ship with the old arguments still
 * shown to the model.
 *
 *   npm run submit-contracts:check
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderSubmitContracts, SUBMIT_CONTRACTS_PATH } from "./gen-submit-contracts";

/* Pure comparison, unit-testable with a fake reader. Returns the reason the file is stale, or undefined when it is fresh. */
export function submitContractsStaleness(readCommitted: (path: string) => string, fresh: string = renderSubmitContracts()): string | undefined {
  let committed: string;
  try {
    committed = readCommitted(SUBMIT_CONTRACTS_PATH);
  } catch {
    return `${SUBMIT_CONTRACTS_PATH} does not exist — run \`npm run submit-contracts:gen\` and commit the result`;
  }
  return committed === fresh ? undefined : `${SUBMIT_CONTRACTS_PATH} is stale — run \`npm run submit-contracts:gen\` and commit the result`;
}

function main(): void {
  const stale = submitContractsStaleness((path) => readFileSync(path, "utf8"));
  if (stale) {
    console.error(`submit-contracts:check — ${stale}`);
    process.exitCode = 1;
    return;
  }
  console.log("submit-contracts:check — agents/lib/submit-contracts.json is up to date.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
