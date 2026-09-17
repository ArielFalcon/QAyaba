

import { ContextAssemblerAdapter } from "@contexts/generation/infrastructure/context-assembler.adapter.ts";

export interface AssembleOpts {
  /* Global byte budget for the assembled prompt. When provided and positive, the assembler sheds lowest-priority sections until the total fits within this limit. 0 or absent means no global budget enforcement (Phase-1 behaviour, unchanged). */
  budgetBytes?: number;
}

export type SectionRole =
  | "stable-prefix"
  | "semi-stable"
  | "volatile"
  | "task"
  | "critical-recap";

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
  cacheable?: boolean;
  overflow: "summarize" | "drop";
  language: "scaffold" | "verbatim";
  shedAs?: SectionRole;
}

export interface AssembledPrompt {
  text: string;
  sectionSizes: Record<string, number>;
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
  console.warn(
    `[context-assembler] section '${sectionId}' truncated from ${buf.length} to ${maxBytes} bytes (overflow='summarize' degrades to truncation).`,
  );
  return truncated + `\n…(section '${sectionId}' capped at ${maxBytes} bytes)`;
}

function assembleImpl(sections: Section[], opts: AssembleOpts = {}): AssembledPrompt {
  const sorted = [...sections].sort((a, b) => {
    const ra = ROLE_ORDER[a.role];
    const rb = ROLE_ORDER[b.role];
    if (ra !== rb) return ra - rb;
    return a.priority - b.priority;
  });

  interface ResolvedSection {
    section: Section;
    content: string;
    dropped: boolean;
  }

  const resolved: ResolvedSection[] = [];
  for (const sec of sorted) {
    const raw = typeof sec.content === "function" ? sec.content() : sec.content;
    if (!raw) continue;

    const overInnerBudget = sec.maxBytes > 0 && Buffer.byteLength(raw, "utf8") > sec.maxBytes;
    if (overInnerBudget && sec.overflow === "drop") {
      console.warn(
        `[context-assembler] section '${sec.id}' (${Buffer.byteLength(raw, "utf8")} bytes) exceeds maxBytes ${sec.maxBytes} and overflow='drop' — omitting the whole section.`,
      );
      resolved.push({ section: sec, content: "", dropped: true });
      continue;
    }

    const capped = capToBytes(raw, sec.maxBytes, sec.id);
    resolved.push({ section: sec, content: capped, dropped: false });
  }

  const droppedIds: string[] = [];
  const budgetBytes = opts.budgetBytes ?? 0;
  if (budgetBytes > 0) {
    const totalBytes = () => {
      const surviving = resolved.filter((r) => !r.dropped && r.content);
      const contentBytes = surviving.reduce((sum, r) => sum + Buffer.byteLength(r.content, "utf8"), 0);
      const separatorBytes = surviving.length > 1 ? surviving.length - 1 : 0;
      return contentBytes + separatorBytes;
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
          console.warn(
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
            console.warn(
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
              console.warn(
                `[context-assembler] BUDGET OVERFLOW: shedding section '${candidate.section.id}' ` +
                  `(${originalBytes} bytes, overflow='summarize' → no room after marker overhead → dropping entirely) — ` +
                  `total was ${totalBytes()} bytes, budget is ${budgetBytes} bytes.`,
              );
              candidate.dropped = true;
              candidate.content = "";
            } else {
              const truncated = capToBytes(candidate.content, contentTarget, candidate.section.id);
              console.warn(
                `[context-assembler] BUDGET OVERFLOW: truncating section '${candidate.section.id}' ` +
                  `from ${originalBytes} to ${Buffer.byteLength(truncated, "utf8")} bytes ` +
                  `(overflow='summarize') — total was ${totalBytes()} bytes, budget is ${budgetBytes} bytes.`,
              );
              candidate.content = truncated;
            }
          }
        }
      }

      if (totalBytes() > budgetBytes) {
        console.warn(
          `[context-assembler] BUDGET OVERFLOW: could not shed enough sections to meet ` +
            `${budgetBytes}-byte budget (remaining: ${totalBytes()} bytes). ` +
            `The assembled prompt exceeds the role budget — raise budgetBytes or reduce section sizes.`,
        );
      }
    }
  }

  const parts: string[] = [];
  const sectionSizes: Record<string, number> = {};

  for (const r of resolved) {
    if (r.dropped || !r.content) continue;
    sectionSizes[r.section.id] = Buffer.byteLength(r.content, "utf8");
    parts.push(r.content);
  }

  if (droppedIds.length > 0) {
    const notice =
      `⚠ Budget: these context sections were omitted and are NOT below: ${droppedIds.join(", ")}. ` +
      `If a flow needs DOM/structure/contracts you did not receive, explore it directly — do not assume it is absent.`;
    parts.push(notice);
  }

  return {
    text: parts.join("\n"),
    sectionSizes,
  };
}

function sectionImpl(
  id: string,
  role: SectionRole,
  content: string | (() => string),
  opts: Partial<Pick<Section, "priority" | "maxBytes" | "cacheable" | "overflow" | "language" | "shedAs">> = {},
): Section {
  return {
    id,
    role,
    content,
    priority: opts.priority ?? 0,
    maxBytes: opts.maxBytes ?? 0,
    cacheable: opts.cacheable ?? false,
    overflow: opts.overflow ?? "drop",
    language: opts.language ?? "scaffold",
    ...(opts.shedAs ? { shedAs: opts.shedAs } : {}),
  };
}

const defaultAssembler = new ContextAssemblerAdapter(assembleImpl, sectionImpl);

export function assemble(sections: Section[], opts: AssembleOpts = {}): AssembledPrompt {
  return defaultAssembler.assemble(sections, opts);
}

export function section(
  id: string,
  role: SectionRole,
  content: string | (() => string),
  opts: Partial<Pick<Section, "priority" | "maxBytes" | "cacheable" | "overflow" | "language" | "shedAs">> = {},
): Section {
  return defaultAssembler.section(id, role, content, opts);
}
