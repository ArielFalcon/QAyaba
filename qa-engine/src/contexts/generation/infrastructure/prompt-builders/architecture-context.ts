/* The FE-BE architecture map as a prompt section: bounded, and every field sanitized because the map is read from the watched repo. Never import src/. */

import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { itemId } from "@kernel/context-item-ids.ts";
import type { Omission } from "@kernel/telemetry/section-meta.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { claim, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { ArchitectureContext } from "../../domain/generation-input.ts";

/** context.json is read from the WATCHED repo (and committed by this system's own PRs), so it is attacker-influenceable. Every field is sanitized before it reaches the test-writing agent (prompt-injection / secret-exfil defense), and the map is BOUNDED so a huge file cannot blow the token budget. `s()` redacts; MAX_ITEMS caps each section. */
export function renderArchitectureContext(
  ctx: ArchitectureContext,
  changedFiles?: string[],
  opts: { suppressApiOperations?: boolean } = {},
): string | null {
  return renderArchitectureContextParts(ctx, changedFiles, opts)?.text ?? null;
}

/** The rendered map plus the claims its content makes: the map itself, its API operations and its FE↔BE links when they were rendered, and the grounding ids the delivered span records. */
export function renderArchitectureContextParts(
  ctx: ArchitectureContext,
  changedFiles?: string[],
  opts: { suppressApiOperations?: boolean } = {},
): { text: string; claims: PromptClaim[]; itemIds: string[]; omissions: Omission[] } | null {
  if (!ctx.routes?.length && !ctx.api?.length) return null;

  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const MAX_ITEMS = 200;
  const MAX_LEN = 20_000;

  const fullFeBe = changedFiles?.length
    ? ctx.feBe?.filter((link) => {
        const terms = [link.route, link.via ?? "", link.operationId].filter((t) => t && t.length >= 3);
        return changedFiles.some((f) => terms.some((t) => f.includes(t)));
      }) ?? ctx.feBe ?? []
    : ctx.feBe ?? [];
  const relevantLinks = fullFeBe.slice(0, MAX_ITEMS);

  const lines: string[] = [];
  lines.push(`## ${PROMPT_HEADINGS.architectureContext} (from e2e/.qa/context.json)`);
  lines.push(`Built at ${s(ctx.builtAtSha).slice(0, 7)} — the FE↔BE map this app's QA uses to cross the frontend→backend boundary.`);
  lines.push("This map was extracted from source and may be stale or incomplete.");
  lines.push("");

  if (ctx.routes.length) {
    lines.push(`### Routes (${ctx.routes.length} entry points)`);
    for (const r of ctx.routes.slice(0, MAX_ITEMS)) {
      lines.push(`- \`${s(r.path)}\` → ${s(r.component ?? "(unknown component)")}${r.name ? ` ("${s(r.name)}")` : ""}`);
    }
    lines.push("");
  }

  const listsApiOperations = ctx.api.length > 0 && !opts.suppressApiOperations;
  if (listsApiOperations) {
    lines.push(`### API operations (${ctx.api.length} endpoints)`);
    for (const o of ctx.api.slice(0, MAX_ITEMS)) {
      lines.push(`- \`${s(o.operationId)}\`: ${s(o.method)} ${s(o.path)}${o.service ? ` (${s(o.service)})` : ""}`);
    }
    lines.push("");
  }

  if (relevantLinks.length) {
    lines.push(`### FE↔BE links (${relevantLinks.length} of ${ctx.feBe?.length ?? 0} total)`);
    lines.push("Each link tells you which frontend route calls which backend operation — use this to widen the blast radius:");
    for (const l of relevantLinks) {
      lines.push(`- Route \`${s(l.route)}\` → \`${s(l.operationId)}\`${l.via ? ` (via ${s(l.via)})` : ""}`);
    }
    lines.push("");
  }

  if (ctx.flows?.length) {
    lines.push("### Named flows");
    for (const f of ctx.flows.slice(0, MAX_ITEMS)) {
      const opList = f.operations?.length ? ` → ${f.operations.slice(0, MAX_ITEMS).map(s).join(", ")}` : "";
      lines.push(`- **${s(f.id)}**: ${f.routes.slice(0, MAX_ITEMS).map(s).join(", ")}${opList}`);
    }
    lines.push("");
  }

  const out = lines.join("\n");
  const claims: PromptClaim[] = [claim.provides("arch-map"), claim.frames("arch-map", "unverified")];
  if (listsApiOperations) claims.push(claim.provides("api-operations"));
  if (relevantLinks.length) claims.push(claim.provides("fe-be-links"));
  /* The ids of what the rendered map supplies, in the map's own order. A map truncated past MAX_LEN delivers none of them (conservative). */
  const truncated = out.length > MAX_LEN;
  const itemIds = truncated
    ? []
    : [
        ...ctx.routes.slice(0, MAX_ITEMS).map((r) => itemId.route(r.path)),
        ...(listsApiOperations ? ctx.api.slice(0, MAX_ITEMS).map((o) => itemId.op(o.operationId)) : []),
        ...relevantLinks.map((l) => itemId.link(l.route, l.operationId)),
        ...(ctx.flows?.length ? ctx.flows.slice(0, MAX_ITEMS).map((f) => itemId.flow(f.id)) : []),
      ];
  /* The entries each rendered list left out to MAX_ITEMS, and only those: a list the caller suppressed (API operations) was never rendered, so its cap is not an omission, and a list under the cap omits nothing. */
  const mapCapOmitted =
    Math.max(0, ctx.routes.length - MAX_ITEMS)
    + (listsApiOperations ? Math.max(0, ctx.api.length - MAX_ITEMS) : 0)
    + (fullFeBe.length > 0 ? Math.max(0, fullFeBe.length - MAX_ITEMS) : 0)
    + (ctx.flows?.length ? Math.max(0, ctx.flows.length - MAX_ITEMS) : 0);
  const omissions: Omission[] = mapCapOmitted > 0 ? [{ class: "truncation", reason: "map-cap", count: mapCapOmitted }] : [];
  return { text: truncated ? out.slice(0, MAX_LEN) + "\n…(context truncated)" : out, claims, itemIds, omissions };
}
