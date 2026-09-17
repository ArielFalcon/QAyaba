/* Canonical per-test manifest-entry shape (e2e/.qa/manifest.json). One zod schema for both the static-gate read path and the generation write path — never a third shape. `file` is optional so hand-edited entries lacking it are not rejected; `targets`/`changeRef` are required at type and runtime. Lives in the kernel so qa-engine stays src/-free; the shell re-exports this schema. */

import { z } from "zod";

export const ManifestEntrySchema = z.object({
  id: z.string().min(1, { error: "manifest entry missing 'id'" }),
  objective: z.string().min(1, { error: "manifest entry missing 'objective'" }),
  flow: z.string().min(1, { error: "manifest entry missing 'flow'" }),
  useCase: z.string().optional(),
  /* Optional: generation writes SpecMeta.file for the on-disk phantom check; hand-edited entries without it are not rejected here. */
  file: z.string().min(1).optional(),
  targets: z.array(z.string()).min(1, { error: "manifest entry has empty 'targets'" }),
  changeRef: z.object({
    sha: z.string().min(1),
    type: z.string().min(1),
    pr: z.number().optional(),
    ticket: z.string().optional(),
  }),
  /* Content checksum of the spec file. Optional so the read path preserves it instead of silently stripping it. */
  sha256: z.string().optional(),
  criticality: z.enum(["critical", "normal"]).optional(),
  owner: z.string().optional(),
  createdAt: z.string().optional(),
  coverage: z
    .object({
      files: z.array(z.string()).optional(),
      functions: z.array(z.string()).optional(),
    })
    .optional(),
  sensitivity: z
    .object({
      status: z.enum(["pass", "fail", "unknown"]),
      method: z.string().optional(),
      at: z.string().optional(),
    })
    .optional(),
  stability: z
    .object({
      runs: z.number(),
      flakyRuns: z.number(),
    })
    .optional(),
  ledger: z
    .object({
      caughtRegressions: z.number(),
      falsePositives: z.number(),
    })
    .optional(),
  merit: z.number().optional(),
});

export const ManifestSchema = z.array(ManifestEntrySchema);

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

function formatZodIssue(issue: { path: PropertyKey[]; message: string }): string {
  const tag = issue.path.length > 0 ? `entry ${issue.path.join(".")}` : "manifest";
  return `${tag}: ${issue.message}`;
}

/** Structural/field validation only. Duplicate-id detection is a read-gate concern — the write path's upsert-by-id merge cannot produce duplicates. */
export function validateManifest(raw: unknown): ManifestValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["the manifest (e2e/.qa/manifest.json) must be an array"] };
  }
  const result = ManifestSchema.safeParse(raw);
  if (result.success) return { ok: true, errors: [] };
  return { ok: false, errors: result.error.issues.map(formatZodIssue) };
}

/** Write-time single-entry check. Returns the first violation message, or undefined when well-formed. */
export function manifestEntryViolation(e: unknown): string | undefined {
  const result = ManifestEntrySchema.safeParse(e);
  if (result.success) return undefined;
  return result.error.issues[0]?.message ?? "invalid manifest entry";
}
