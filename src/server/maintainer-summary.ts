/* Parsing + validation of the qa-maintainer closing summary — gates whether a self-fix may merge. */

export interface MaintainerJustification {
  rootCause: string;
  whyNecessary: string;
  whyMinimal: string;
}

export interface MaintainerSummary {
  fixed: boolean;
  changes: string[];
  prTitle?: string;
  justification?: MaintainerJustification;
}

/* All three arguments must be present and non-trivial before a self-merge/hot-swap. */
export function validJustification(j: unknown): MaintainerJustification | undefined {
  if (!j || typeof j !== "object") return undefined;
  const o = j as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === "string" && v.trim().length >= 10;
  if (ok(o.rootCause) && ok(o.whyNecessary) && ok(o.whyMinimal)) {
    return { rootCause: o.rootCause, whyNecessary: o.whyNecessary, whyMinimal: o.whyMinimal };
  }
  return undefined;
}

export function parseMaintainerSummary(text: string): MaintainerSummary {
  const start = text.indexOf("<!--MAINTAINER_SUMMARY");
  if (start === -1) return { fixed: false, changes: [] };
  const end = text.indexOf("END_MAINTAINER_SUMMARY-->", start);
  if (end === -1) return { fixed: false, changes: [] };

  try {
    const json = JSON.parse(text.slice(start + "<!--MAINTAINER_SUMMARY".length, end).trim());
    return {
      fixed: json.fixed === true,
      changes: Array.isArray(json.changes) ? json.changes : [],
      prTitle: typeof json.prTitle === "string" ? json.prTitle : undefined,
      justification: validJustification(json.justification),
    };
  } catch {
    return { fixed: false, changes: [] };
  }
}
