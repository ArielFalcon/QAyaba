/* The prompt engine. A prompt is a list of section definitions: each declares the section it is, why it exists, whether its bytes vary per run, when it applies to a turn's context and how it renders from it. Assembly renders the sections that apply, orders them (the stable prefix first, then the run's facts, then the closing recap; by tier and priority within each), degrades them to references by the window fit rule when the prompt is over its role's window and reports each survivor's size, hash and claims. Every role's prompt (generator, reviewer, the lead's turns, a delegation brief) is assembled here, so section sizes, hashes and the prompt-contract lint apply to all of them. Never import src/. */
import { engineLog } from "./ports/process-logger.ts";
import { sha256Hex } from "./content-hash.ts";
import { redactByValue } from "./run-secret-redaction.ts";
import type { PromptClaim } from "./prompt-claim.ts";
import type { Omission, SectionMeta } from "./telemetry/section-meta.ts";

export interface AssembleOpts {
  /* What joins two surviving sections: one newline by default; a prompt whose sections are blocks of prose separates them with a blank line. */
  separator?: string;
  /* The window fit rule of the role the prompt is for (the run's ContextBudget): whether a prompt of this many bytes leaves the role the working room its turn needs. Over, the sections that can degrade do, in WINDOW_FIT_ORDER, until the prompt fits; unknown (or absent), nothing is degraded: the prompt fails open. */
  fit?: (bytes: number) => WindowFitOutcome;
}

export type WindowFitOutcome = "fits" | "over" | "unknown";

/* The omission reason a window-fit degradation records: what a section left out because the prompt was over its role's window. */
export const WINDOW_FIT_REASON = "window-fit";

/*
 * One smaller render of a section, for a prompt over its role's window. It names what it leaves out (as references: a page, a
 * file, a path, a count) and records it: `omissions` is everything this render leaves out of the whole section, never only what
 * its own step added. `itemIds` are the ids it still supplies; absent, it supplies none.
 */
export interface SectionDegradation {
  content: string;
  omissions: readonly Omission[];
  itemIds?: readonly string[];
  /* The claims this render makes besides the section's own (a smaller render can provide a fact the whole one never needed to declare, such as the references that stand for a diff). */
  claims?: readonly PromptClaim[];
}

/* What the window fit rule did to one section: the last step it took and the bytes before and after. */
export interface DegradedSection {
  id: string;
  step: number;
  fromBytes: number;
  toBytes: number;
}

/* The outcome of the window fit rule for one prompt: its fit after degradation, and the sections it degraded, in the order it took them. */
export interface WindowFit {
  outcome: WindowFitOutcome;
  degraded: readonly DegradedSection[];
}

export type SectionRole =
  | "stable-prefix"
  | "semi-stable"
  | "volatile"
  | "task"
  | "critical-recap";

/*
 * Whether a section's bytes vary per run. A static section renders the same bytes for every run of the same app and turn shape
 * (mode, target, which inputs are present): instructions, contracts, fixed rules. A run section carries a fact of the run (its id,
 * namespace, sha, diff, DOM, findings, budgets). Static sections form the prompt's stable prefix, so a provider's prompt cache can
 * reuse it across runs; nothing per-run (a timestamp, a run id, a sha, an unordered serialization) may render in one.
 */
export type SectionStability = "static" | "run";

/* The closing recap (the contract or instruction that ends a turn) stays last whatever its stability: the answer it asks for is read last. */
const band = (section: Pick<Section, "role" | "stability">): number => (section.role === "critical-recap" ? 2 : section.stability === "static" ? 0 : 1);

const ROLE_ORDER: Record<SectionRole, number> = {
  "stable-prefix": 1,
  "semi-stable": 2,
  "volatile": 3,
  "task": 4,
  "critical-recap": 5,
};

export interface Section {
  id: string;
  role: SectionRole;
  priority: number;
  maxBytes: number;
  content: string | (() => string);
  /* Absent reads as "run": a section is in the stable prefix only when it says so. */
  stability?: SectionStability;
  overflow: "summarize" | "drop";
  language: "scaffold" | "verbatim";
  shedAs?: SectionRole;
  /* What the section provides / frames / directs, for the prompt-contract lint. Reported only while the section survives assembly. */
  claims?: readonly PromptClaim[];
  /* Stable ids of the grounding items this section supplies (context-item-ids.ts). Absent for a section that supplies none. */
  itemIds?: readonly string[];
  /* The items this section chose to leave out, before the assembler's own cap/shed. */
  omissions?: readonly Omission[];
  /* The section's smaller renders for a prompt over its role's window, step 1 the first: undefined past the last. A section without one is never degraded for the window (instructions, contracts, the task). */
  degrade?: (step: number) => SectionDegradation | undefined;
}

export type SectionOpts = Partial<Pick<Section, "priority" | "maxBytes" | "stability" | "overflow" | "language" | "shedAs" | "claims" | "itemIds" | "omissions" | "degrade">>;

export interface AssembledPrompt {
  text: string;
  sectionSizes: Record<string, number>;
  /* Claims of the sections that survived assembly, keyed by section id; a shed or dropped section contributes none. */
  claims: Record<string, readonly PromptClaim[]>;
  /* What each grounding section supplied and lost, from the kept assembly: its item ids, its omissions and whether the assembler capped it. Keyed by section id. */
  sectionItems: Record<string, SectionMeta>;
  /* Files whose content the surviving sections already render, by path relative to the working copy. Set by the builder after assembly; absent for prompts that render no file. */
  providedPaths?: readonly string[];
  /* sha256 of each surviving section's bytes with the run's secrets taken out by value, keyed by section id. Computed when the prompt is assembled, which the use case does inside the run's secret scope; the hash of the whole prompt is the transport's, over the bytes it sends. The text itself is left as it was: the transport redacts it at its own seam. */
  sectionHashes?: Record<string, string>;
  /* Bytes of the stable prefix: the static sections that open the prompt, joined, without the separator after them. 0 when the prompt opens with a run fact. */
  stablePrefixBytes: number;
  /* What the window fit rule did; absent when no fit rule was given. */
  windowFit?: WindowFit;
}

function truncateToValidUtf8(buf: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && (buf[end] !== undefined) && (buf[end]! & 0xc0) === 0x80) end--;
  if (end > 0) {
    const lead = buf[end - 1]!;
    const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (seqLen > 1 && end - 1 + seqLen > Math.min(maxBytes, buf.length)) end--;
  }
  return buf.subarray(0, end).toString("utf8");
}

function capToBytes(text: string, maxBytes: number, sectionId: string): string {
  if (maxBytes <= 0 || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  const truncated = truncateToValidUtf8(buf, maxBytes);
  engineLog.warn(
    `[context-assembler] section '${sectionId}' truncated from ${buf.length} to ${maxBytes} bytes (overflow='summarize' degrades to truncation).`,
  );
  return truncated + `\n…(section '${sectionId}' capped at ${maxBytes} bytes)`;
}

interface ResolvedSection {
  section: Section;
  content: string;
  dropped: boolean;
  /* The content was cut to the section's own maxBytes: the section survives, but its items are not all there. */
  capped: boolean;
  /* The window fit rule replaced the content with a smaller render of the section: its step, and what it leaves out. */
  degradation?: SectionDegradation & { step: number };
}

/* The order sections give way in for the window: the volatile run facts first, then the semi-stable ones, then the task; the stable prefix and the closing recap last. Within a band, the lowest priority (the highest number) first. */
const WINDOW_FIT_ORDER: Record<SectionRole, number> = {
  "volatile": 1,
  "semi-stable": 2,
  "task": 3,
  "stable-prefix": 4,
  "critical-recap": 4,
};

function byShedOrder(a: ResolvedSection, b: ResolvedSection): number {
  const bandA = WINDOW_FIT_ORDER[a.section.shedAs ?? a.section.role];
  const bandB = WINDOW_FIT_ORDER[b.section.shedAs ?? b.section.role];
  if (bandA !== bandB) return bandA - bandB;
  return b.section.priority - a.section.priority;
}

function joinedBytes(resolved: readonly ResolvedSection[], separatorBytes: number): number {
  const surviving = resolved.filter((r) => !r.dropped && r.content);
  const contentBytes = surviving.reduce((sum, r) => sum + Buffer.byteLength(r.content, "utf8"), 0);
  return contentBytes + Math.max(0, surviving.length - 1) * separatorBytes;
}

/*
 * The window fit rule (ContextBudget): content is kept while the prompt fits its role's window with the working room its turn needs.
 * Over, the sections that can degrade give way in WINDOW_FIT_ORDER, each through its own steps (its references to what it leaves
 * out), one section at a time, until the prompt fits; a prompt still over with every step taken is sent as it is, and the outcome
 * says so. An unknown fit degrades nothing (fail open). Every degradation is logged with what it left out.
 */
function fitToWindow(resolved: ResolvedSection[], fit: (bytes: number) => WindowFitOutcome, separatorBytes: number): WindowFit {
  let outcome = fit(joinedBytes(resolved, separatorBytes));
  const degraded: DegradedSection[] = [];
  if (outcome !== "over") return { outcome, degraded };
  for (const r of resolved.filter((entry) => !entry.dropped && entry.content && entry.section.degrade).sort(byShedOrder)) {
    const fromBytes = Buffer.byteLength(r.content, "utf8");
    for (let step = 1; outcome === "over"; step++) {
      const next = r.section.degrade!(step);
      if (next === undefined) break;
      r.content = next.content;
      r.degradation = { ...next, step };
      outcome = fit(joinedBytes(resolved, separatorBytes));
    }
    if (r.degradation) {
      const entry = { id: r.section.id, step: r.degradation.step, fromBytes, toBytes: Buffer.byteLength(r.content, "utf8") };
      degraded.push(entry);
      const left = r.degradation.omissions.map((o) => `${o.count} ${o.reason}${o.route !== undefined ? ` on ${o.route}` : ""}`).join(", ");
      engineLog.warn(`[context-assembler] section '${entry.id}' degraded to fit its role's window: ${entry.fromBytes} to ${entry.toBytes} bytes (step ${entry.step}${left ? `; left out as references: ${left}` : ""}).`);
    }
    if (outcome !== "over") break;
  }
  if (outcome === "over") engineLog.warn(`[context-assembler] the prompt is over its role's window with every section that can degrade degraded (${joinedBytes(resolved, separatorBytes)} bytes); it is sent as it is.`);
  return { outcome, degraded };
}

export function assembleSections(sections: Section[], opts: AssembleOpts = {}): AssembledPrompt {
  const separator = opts.separator ?? "\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  const sorted = [...sections].sort((a, b) => {
    const ba = band(a);
    const bb = band(b);
    if (ba !== bb) return ba - bb;
    const ra = ROLE_ORDER[a.role];
    const rb = ROLE_ORDER[b.role];
    if (ra !== rb) return ra - rb;
    return a.priority - b.priority;
  });

  const resolved: ResolvedSection[] = [];
  for (const sec of sorted) {
    const raw = typeof sec.content === "function" ? sec.content() : sec.content;
    if (!raw) continue;

    const overInnerBudget = sec.maxBytes > 0 && Buffer.byteLength(raw, "utf8") > sec.maxBytes;
    if (overInnerBudget && sec.overflow === "drop") {
      engineLog.warn(
        `[context-assembler] section '${sec.id}' (${Buffer.byteLength(raw, "utf8")} bytes) exceeds maxBytes ${sec.maxBytes} and overflow='drop' — omitting the whole section.`,
      );
      resolved.push({ section: sec, content: "", dropped: true, capped: false });
      continue;
    }

    const content = capToBytes(raw, sec.maxBytes, sec.id);
    resolved.push({ section: sec, content, dropped: false, capped: content !== raw });
  }

  const windowFit = opts.fit ? fitToWindow(resolved, opts.fit, separatorBytes) : undefined;

  const parts: string[] = [];
  let stablePrefixBytes = 0;
  let inPrefix = true;
  const sectionSizes: Record<string, number> = {};
  const sectionHashes: Record<string, string> = {};
  const claims: Record<string, readonly PromptClaim[]> = {};

  for (const r of resolved) {
    if (r.dropped || !r.content) continue;
    sectionSizes[r.section.id] = Buffer.byteLength(r.content, "utf8");
    sectionHashes[r.section.id] = sha256Hex(redactByValue(r.content));
    const renderClaims = [...(r.section.claims ?? []), ...(r.degradation?.claims ?? [])];
    if (renderClaims.length) claims[r.section.id] = renderClaims;
    if (inPrefix && band(r.section) === 0) stablePrefixBytes += (parts.length > 0 ? separatorBytes : 0) + sectionSizes[r.section.id]!;
    else inPrefix = false;
    parts.push(r.content);
  }

  /* A grounding section that the assembler capped or shed delivers no ids: all its declared items are omitted with that reason (conservative, so a grader never over-counts what the agent was given). */
  const sectionItems: Record<string, SectionMeta> = {};
  for (const r of resolved) {
    const declared = r.degradation ? (r.degradation.itemIds ?? []) : (r.section.itemIds ?? []);
    const declaredOmissions = [...(r.section.omissions ?? []), ...(r.degradation?.omissions ?? [])];
    if (declared.length === 0 && declaredOmissions.length === 0) continue;
    const omissions = [...declaredOmissions];
    if (r.dropped && declared.length > 0) omissions.push({ class: "truncation", reason: "section-shed", count: declared.length });
    else if (r.capped && declared.length > 0) omissions.push({ class: "truncation", reason: "section-cap", count: declared.length });
    sectionItems[r.section.id] = { itemIds: r.dropped || r.capped ? [] : [...declared], omissions, capped: r.capped };
  }

  const text = parts.join(separator);
  return {
    text,
    sectionSizes,
    claims,
    sectionItems,
    sectionHashes,
    stablePrefixBytes,
    ...(windowFit ? { windowFit } : {}),
  };
}

export function makeSection(
  id: string,
  role: SectionRole,
  content: string | (() => string),
  opts: SectionOpts = {},
): Section {
  return {
    id,
    role,
    content,
    priority: opts.priority ?? 0,
    maxBytes: opts.maxBytes ?? 0,
    stability: opts.stability ?? "run",
    overflow: opts.overflow ?? "drop",
    language: opts.language ?? "scaffold",
    ...(opts.shedAs ? { shedAs: opts.shedAs } : {}),
    ...(opts.claims ? { claims: opts.claims } : {}),
    ...(opts.itemIds ? { itemIds: opts.itemIds } : {}),
    ...(opts.omissions ? { omissions: opts.omissions } : {}),
    ...(opts.degrade ? { degrade: opts.degrade } : {}),
  };
}

/* What a section renders: its text, and the options that bound or describe it. */
export interface SectionRender extends Pick<SectionOpts, "claims" | "itemIds" | "omissions" | "maxBytes" | "overflow" | "shedAs" | "language" | "degrade"> {
  content: string;
}

export interface PromptSectionDef<C> {
  id: string;
  tier: SectionRole;
  priority: number;
  /* Whether the section's bytes vary per run; a static one opens the prompt, in the stable prefix. */
  stability: SectionStability;
  /* The observed failure or the contract the section exists for, in a few words (a run id where one showed it). A section with no reason is a candidate for removal, measured by a campaign. */
  reason: string;
  /* Whether the section belongs in the prompt of this turn. A section that does not apply renders nothing and leaves no size, claim or item in the assembled prompt. */
  applies(ctx: C): boolean;
  render(ctx: C): SectionRender;
}

/* The sections of one turn, in registry order. */
export function renderSectionDefs<C>(defs: readonly PromptSectionDef<C>[], ctx: C): Section[] {
  return defs
    .filter((def) => def.applies(ctx))
    .map((def) => {
      const { content, ...opts } = def.render(ctx);
      return makeSection(def.id, def.tier, content, { priority: def.priority, stability: def.stability, ...opts });
    });
}

/* A prompt assembled from a registry of section definitions: the one way a role prompt is built. */
export function assembleDefs<C>(defs: readonly PromptSectionDef<C>[], ctx: C, opts: AssembleOpts = {}): AssembledPrompt {
  return assembleSections(renderSectionDefs(defs, ctx), opts);
}
