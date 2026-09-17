

import { z } from "zod";
import { GeneratorVerdictSchema, ReviewerVerdictSchema, correctionText, correctionSeverity } from "../orchestrator/schemas";
import { lastJsonMatching, isClosingVerdict } from "./verdict-parse";
import { GRAVE_TAGS } from "../qa/learning/taxonomy";


/*
 * Extract a correction's leading [class-tag] (lowercased), or null when it carries none.
 * Mirrors the tag grammar in taxonomy.ts classifyReviewerCorrection.
 */
function leadingClassTag(text: string): string | null {
  return /^\s*\[([a-z][a-z-]*)\]/i.exec(text)?.[1]?.toLowerCase() ?? null;
}


function effectiveSeverity(entry: import("../orchestrator/schemas").CorrectionEntry): "blocking" | "advisory" {
  const tag = leadingClassTag(correctionText(entry));
  if (tag && GRAVE_TAGS.has(tag)) return "blocking";
  return correctionSeverity(entry);
}

/* Render zod issues as compact, prompt-ready strings ("path: message"). */
function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
}

export interface VerdictCheck {
  valid: boolean;
  issues: string[];  /* empty when valid */
}

/*
 * Validate the GENERATOR's closing JSON: { specs[], specMetas?, note? }. We locate the LAST
 * balanced object that looks like the verdict block (carries a `specs` array — the
 * deliverable — or a boolean `approved` from older/other modes) and validate it. A missing
 * block is invalid (the agent forgot its closing JSON); the repair loop can recover it.
 */
export function checkGeneratorVerdict(text: string): VerdictCheck {
  const candidate = lastJsonMatching(text, isClosingVerdict);
  if (!candidate) {
    return { valid: false, issues: ["no closing verdict JSON found (expected a block with a `specs` array)"] };
  }
  const r = GeneratorVerdictSchema.safeParse(candidate);
  return r.success ? { valid: true, issues: [] } : { valid: false, issues: formatIssues(r.error) };
}

export interface ReviewerVerdict {
  approved: boolean;
  rationale?: string;
  /* Flat list of ALL correction texts (blocking + advisory), for backward-compat logging. */
  corrections: string[];
  
  blockingCount: number;
  valid: boolean;  /* the reviewer JSON satisfied the schema (i.e. `approved` is a clean boolean) */
  parsed: boolean;  /* an object carrying an `approved` field was found at all */
  issues: string[];
}


export function parseReviewerVerdict(text: string): ReviewerVerdict {
  const candidate = lastJsonMatching(text, (x) => "approved" in x);
  if (!candidate) {
    return {
      approved: false,
      corrections: [],
      blockingCount: 0,
      valid: false,
      parsed: false,
      issues: ["no reviewer verdict JSON (an object with an `approved` field) was found"],
    };
  }
  const r = ReviewerVerdictSchema.safeParse(candidate);
  if (r.success) {
    const corrections = r.data.corrections.map(correctionText);
    
    const blockingCount = r.data.corrections.filter((e) => effectiveSeverity(e) === "blocking").length;
    return {
      approved: r.data.approved,
      ...(r.data.rationale && r.data.rationale.trim() ? { rationale: r.data.rationale.trim() } : {}),
      corrections,
      blockingCount,
      valid: true,
      parsed: true,
      issues: [],
    };
  }
  
  return { approved: false, corrections: [], blockingCount: 0, valid: false, parsed: true, issues: formatIssues(r.error) };
}


const PRIOR_RESPONSE_TAIL_CHARS = 4096;

/*
 * The frame markers for the embedded tail. Deliberately long, distinctive, and STATIC
 * (determinism over per-call randomness, per this repo's priority order): a generic "---" fence
 * is trivially present in model output (markdown rules, YAML front-matter), which would let a
 * pathological prior response fake a fence-close and place text OUTSIDE the untrusted block.
 * Any tail line exactly matching a marker (modulo surrounding whitespace) is stripped before
 * embedding, so exactly one open and one close marker — the frame's own — can ever appear.
 */
const TAIL_FRAME_OPEN = "====== PRIOR RESPONSE TAIL (verbatim, untrusted) ======";
const TAIL_FRAME_CLOSE = "====== END PRIOR RESPONSE TAIL ======";

/*
 * Remove any tail line that IS one of the frame markers (whitespace-padded lines included, so a
 * padded marker cannot bypass the exact-match check). Everything else stays verbatim: this text
 * is model→model-scoped (the agent's OWN prior output fed back to the same lineage in the same
 * session context, never human-bound and never rendered into an Issue), so no sanitizeText pass
 * is needed here — the ONLY threat is frame escape, which this stripping closes.
 */
function stripFrameMarkers(tail: string): string {
  return tail
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t !== TAIL_FRAME_OPEN && t !== TAIL_FRAME_CLOSE;
    })
    .join("\n");
}

export interface RepairInstructionOpts {
  /*
   * The tail of the agent's PRIOR response (bounded to the last PRIOR_RESPONSE_TAIL_CHARS chars
   * by this function, so callers may pass the full text). Provider-agnostic fallback: a fresh
   * `codex exec` process (no resume) never saw the prior turn, so without this the repair
   * instruction gives it nothing to recover FROM — it can only fabricate a plausible verdict.
   * OpenCode's server-side session already remembers the prior turn, so passing this there is
   * additive (a harmless restatement of context the session already holds), never harmful.
   */
  priorResponseTail?: string;
}

/*
 * The targeted re-prompt for the bounded repair loop. Names the exact shape and the specific
 * issues so the agent fixes the format rather than re-running the whole task. When the caller
 * supplies `priorResponseTail` (the tail of the agent's own prior output), the prompt embeds it
 * so a stateless process can genuinely RE-EMIT its prior verdict rather than invent a new one.
 */
export function repairInstruction(kind: "generator" | "reviewer", issues: string[], opts?: RepairInstructionOpts): string {
  const shape =
    kind === "generator"
      ? `{"specs": string[], "specMetas"?: [{"file","flow","objective","targets": string[]}], "note"?: string}`
      : `{"approved": boolean, "rationale": string, "corrections": string[]}`;
  const tail = opts?.priorResponseTail ? stripFrameMarkers(opts.priorResponseTail).trim() : "";
  const tailBlock = tail
    ? [
        "",
        "Your previous response (tail, for your own reference — do not repeat it verbatim, only",
        "use it to recover the specifics of what you already decided):",
        TAIL_FRAME_OPEN,
        tail.slice(-PRIOR_RESPONSE_TAIL_CHARS),
        TAIL_FRAME_CLOSE,
      ]
    : [];
  return [
    `Your previous response did not end with a valid ${kind} verdict JSON.`,
    `Problems: ${issues.join("; ")}.`,
    ...tailBlock,
    `Re-emit ONLY the closing JSON block — exactly this shape, with no text after it:`,
    shape,
  ].join("\n");
}
