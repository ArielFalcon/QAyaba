import { z } from "zod";
import type { BoundaryProfile } from "../domain/index.ts";
import type { AssertNever } from "@kernel/forwarding.ts";
import { SUBMIT_TOOL, submissionErrorsOf, type SubmissionContract } from "@kernel/submission.ts";

/*
 * The boundary profiles the proposer submits, as its submit tool carries them. Field names match the context's BoundaryProfile union;
 * every string uses `.min(1)` — empty globs and paths are never usable candidates. A profile the schema cannot read is returned to the
 * proposer inside its turn with where it went wrong; the accepted call is the round's candidates.
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

const CandidateSchema = z.discriminatedUnion("transport", [HttpProfileSchema, EventProfileSchema, HttpBackendProfileSchema]);

export type SchemaCandidate = z.infer<typeof CandidateSchema>;

export const PROPOSER_PROFILES_WIRE = z.object({
  candidates: z.array(CandidateSchema).describe("The boundary profiles you hypothesize, each discriminated by `transport`. [] when you found no boundary."),
});

export const proposerProfilesContract: SubmissionContract<readonly SchemaCandidate[]> = {
  tool: SUBMIT_TOOL.PROFILES,
  check: (answer) => {
    const read = PROPOSER_PROFILES_WIRE.safeParse(answer);
    return read.success ? { ok: true, value: read.data.candidates } : { ok: false, errors: submissionErrorsOf(read.error) };
  },
};

/*
 * Type-level gates so the schema cannot silently drift from the domain BoundaryProfile union:
 * per-variant key diffs, plus a whole-union transport-literal coverage gate for new variants.
 */
type KeyDiff<A, B> = Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>;

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
