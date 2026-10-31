import type { CallSiteRef } from "../domain/index.ts";

const VERB_ALTERNATION = "get|post|put|patch|delete";

/** A single call-site occurrence found in file text. */
export interface CallSiteOccurrence {
  index: number;
  verb: string;
  rawArg: string;
}

/** Extracts call-sites of one shape from file text, guided by the config-supplied ref. */
export type CallSiteExtractor = (fileText: string, ref: CallSiteRef) => CallSiteOccurrence[];

/** Escape regex metacharacters so a config-supplied receiver is matched literally. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** receiver-verb-call: `{receiver}.{verb}(arg, ...)`, tolerating whitespace/newlines around the dot (multiline chains) and an optional generic type argument (`.get<T>(...)`). */
const receiverVerbCall: CallSiteExtractor = (fileText, ref) => {
  if (!ref.receiver) return [];
  const receiverPattern = escapeRegExp(ref.receiver);
  const re = new RegExp(
    `${receiverPattern}\\s*\\.\\s*(${VERB_ALTERNATION})\\s*(?:<[^>]*>)?\\(\\s*([^,)\\n]+)`,
    "g",
  );
  const sites: CallSiteOccurrence[] = [];
  for (let m; (m = re.exec(fileText)) !== null;) {
    const verb = m[1];
    const rawArg = m[2];
    if (!verb || !rawArg) continue;
    sites.push({ index: m.index, verb, rawArg: rawArg.trim() });
  }
  return sites;
};

/** In-core registry of call-site shapes, keyed by `CallSiteRef.kind`. */
export const CallSiteCatalog: Record<string, CallSiteExtractor> = {
  "receiver-verb-call": receiverVerbCall,
};

/** The call-site shape kinds the core can extract (the keys of CallSiteCatalog). A profile whose `frontCallSite.kind` is not here cannot be resolved, so config validation rejects it up front (loud, at load time) instead of letting it degrade to zero extracted call-sites downstream. */
export const KNOWN_CALL_SITE_KINDS: ReadonlySet<string> = new Set(Object.keys(CallSiteCatalog));
