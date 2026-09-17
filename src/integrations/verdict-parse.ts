

import type { SpecMeta } from "../types";

export interface FinalVerdict {
  approved: boolean;
  specs: string[];
  specMetas?: SpecMeta[];
  note?: string;
  /** false when no verdict JSON was found (fail-closed). Distinguishes parse miss from rejection. */
  parsed: boolean;
}

/*
 * Extracts every BALANCED top-level JSON object from free-form agent text, respecting string
 * literals and escapes (so a `}` inside a string, or nested objects, never mis-split the span).
 * Returns them in document order; callers take the last one matching their shape. This replaces
 * brittle regex/lastIndexOf scanning of the agent's closing JSON.
 */
export function extractJsonObjects(text: string): unknown[] {
  const objs: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            objs.push(JSON.parse(text.slice(start, i + 1)));
          } catch {
            /* not valid JSON; ignore this span */
          }
          start = -1;
        }
      }
    }
  }
  return objs;
}

/* Returns the LAST extracted JSON object for which `pred` holds, or undefined. */
export function lastJsonMatching<T = Record<string, unknown>>(text: string, pred: (o: Record<string, unknown>) => boolean): T | undefined {
  const objs = extractJsonObjects(text);
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o && typeof o === "object" && pred(o as Record<string, unknown>)) return o as T;
  }
  return undefined;
}

/* Discriminator: the generator's closing JSON carries a `specs` array or a boolean `approved`. */
export function isClosingVerdict(o: Record<string, unknown>): boolean {
  return Array.isArray(o.specs) || typeof o.approved === "boolean";
}

/*
 * Last balanced object with `specs` or `approved`. A missing `approved` is not a rejection
 * (the reviewer is the gate); no parseable block is fail-closed with parsed:false.
 */
export function parseVerdict(text: string): FinalVerdict {
  const o = lastJsonMatching(text, isClosingVerdict);
  if (o) {
    return {
      approved: typeof o.approved === "boolean" ? o.approved : true,
      specs: Array.isArray(o.specs) ? (o.specs as string[]) : [],
      specMetas: parseSpecMetas(o.specMetas),
      note: typeof o.note === "string" ? o.note : undefined,
      parsed: true,
    };
  }
  return { approved: false, specs: [], note: "the agent emitted no parseable verdict", parsed: false };
}

function parseSpecMetas(raw: unknown): SpecMeta[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const metas: SpecMeta[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const file = typeof e.file === "string" ? e.file.trim() : "";
    const flow = typeof e.flow === "string" ? e.flow.trim() : "";
    const objective = typeof e.objective === "string" ? e.objective.trim() : "";
    const targets = Array.isArray(e.targets) ? e.targets.filter((t): t is string => typeof t === "string") : [];
    if (file && flow && objective) {
      metas.push({ file, flow, objective, targets });
    }
  }
  return metas.length > 0 ? metas : undefined;
}
