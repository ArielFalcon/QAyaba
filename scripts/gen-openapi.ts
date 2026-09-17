/*
 * Regenerates contract/openapi.json from the zod source of truth (src/contract/openapi.ts).
 *   npm run contract:gen
 * The openapi.test.ts "up to date" check fails CI if a schema changes without rerunning this.
 */
import { writeOpenApiArtifact } from "../src/contract/openapi";

const path = writeOpenApiArtifact();
console.log(`contract: wrote ${path}`);
