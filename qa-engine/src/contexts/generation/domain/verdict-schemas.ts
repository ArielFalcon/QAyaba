import { z } from "zod";

/* Per-spec metadata in the generator's closing JSON (and, post-reconciliation, the manifest). */
export const SpecMetaSchema = z.object({
  file: z.string().trim().min(1),
  flow: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  /*
   * targets may be empty: a spec need not name specific code symbols. Defaulting keeps the
   * contract as lenient here as parseSpecMetas is on extraction.
   */
  targets: z.array(z.string()).default([]),
});

/* A generator's decision to write nothing, with the reason it gives. */
const NoopDecisionSchema = z.object({ reason: z.string().trim().min(1) });

/* The generator's typed claim that its test is correct: a cause and a reason. A claim, never evidence — the orchestrator verifies it against the run's artifacts. */
const TestCorrectSchema = z.object({ cause: z.enum(["env", "app"]), reason: z.string().trim().min(1) });

/*
 * The generator's typed refusal to apply one reviewer finding. `basis` names what the orchestrator may
 * check — an execution of this run, or a contract clause — so a rebuttal with nothing checkable is not a
 * decision at all. `reason` is prose the run records but never weighs.
 */
const RebuttalSchema = z.object({
  finding: z.string().trim().min(1),
  basis: z.enum(["execution", "contract"]),
  ref: z.string().trim().min(1),
  reason: z.string().trim().min(1),
});

/* What a turn may answer instead of specs, or beside them: at least one rebuttal. */
const RebuttalsSchema = z.array(RebuttalSchema).min(1);

/*
 * The GENERATOR's deliverable. It does not self-report `approved` — the independent
 * reviewer is the authoritative gate — so its closing JSON is the specs it wrote plus
 * optional per-spec metadata. An EMPTY specs array is a decision only when it carries a
 * reasoned `noop` ({"specs":[],"noop":{"reason":"…"}}): silence is not a decision, and neither is
 * `approved`, which is ignored (stripped). A missing `specs` is an empty list, so a reasoned `noop`
 * alone is a decision, exactly as `parseVerdict` reads it. A `noop` beside real specs is not read at all.
 */
export const GeneratorVerdictSchema = z
  .object({
    specs: z.array(z.string()).default([]),
    specMetas: z.array(SpecMetaSchema).optional(),
    note: z.string().optional(),
    noop: z.unknown().optional(),
    /* The generator's typed test-correct claim; a claim, never evidence. */
    testCorrect: z.unknown().optional(),
    /* The findings the generator disputes instead of correcting; the orchestrator checks each basis. */
    rebuttals: z.unknown().optional(),
    /* The plan a lead gives when its turn asks for one; the orchestrator's admission reads it, so only its being an object is checked here. */
    plan: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((verdict, ctx) => {
    if (verdict.specs.length > 0 || verdict.plan !== undefined || NoopDecisionSchema.safeParse(verdict.noop).success || TestCorrectSchema.safeParse(verdict.testCorrect).success || RebuttalsSchema.safeParse(verdict.rebuttals).success) return;
    ctx.addIssue({
      code: "custom",
      path: ["noop"],
      message:
        verdict.noop === undefined
          ? 'an empty "specs" list is only a decision with a "noop" object, a valid "testCorrect" claim or valid "rebuttals": {"noop":{"kind":"not-worth","reason":"why nothing was written"}}'          : 'a "noop" needs a non-empty text "reason"',
    });
  });


/** One reviewer finding as the agent wrote it; a `null` citation is the agent saying it cited nothing. An entry the schema cannot read makes a rejection unreadable; beside an approval it is set aside and recorded. Nothing here stands in for a field the agent did not send. */
export const CorrectionEntrySchema = z.object({
  text: z.string(),
  severity: z.enum(["blocking", "advisory"]),
  citation: z
    .object({ kind: z.enum(["contract", "execution", "dom", "arm", "availability", "contradiction"]), ref: z.string() })
    .nullish(),
});

export type CorrectionEntry = z.infer<typeof CorrectionEntrySchema>;

export const ReviewerVerdictSchema = z.object({
  approved: z.boolean(),
  rationale: z.string().optional().catch(undefined),
  corrections: z.array(CorrectionEntrySchema),
});
