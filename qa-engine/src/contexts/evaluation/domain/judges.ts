/*
 * LLM-as-judge definitions, input assembly and output parsing (docs/observability-design.md section 11.3). Pure: no model, no
 * file, no clock. A judge is a model's opinion about a finished run; it is recorded as a `source=llm_judge` score and it NEVER
 * gates anything, calibrated or not (calibration only changes the `status` a consumer reads).
 *
 * Two judges exist:
 *  - `spec_relevance`: BINARY. Does a delivered spec exercise the behaviour the commit's diff changed?
 *  - `failure_root_cause`: CATEGORICAL over a pinned, closed set. One binary judge per category would multiply the model calls by
 *    eight for a question whose answer is one of eight; the closed set keeps the answer checkable (a category outside it is an
 *    unparseable answer, never a guess) and calibratable one-vs-rest (judge-calibration.ts).
 *
 * Every judge answers `{"verdict": ..., "critique": "..."}`, nothing else. A score is only ever made from an answer that parses
 * exactly; anything else produces no score and is counted by the caller.
 */

import type { Score, ScoreDataType, ScorePolarity } from "./score.ts";
import { MAX_SCORE_COMMENT_CHARS } from "./grader-catalog.ts";

export const JUDGE_NAMES = ["spec_relevance", "failure_root_cause"] as const;
export type JudgeName = (typeof JUDGE_NAMES)[number];

/* The closed set `failure_root_cause` answers from. Adding or removing a member changes the judge's meaning: bump the prompt version. */
export const ROOT_CAUSE_CATEGORIES = ["selector", "auth", "data_state", "timeout", "assertion", "infra", "egress", "app_defect"] as const;

export interface JudgeDefinition {
  name: JudgeName;
  dataType: Extract<ScoreDataType, "BOOLEAN" | "CATEGORICAL">;
  polarity: ScorePolarity;
  /* CATEGORICAL only: the closed set of verdicts. */
  categories?: readonly string[];
}

export const JUDGES: readonly JudgeDefinition[] = [
  { name: "spec_relevance", dataType: "BOOLEAN", polarity: "higher_better" },
  { name: "failure_root_cause", dataType: "CATEGORICAL", polarity: "none", categories: ROOT_CAUSE_CATEGORIES },
];

export function isJudgeName(name: string): name is JudgeName {
  return (JUDGE_NAMES as readonly string[]).includes(name);
}

export function judgeDefinition(name: JudgeName): JudgeDefinition {
  const def = JUDGES.find((j) => j.name === name);
  if (!def) throw new Error(`unknown judge ${name}`);
  return def;
}

/* Calibration status a consumer reads. `experimental` is the default of every judge; only a passing calibration on the TEST split earns `calibrated`. */
export type JudgeStatus = "experimental" | "calibrated";

/* ---- Versions ---------------------------------------------------------------------------------------------------------- */

const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
/* The first lines of agents/agent/qa-judge.md: `<!-- judge-prompt-version: 3 -->`. */
const PROMPT_VERSION_HEADER = /<!--\s*judge-prompt-version:\s*([^\s>]+)\s*-->/;

/* The version the pinned judge prompt declares, or undefined when it declares none (a judge never runs unversioned). */
export function parseJudgePromptVersion(promptText: string): string | undefined {
  const version = PROMPT_VERSION_HEADER.exec(promptText.slice(0, 2_000))?.[1];
  return version !== undefined && VERSION_PATTERN.test(version) ? version : undefined;
}

/* The grader version stored on every judge score: the judge and the prompt version that produced it. */
export function judgeGraderVersion(name: JudgeName, promptVersion: string): string {
  return `judge-${name}@${promptVersion}`;
}

export function parseJudgeGraderVersion(graderVersion: string): { name: JudgeName; promptVersion: string } | undefined {
  const match = /^judge-([a-z_]+)@(.+)$/.exec(graderVersion);
  const name = match?.[1];
  const promptVersion = match?.[2];
  if (name === undefined || promptVersion === undefined || !isJudgeName(name) || !VERSION_PATTERN.test(promptVersion)) return undefined;
  return { name, promptVersion };
}

/* ---- Input ------------------------------------------------------------------------------------------------------------- */

/* What the judges may read about a run: stored evidence only, nothing fetched from the app, the repository or DEV. */
export interface JudgeEvidence {
  runId: string;
  mode: string;
  cancelled: boolean;
  verdict: string | null;
  errorClass: string | null;
  furthestPhase: string | null;
  /* The commit diff as the generator's prompt held it (already capped and sanitized for prompts); undefined when the run held none. */
  diff: string | undefined;
  /* The redacted text of the specs the run delivered, from the spec snapshots. */
  specs: ReadonlyArray<{ path: string; text: string }>;
  /* The failure message of each failed case, as the run recorded it. */
  failures: ReadonlyArray<{ name: string; message: string }>;
}

/* Byte caps of a judge prompt: the budget is per day, so the input of one call is bounded and says what it cut. */
export const JUDGE_INPUT_CAPS = {
  diffBytes: 12_000,
  specBytes: 8_000,
  specsBytes: 24_000,
  failureBytes: 1_500,
  failures: 8,
  totalBytes: 48_000,
} as const;

export type JudgeInput = { ok: true; text: string; truncated: string[] } | { ok: false; reason: string };

/* Cuts `text` to at most `max` bytes of UTF-8 without splitting a character. */
export function capUtf8(text: string, max: number): { text: string; cut: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, cut: false };
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), cut: true };
}

const NOT_GRADABLE_VERDICTS = ["pass", "skipped"];

/* Untrusted text (the commit's, the spec's, the failure's) goes between fences the prompt tells the judge to read as data. */
const neutralize = (text: string): string => text.replaceAll("<<<", "< < <").replaceAll(">>>", "> > >");
const fence = (label: string, body: string): string => `<<<${neutralize(label)}\n${neutralize(body)}\n${neutralize(label)}>>>`;

/*
 * The prompt of one judge call for one run, or why the run is not gradable by it (the caller records "not applicable", never a score).
 * `sanitize` is the outbound prompt redaction; a text it refuses (a secret it still sees) makes the run not gradable: nothing is sent.
 */
export function buildJudgeInput(name: JudgeName, e: JudgeEvidence, sanitize: (text: string) => string): JudgeInput {
  if (e.cancelled) return { ok: false, reason: "the run was cancelled" };
  const truncated: string[] = [];
  const clean = (label: string, text: string, max: number): string => {
    const capped = capUtf8(sanitize(text), max);
    if (capped.cut) truncated.push(label);
    return capped.text;
  };
  try {
    const parts: string[] = [`judge: ${name}`, `run mode: ${e.mode}`];
    if (name === "spec_relevance") {
      if (e.diff === undefined || e.diff.trim() === "") return { ok: false, reason: "the run held no commit diff" };
      if (e.specs.length === 0) return { ok: false, reason: "the run delivered no spec" };
      parts.push(fence("DIFF", clean("diff", e.diff, JUDGE_INPUT_CAPS.diffBytes)));
      let budget: number = JUDGE_INPUT_CAPS.specsBytes;
      for (const spec of e.specs) {
        if (budget <= 0) {
          truncated.push(`spec ${spec.path}`);
          continue;
        }
        const body = clean(`spec ${spec.path}`, spec.text, Math.min(JUDGE_INPUT_CAPS.specBytes, budget));
        budget -= Buffer.byteLength(body, "utf8");
        parts.push(fence(`SPEC ${sanitize(spec.path)}`, body));
      }
    } else {
      if (e.verdict === null || NOT_GRADABLE_VERDICTS.includes(e.verdict)) return { ok: false, reason: "the run did not fail" };
      if (e.failures.length === 0 && e.errorClass === null) return { ok: false, reason: "the run recorded no failure evidence" };
      parts.push(`verdict: ${e.verdict}`, `error class: ${e.errorClass ?? "none recorded"}`, `furthest phase: ${e.furthestPhase ?? "unknown"}`);
      for (const failure of e.failures.slice(0, JUDGE_INPUT_CAPS.failures)) {
        parts.push(fence(`FAILURE ${sanitize(failure.name)}`, clean(`failure ${failure.name}`, failure.message, JUDGE_INPUT_CAPS.failureBytes)));
      }
      if (e.failures.length > JUDGE_INPUT_CAPS.failures) truncated.push(`failures (${e.failures.length - JUDGE_INPUT_CAPS.failures} not shown)`);
      /* The spec that failed is evidence of what it tried; it is included when the run kept it. */
      let budget: number = JUDGE_INPUT_CAPS.specsBytes;
      for (const spec of e.specs) {
        if (budget <= 0) break;
        const body = clean(`spec ${spec.path}`, spec.text, Math.min(JUDGE_INPUT_CAPS.specBytes, budget));
        budget -= Buffer.byteLength(body, "utf8");
        parts.push(fence(`SPEC ${sanitize(spec.path)}`, body));
      }
    }
    const whole = capUtf8(parts.join("\n\n"), JUDGE_INPUT_CAPS.totalBytes);
    if (whole.cut) truncated.push("input");
    return { ok: true, text: whole.text, truncated };
  } catch (err) {
    /* A text the redaction refuses is never sent; the reason carries no part of it. */
    return { ok: false, reason: `the evidence could not be sanitized (${err instanceof Error ? err.name : "error"})` };
  }
}

/* ---- Output ------------------------------------------------------------------------------------------------------------ */

export const MAX_JUDGE_OUTPUT_BYTES = 20_000;
export const MAX_CRITIQUE_CHARS = 2_000;

export type JudgeParse = { ok: true; value: boolean | string; critique: string } | { ok: false; reason: string };

/* The one JSON object of an answer: the whole reply, or a reply that is a single fenced block. Prose around it is not accepted. */
function jsonText(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fenced?.[1]?.trim();
}

/*
 * Parses a judge's reply against its definition: exactly `{verdict, critique}`, the verdict from the judge's closed set (`pass|fail` for
 * a binary judge), a non-empty critique. Anything else is `ok: false` with a reason; no guess is ever made.
 */
export function parseJudgeOutput(def: JudgeDefinition, raw: string): JudgeParse {
  if (Buffer.byteLength(raw, "utf8") > MAX_JUDGE_OUTPUT_BYTES) return { ok: false, reason: "reply too long" };
  const text = jsonText(raw);
  if (text === undefined) return { ok: false, reason: "reply is not a single JSON object" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "reply is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "reply is not a JSON object" };
  const object = parsed as Record<string, unknown>;
  const extra = Object.keys(object).filter((k) => k !== "verdict" && k !== "critique");
  if (extra.length > 0) return { ok: false, reason: `unexpected key ${extra[0]}` };
  const { verdict, critique } = object;
  if (typeof critique !== "string" || critique.trim() === "") return { ok: false, reason: "critique missing" };
  if (critique.length > MAX_CRITIQUE_CHARS) return { ok: false, reason: "critique too long" };
  if (typeof verdict !== "string") return { ok: false, reason: "verdict missing" };
  const trimmedCritique = critique.trim();
  if (def.dataType === "BOOLEAN") {
    if (verdict !== "pass" && verdict !== "fail") return { ok: false, reason: "verdict is not pass or fail" };
    return { ok: true, value: verdict === "pass", critique: trimmedCritique };
  }
  if (!def.categories?.includes(verdict)) return { ok: false, reason: "verdict is outside the closed set" };
  return { ok: true, value: verdict, critique: trimmedCritique };
}

/* ---- Score ------------------------------------------------------------------------------------------------------------- */

/* The score of a parsed answer. The prompt version is in the grader version, the model that answered in `judgeModel`. */
export function judgeScore(def: JudgeDefinition, parsed: Extract<JudgeParse, { ok: true }>, by: { promptVersion: string; model: string }): Score {
  return {
    name: def.name,
    value: parsed.value,
    dataType: def.dataType,
    polarity: def.polarity,
    source: "llm_judge",
    graderVersion: judgeGraderVersion(def.name, by.promptVersion),
    comment: parsed.critique.slice(0, MAX_SCORE_COMMENT_CHARS),
    judgeModel: by.model,
  };
}

/* ---- Catalog ----------------------------------------------------------------------------------------------------------- */

export interface JudgeCatalogEntry {
  name: JudgeName;
  dataType: JudgeDefinition["dataType"];
  polarity: ScorePolarity;
  categories?: readonly string[];
  graderVersion: string;
  status: JudgeStatus;
}

/* The judges as `GET /evaluations/catalog` lists them, for the prompt version in force. */
export function judgeCatalog(promptVersion: string, statusOf: (name: JudgeName) => JudgeStatus): JudgeCatalogEntry[] {
  return JUDGES.map((j) => ({
    name: j.name,
    dataType: j.dataType,
    polarity: j.polarity,
    ...(j.categories ? { categories: j.categories } : {}),
    graderVersion: judgeGraderVersion(j.name, promptVersion),
    status: statusOf(j.name),
  }));
}

/* What a human label of a judge's score name must conform to (the labels import types a label by it). */
export function judgeLabelSpec(name: string): { dataType: JudgeDefinition["dataType"]; polarity: ScorePolarity; categories?: readonly string[] } | undefined {
  const def = JUDGES.find((j) => j.name === name);
  return def ? { dataType: def.dataType, polarity: def.polarity, ...(def.categories ? { categories: def.categories } : {}) } : undefined;
}
