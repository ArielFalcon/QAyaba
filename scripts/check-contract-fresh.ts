/*
 * Contract freshness gate (npm run contract:check): regenerates contract/openapi.json and the
 * SDK's generated types into a temp directory and diffs them against the committed files —
 * catches a src/contract/*.ts (zod) edit that shipped without rerunning
 * `npm run contract:gen && npm run sdk:gen`. This is a step of its own in
 * .github/workflows/ci.yml rather than folded into `npm test`: openapi.test.ts's "committed and
 * up to date" assertion already covers contract/openapi.json as part of the suite, but nothing
 * previously checked packages/sdk/src/types.gen.ts, so a stale SDK type had no CI signal at all.
 *
 *   npm run contract:check
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/contract/openapi.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OPENAPI_JSON_PATH = join(ROOT, "contract", "openapi.json");
const SDK_TYPES_PATH = join(ROOT, "packages", "sdk", "src", "types.gen.ts");
const OPENAPI_TYPESCRIPT_BIN = join(ROOT, "node_modules", ".bin", "openapi-typescript");

export interface FreshnessCheck {
  label: string;
  committedPath: string;
  freshContent: string;
}

/** Pure comparison — no filesystem access of its own, so it is unit-testable with fakes. Reports
 *  a missing committed file distinctly from drift (both are "stale", but a developer investigating
 *  CI wants to know which). */
export function findStale(checks: FreshnessCheck[], readCommitted: (path: string) => string): string[] {
  const stale: string[] = [];
  for (const check of checks) {
    let committed: string;
    try {
      committed = readCommitted(check.committedPath);
    } catch {
      stale.push(`${check.label}: ${check.committedPath} does not exist — run \`npm run contract:gen && npm run sdk:gen\` and commit the result`);
      continue;
    }
    if (committed !== check.freshContent) {
      stale.push(`${check.label}: ${check.committedPath} is stale — run \`npm run contract:gen && npm run sdk:gen\` and commit the result`);
    }
  }
  return stale;
}

/** Regenerates the SDK types from the given openapi.json content by shelling out to the exact
 *  same openapi-typescript CLI `npm run sdk:gen` uses, so this never drifts from what that command
 *  actually produces. Runs entirely in a scratch temp dir — never touches the real output path. */
export function regenerateSdkTypes(openApiJsonContent: string): string {
  const dir = mkdtempSync(join(tmpdir(), "contract-check-"));
  try {
    const inputPath = join(dir, "openapi.json");
    const outputPath = join(dir, "types.gen.ts");
    writeFileSync(inputPath, openApiJsonContent, "utf8");
    execFileSync(OPENAPI_TYPESCRIPT_BIN, [inputPath, "-o", outputPath], { stdio: "pipe" });
    return readFileSync(outputPath, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  const freshOpenApiJson = JSON.stringify(buildOpenApiDocument(), null, 2) + "\n";
  const freshSdkTypes = regenerateSdkTypes(freshOpenApiJson);

  const stale = findStale(
    [
      { label: "contract/openapi.json", committedPath: OPENAPI_JSON_PATH, freshContent: freshOpenApiJson },
      { label: "packages/sdk/src/types.gen.ts", committedPath: SDK_TYPES_PATH, freshContent: freshSdkTypes },
    ],
    (path) => readFileSync(path, "utf8"),
  );

  if (stale.length > 0) {
    console.error("contract:check — stale generated artifact(s):");
    for (const s of stale) console.error(`  - ${s}`);
    process.exitCode = 1;
    return;
  }
  console.log("contract:check — contract/openapi.json and packages/sdk/src/types.gen.ts are up to date.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
