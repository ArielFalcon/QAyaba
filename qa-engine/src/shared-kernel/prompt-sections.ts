/* The prompt engine. A prompt is a list of section definitions: each declares the section it is, why it exists, whether its bytes vary per run, when it applies to a turn's context and how it renders from it. Assembly renders the sections that apply, orders them (the stable prefix first, then the run's facts, then the closing recap; by tier and priority within each), caps and sheds them to the byte budget and reports each survivor's size, hash and claims. Every role's prompt (generator, reviewer, the lead's turns, a delegation brief) is assembled here, so section sizes, hashes, budgets and the prompt-contract lint apply to all of them. Never import src/. */
import { engineLog } from "./ports/process-logger.ts";
import { sha256Hex } from "./content-hash.ts";
import { redactByValue } from "./run-secret-redaction.ts";
import type { PromptClaim } from "./prompt-claim.ts";
import type { Omission, SectionMeta } from "./telemetry/section-meta.ts";

export interface AssembleOpts {
  /* Global byte budget for the assembled prompt. When provided and positive, the assembler sheds lowest-priority sections until the total fits within this limit. 0 or absent means no global budget enforcement. */
  budgetBytes?: number;
  /* What joins two surviving sections: one newline by default; a prompt whose sections are blocks of prose separates them with a blank line. */
  separator?: string;
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
}

export type SectionOpts = Partial<Pick<Section, "priority" | "maxBytes" | "stability" | "overflow" | "language" | "shedAs" | "claims" | "itemIds" | "omissions">>;

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
  /* The sections the byte budget omitted, the ones the prompt's own omission notice names. */
  droppedSections?: readonly string[];
  /* The byte budget the prompt was assembled to; absent when none applied. */
  budgetBytes?: number;
  /* Bytes of the stable prefix: the static sections that open the prompt, joined, without the separator after them. 0 when the prompt opens with a run fact. */
  stablePrefixBytes: number;
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

  interface ResolvedSection {
    section: Section;
    content: string;
    dropped: boolean;
    /* The content was cut to a bound (its maxBytes, or the byte budget): the section survives, but its items are not all there. */
    capped: boolean;
  }

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

  const droppedIds: string[] = [];
  const budgetBytes = opts.budgetBytes ?? 0;
  if (budgetBytes > 0) {
    const totalBytes = () => {
      const surviving = resolved.filter((r) => !r.dropped && r.content);
      const contentBytes = surviving.reduce((sum, r) => sum + Buffer.byteLength(r.content, "utf8"), 0);
      const joinBytes = surviving.length > 1 ? (surviving.length - 1) * separatorBytes : 0;
      return contentBytes + joinBytes;
    };

    if (totalBytes() > budgetBytes) {
      const SHED_ROLE_ORDER: Record<SectionRole, number> = {
        "volatile": 1,
        "semi-stable": 2,
        "task": 3,
        "stable-prefix": 4,
        "critical-recap": 4,
      };


      const shedBand = (s: Section): number => SHED_ROLE_ORDER[s.shedAs ?? s.role];
      const candidates = resolved
        .filter((r) => !r.dropped)
        .sort((a, b) => {
          const roleA = shedBand(a.section);
          const roleB = shedBand(b.section);
          if (roleA !== roleB) return roleA - roleB;
          return b.section.priority - a.section.priority;
        });

      for (const candidate of candidates) {
        if (totalBytes() <= budgetBytes) break;

        const originalBytes = Buffer.byteLength(candidate.content, "utf8");

        if (candidate.section.overflow === "drop") {
          engineLog.warn(
            `[context-assembler] BUDGET OVERFLOW: shedding section '${candidate.section.id}' ` +
              `(${originalBytes} bytes, overflow='drop') — total was ${totalBytes()} bytes, ` +
              `budget is ${budgetBytes} bytes.`,
          );
          candidate.dropped = true;
          candidate.content = "";
          droppedIds.push(candidate.section.id);
        } else {
          const remainingBudget = budgetBytes - (totalBytes() - originalBytes);
          if (remainingBudget <= 0) {
            engineLog.warn(
              `[context-assembler] BUDGET OVERFLOW: shedding section '${candidate.section.id}' ` +
                `(${originalBytes} bytes, overflow='summarize' → no room → dropping entirely) — ` +
                `total was ${totalBytes()} bytes, budget is ${budgetBytes} bytes.`,
            );
            candidate.dropped = true;
            candidate.content = "";
            droppedIds.push(candidate.section.id);
          } else {
            const markerOverhead = Buffer.byteLength(
              `\n…(section '${candidate.section.id}' capped at ${remainingBudget} bytes)`,
              "utf8",
            );
            const contentTarget = remainingBudget - markerOverhead;
            if (contentTarget <= 0) {
              engineLog.warn(
                `[context-assembler] BUDGET OVERFLOW: shedding section '${candidate.section.id}' ` +
                  `(${originalBytes} bytes, overflow='summarize' → no room after marker overhead → dropping entirely) — ` +
                  `total was ${totalBytes()} bytes, budget is ${budgetBytes} bytes.`,
              );
              candidate.dropped = true;
              candidate.content = "";
            } else {
              const truncated = capToBytes(candidate.content, contentTarget, candidate.section.id);
              engineLog.warn(
                `[context-assembler] BUDGET OVERFLOW: truncating section '${candidate.section.id}' ` +
                  `from ${originalBytes} to ${Buffer.byteLength(truncated, "utf8")} bytes ` +
                  `(overflow='summarize') — total was ${totalBytes()} bytes, budget is ${budgetBytes} bytes.`,
              );
              candidate.content = truncated;
              candidate.capped = true;
            }
          }
        }
      }

      if (totalBytes() > budgetBytes) {
        engineLog.warn(
          `[context-assembler] BUDGET OVERFLOW: could not shed enough sections to meet ` +
            `${budgetBytes}-byte budget (remaining: ${totalBytes()} bytes). ` +
            `The assembled prompt exceeds the role budget — raise budgetBytes or reduce section sizes.`,
        );
      }
    }
  }

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
    if (r.section.claims?.length) claims[r.section.id] = r.section.claims;
    if (inPrefix && band(r.section) === 0) stablePrefixBytes += (parts.length > 0 ? separatorBytes : 0) + sectionSizes[r.section.id]!;
    else inPrefix = false;
    parts.push(r.content);
  }

  /* A grounding section that the assembler capped or shed delivers no ids: all its declared items are omitted with that reason (conservative, so a grader never over-counts what the agent was given). */
  const sectionItems: Record<string, SectionMeta> = {};
  for (const r of resolved) {
    const declared = r.section.itemIds ?? [];
    const declaredOmissions = r.section.omissions ?? [];
    if (declared.length === 0 && declaredOmissions.length === 0) continue;
    const omissions = [...declaredOmissions];
    if (r.dropped && declared.length > 0) omissions.push({ class: "truncation", reason: "section-shed", count: declared.length });
    else if (r.capped && declared.length > 0) omissions.push({ class: "truncation", reason: "section-cap", count: declared.length });
    sectionItems[r.section.id] = { itemIds: r.dropped || r.capped ? [] : [...declared], omissions, capped: r.capped };
  }

  if (droppedIds.length > 0) {
    const notice =
      `⚠ Budget: these context sections were omitted and are NOT below: ${droppedIds.join(", ")}. ` +
      `If a flow needs DOM/structure/contracts you did not receive, explore it directly — do not assume it is absent.`;
    parts.push(notice);
  }

  const text = parts.join(separator);
  return {
    text,
    sectionSizes,
    claims,
    sectionItems,
    sectionHashes,
    droppedSections: droppedIds,
    ...(budgetBytes > 0 ? { budgetBytes } : {}),
    stablePrefixBytes,
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
  };
}

/* What a section renders: its text, and the options that bound or describe it. */
export interface SectionRender extends Pick<SectionOpts, "claims" | "itemIds" | "omissions" | "maxBytes" | "overflow" | "shedAs" | "language"> {
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
