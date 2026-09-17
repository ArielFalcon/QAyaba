import { z } from "zod";
import type { BoundaryProfile } from "@contexts/service-topology/domain/index.ts";

/*
 * LLM-text Zod parser for the proposer flow. Lives in the control plane (src/server/onboarding/).
 * Field names match qa-engine's BoundaryProfile union; every string uses `.min(1)` — empty globs
 * and paths are never usable candidates, so reject them at this untrusted parse boundary.
 */
const HttpProfileSchema = z.object({
  transport: z.literal("http"),
  frontFiles: z.string().min(1),
  frontCallSite: z.object({ kind: z.string().min(1), receiver: z.string().optional() }),
  servicePrefixTemplate: z.string().min(1),
  serviceRepoTemplate: z.string().min(1),
  openApiPath: z.string().min(1),
});

const EventProfileSchema = z.object({
  transport: z.literal("event"),
  files: z.string().min(1),
  eventPattern: z.object({
    kind: z.string().min(1),
    listenerBaseType: z.string().min(1),
    listenerEventCall: z.string().min(1),
    subscriberBaseType: z.string().min(1),
    publishCall: z.string().min(1),
  }),
});

const HttpBackendProfileSchema = z.object({
  transport: z.literal("http-backend"),
  sourceFiles: z.string().min(1),
  callPattern: z.object({ kind: z.string().min(1), receiver: z.string().optional() }),
  servicePrefixTemplate: z.string().min(1),
  serviceRepoTemplate: z.string().min(1),
  openApiPath: z.string().min(1),
});

const CandidateSchema = z.discriminatedUnion("transport", [
  HttpProfileSchema,
  EventProfileSchema,
  HttpBackendProfileSchema,
]);

/*
 * Recognizable sentinel a malformed candidate degrades to (per-entry .catch), so the adapter can
 * filter it out while preserving valid siblings — the INVERSE intent of ReviewerVerdictSchema's
 * fail-closed placeholder (src/orchestrator/schemas.ts): the proposer must fail OPEN, a bad
 * candidate must never poison the round nor collapse the whole array.
 */
export const UNPARSEABLE_SENTINEL = {
  transport: "http",
  frontFiles: "__UNPARSEABLE__",
  frontCallSite: { kind: "__UNPARSEABLE__" },
  servicePrefixTemplate: "__UNPARSEABLE__",
  serviceRepoTemplate: "__UNPARSEABLE__",
  openApiPath: "__UNPARSEABLE__",
} as const satisfies z.infer<typeof HttpProfileSchema>;

/*
 * The inner `.catch([])` guards the `candidates` FIELD (present but non-array/missing). The outer
 * `.catch({candidates: []})` guards the case where the top-level input isn't even an object (e.g.
 * a bare string, null, or garbage JSON) — `.parse()` must never throw for any input shape; every
 * failure mode degrades to a well-formed empty verdict, per the adapter's fail-open contract.
 */
export const ProposerVerdictSchema = z
  .object({
    candidates: z.array(CandidateSchema.catch(UNPARSEABLE_SENTINEL)).catch([]),
  })
  .catch({ candidates: [] });

export type ProposerVerdict = z.infer<typeof ProposerVerdictSchema>;
export type SchemaCandidate = z.infer<typeof CandidateSchema>;

/*
 * Type-level gates so the schema cannot silently drift from the domain BoundaryProfile union:
 * per-variant key diffs, plus a whole-union transport-literal coverage gate for new variants.
 */
type KeyDiff<A, B> = Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>;
type AssertNever<T extends never> = T;

type _HttpParity = AssertNever<
  KeyDiff<Extract<SchemaCandidate, { transport: "http" }>, Extract<BoundaryProfile, { transport: "http" }>>
>;
type _EventParity = AssertNever<
  KeyDiff<Extract<SchemaCandidate, { transport: "event" }>, Extract<BoundaryProfile, { transport: "event" }>>
>;
type _HttpBackendParity = AssertNever<
  KeyDiff<
    Extract<SchemaCandidate, { transport: "http-backend" }>,
    Extract<BoundaryProfile, { transport: "http-backend" }>
  >
>;
type _AllTransportsCovered = AssertNever<Exclude<BoundaryProfile["transport"], SchemaCandidate["transport"]>>;
