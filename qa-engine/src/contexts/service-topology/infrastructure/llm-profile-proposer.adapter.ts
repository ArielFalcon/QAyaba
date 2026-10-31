
import { dirname, sep } from "node:path";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { LoggerPort } from "@kernel/ports/logger.port.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import type { ProfileProposerPort } from "../application/ports/profile-proposer.port.ts";
import type { BoundaryProfile, RepoRef } from "../domain/index.ts";
import type { ProposerFeedback } from "../domain/profile-score.ts";
import { closingJsonObject } from "@kernel/last-json-object.ts";
import { ProposerVerdictSchema, UNPARSEABLE_SENTINEL, type SchemaCandidate } from "../application/proposer-verdict.schema.ts";

/* Default per-session timeout when the caller doesn't override it via ctx.timeoutMs. */
const DEFAULT_PROPOSER_TIMEOUT_MS = 5 * 60 * 1000;

/* A candidate degrades to this sentinel on a per-entry schema parse failure (see
 *  ProposerVerdictSchema); filter it before returning so a malformed sibling never poisons an
 *  otherwise-valid round. */
function isUnparseableSentinel(candidate: SchemaCandidate): boolean {
  return candidate.transport === "http" && candidate.frontFiles === UNPARSEABLE_SENTINEL.frontFiles;
}

/* Extracts the JSON payload of an LLM's free-form reply: the object that closes it, when it carries `candidates` (the kernel
 *  scanner: narration braces never hide it, a closing fence does not count, and an earlier draft, fenced or not, never stands in
 *  for it). Returns null when the reply does not close with one; the caller degrades that to a fail-open empty verdict. */
function extractJson(text: string): unknown {
  const closing = closingJsonObject(text);
  return closing !== undefined && "candidates" in closing ? closing : null;
}

/* Assembles the doc block spelling out both transport shapes with exact field names, so the
 *  proposer's output stays schema-accurate even without live access to this repo's source. */
function transportShapesDoc(): string {
  return [
    "Boundary profile shapes you may propose (emit ONLY fields listed here, using these exact names):",
    "",
    "http transport:",
    '  { "transport": "http", "frontFiles": string, "frontCallSite": { "kind": string, "receiver"?: string },',
    '    "servicePrefixTemplate": string, "serviceRepoTemplate": string, "openApiPath": string }',
    "",
    "event transport:",
    '  { "transport": "event", "files": string, "eventPattern": { "kind": string, "listenerBaseType": string,',
    '    "listenerEventCall": string, "subscriberBaseType": string, "publishCall": string } }',
    "",
    "http-backend transport (BE→BE REST clients — RestTemplate / Feign / WebClient; FE→BE HTTP stays http):",
    '  { "transport": "http-backend", "sourceFiles": string, "callPattern": { "kind": string, "receiver"?: string },',
    '    "servicePrefixTemplate": string, "serviceRepoTemplate": string, "openApiPath": string }',
    "",
    "Field dialect — a candidate violating these scores ZERO no matter how plausible it looks:",
    '- "frontFiles"/"files"/"sourceFiles": FILENAME-SUFFIX globs only — "**/*.<suffix>" or "*.<suffix>" (e.g. "**/*.api.ts").',
    "  Path-anchored globs (any path segment before the *) are unsupported and match NO files;",
    "  encode the convention in the filename suffix, never in directories.",
    '- "frontCallSite.kind": must be "receiver-verb-call" (calls shaped this.<receiver>.<verb>(...);',
    '  put the injected client field name in "receiver").',
    '- "eventPattern.kind": must be "class-based-domain-events".',
    '- "callPattern.kind": must be "rest-template-exchange" | "feign-client" | "web-client".',
    '- "openApiPath": a LITERAL repo-relative file path inside each service repo (never a glob),',
    '  e.g. "src/main/resources/openapi/api-definition.yaml".',
    '- Templates use {service}: e.g. "servicePrefixTemplate": "svc-{service}-api" -> "serviceRepoTemplate": "ms-{service}".',
    "Propose http-backend when backend repos call each other over HTTP (RestTemplate, Feign, WebClient).",
  ].join("\n");
}

/* Compact "round N proposed X scored Y; refine" summary for the previous onboarding round(s),
 *  so the proposer can steer away from a low-scoring guess instead of repeating it blind. */
function feedbackSummary(feedback: ProposerFeedback): string {
  const lines = feedback.priorCandidates.map(({ profile, score }, index) => {
    const shape =
      profile.transport === "http"
        ? `servicePrefixTemplate="${profile.servicePrefixTemplate}"`
        : profile.transport === "event"
          ? `eventPattern.kind="${profile.eventPattern.kind}"`
          : `callPattern.kind="${profile.callPattern.kind}"`;
    return `  round ${index + 1}: transport=${profile.transport} ${shape} -> resolvedScore=${score.resolvedScore} (links=${score.links}, resolutionRatio=${score.resolutionRatio})`;
  });
  return ["Prior round(s) scored too low by the deterministic scorer — refine your next guess:", ...lines].join("\n");
}

function assemblePrompt(system: RepoRef[], front: RepoRef, app: string, feedback?: ProposerFeedback): string {
  const sections = [
    `App: ${app}`,
    `Frontend repo: ${front.repo} (mirror: ${front.mirrorDir})`,
    "Backend service repos:",
    ...system.map((s) => `  - ${s.repo} (mirror: ${s.mirrorDir})`),
    "",
    transportShapesDoc(),
  ];
  if (feedback && feedback.priorCandidates.length > 0) {
    sections.push("", feedbackSummary(feedback));
  }
  return sections.join("\n");
}

/* True when `target` is `ancestor` itself, or is nested inside it (segment-aware — appends `sep`
 *  before the `startsWith` check so "/a/foo" is never mistaken for an ancestor of "/a/foobar"). */
function isAncestorOrSelf(ancestor: string, target: string): boolean {
  if (ancestor === target) return true;
  const prefix = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
  return target.startsWith(prefix);
}

/* Walks `a` up its directory tree (via `dirname`) until it is an ancestor of (or equal to) `b`.
 *  Segment-aware by construction — never a naive string-prefix match. */
function pairwiseCommonAncestor(a: string, b: string): string {
  let candidate = a;
  while (!isAncestorOrSelf(candidate, b)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;  /* reached filesystem root; nothing higher to climb to */
    candidate = parent;
  }
  return candidate;
}

/** Lowest common ancestor of the front mirror and every service mirror so the proposer session
 *  contains every repo its prompt asks it to read. Sibling-mirror paths outside the session root
 *  trip opencode's external-read gate. Single-repo apps keep `front.mirrorDir`. */
export function commonSessionRoot(front: RepoRef, system: RepoRef[]): string {
  if (system.length === 0) return front.mirrorDir;
  return system.reduce((lca, s) => pairwiseCommonAncestor(lca, s.mirrorDir), front.mirrorDir);
}

/** LLM-backed ProfileProposerPort implementation. Ctor DI keeps the agent runtime, the logger and the
 *  redaction swappable (fakes drive the unit tests). The session runs the proposer role, on the model
 *  agents/opencode.json declares for it. */
export class LlmProfileProposerAdapter implements ProfileProposerPort {
  constructor(
    private readonly runtime: Pick<AgentRuntimePort, "openSession">,
    private readonly logger: LoggerPort,
    private readonly redaction: Pick<RedactionPort, "redactError">,
    private readonly ctx: { app: string; timeoutMs?: number; signal?: AbortSignal },
  ) {}

  async propose(system: RepoRef[], front: RepoRef, feedback?: ProposerFeedback): Promise<BoundaryProfile[]> {
    try {
      const session = await this.runtime.openSession("proposer", commonSessionRoot(front, system), {
        timeoutMs: this.ctx.timeoutMs ?? DEFAULT_PROPOSER_TIMEOUT_MS,
        ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
      });
      try {
        const { output: text } = await session.prompt(assemblePrompt(system, front, this.ctx.app, feedback));
        const parsed = ProposerVerdictSchema.parse(extractJson(text));
        return parsed.candidates.filter((c) => !isUnparseableSentinel(c));
      } finally {
        await Promise.resolve(session.dispose()).catch(() => {});
      }
    } catch (err) {
      /*
       * Fail-open by contract (ProfileProposerPort doc): any throw — open() failure, prompt()
       * rejection/timeout, unparseable text — degrades to an empty round, never propagates.
       * Instrumented (do NOT silently swallow): emit exactly one structured warn with the redacted
       * real error + the context needed to identify the actual throw. The redaction port's redactError reads only
       * err.message and scrubs it — it never serializes structured SDK bodies or the stack (no new leak surface).
       */
      this.logger.warn("onboarding proposer round failed (fail-open, returning no candidates)", {
        app: this.ctx.app,
        error: this.redaction.redactError(err),
      });
      return [];
    }
  }
}
