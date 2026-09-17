import type { CallPatternRef } from "../domain/index.ts";

/** A single BE→BE HTTP call occurrence found in file text. */
export interface CallPatternOccurrence {
  index: number;
  verb: string;
  rawArg: string;
  enclosingClass: string | null;
  enclosingMethod: string | null;
}

/** Extracts call-pattern occurrences from file text, guided by the config-supplied ref. */
export type CallPatternExtractor = (fileText: string, ref: CallPatternRef) => CallPatternOccurrence[];

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CLASS_DECL_RE = /\b(?:class|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const JAVA_METHOD_DECL_RE =
  /\b(?:public|protected|private|static|final|synchronized|native|abstract|default|strictfp|\s)*[\w.<>,\[\]?]+\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;{}]*\)\s*\{/g;
const JAVA_METHOD_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "throw", "synchronized",
]);

function findEnclosingClass(text: string, matchIndex: number): string | null {
  let depth = 0;
  let openBraceIndex = -1;
  for (let i = matchIndex - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        openBraceIndex = i;
        break;
      }
      depth--;
    }
  }
  if (openBraceIndex === -1) return null;
  const before = text.slice(0, openBraceIndex);
  let lastName: string | null = null;
  CLASS_DECL_RE.lastIndex = 0;
  for (let m; (m = CLASS_DECL_RE.exec(before)) !== null;) {
    const name = m[1];
    if (name) lastName = name;
  }
  return lastName;
}

function findEnclosingMethod(text: string, matchIndex: number): string | null {
  const slice = text.slice(0, matchIndex);
  let lastName: string | null = null;
  JAVA_METHOD_DECL_RE.lastIndex = 0;
  for (let m; (m = JAVA_METHOD_DECL_RE.exec(slice)) !== null;) {
    const name = m[1];
    if (name && !JAVA_METHOD_KEYWORDS.has(name)) lastName = name;
  }
  return lastName;
}

function withEnclosing(text: string, index: number, verb: string, rawArg: string): CallPatternOccurrence {
  return {
    index,
    verb: verb.toLowerCase(),
    rawArg: rawArg.trim(),
    enclosingClass: findEnclosingClass(text, index),
    enclosingMethod: findEnclosingMethod(text, index),
  };
}

function receiverDot(ref: CallPatternRef): string {
  if (!ref.receiver) return "(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)";
  return `${escapeRegExp(ref.receiver)}\\s*\\.\\s*`;
}

const SHORTCUT_VERB: Record<string, string> = {
  getForObject: "get",
  getForEntity: "get",
  postForObject: "post",
  postForEntity: "post",
  putForObject: "put",
  delete: "delete",
};

const restTemplateExchange: CallPatternExtractor = (fileText, ref) => {
  const recv = receiverDot(ref);
  const sites: CallPatternOccurrence[] = [];
  const exchangeRe = new RegExp(
    `${recv}exchange\\s*\\(\\s*([^,\\n]+)\\s*,\\s*HttpMethod\\s*\\.\\s*(GET|POST|PUT|PATCH|DELETE)`,
    "g",
  );
  for (let m; (m = exchangeRe.exec(fileText)) !== null;) {
    const rawArg = m[1];
    const verb = m[2];
    if (!rawArg || !verb) continue;
    sites.push(withEnclosing(fileText, m.index, verb, rawArg));
  }
  const shortcutRe = new RegExp(
    `${recv}(getForObject|postForObject|putForObject|getForEntity|postForEntity|delete)\\s*\\(\\s*([^,\\n]+)`,
    "g",
  );
  for (let m; (m = shortcutRe.exec(fileText)) !== null;) {
    const method = m[1];
    const rawArg = m[2];
    if (!method || !rawArg) continue;
    const verb = SHORTCUT_VERB[method];
    if (!verb) continue;
    sites.push(withEnclosing(fileText, m.index, verb, rawArg));
  }
  sites.sort((a, b) => a.index - b.index);
  return sites;
};

function findClassBodyRange(text: string, searchFrom: number): { start: number; end: number } | null {
  const openIdx = text.indexOf("{", searchFrom);
  if (openIdx === -1) return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start: openIdx + 1, end: i };
    }
  }
  return null;
}

function methodNameAfter(body: string, from: number): string | null {
  const slice = body.slice(from, from + 500).replace(/@\w+(?:\s*\([^)]*\))?/g, " ");
  const m = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(slice);
  const name = m?.[1];
  if (!name) return null;
  if (JAVA_METHOD_KEYWORDS.has(name) || name === "RequestMethod") return null;
  return name;
}

function mappingPath(args: string): string | null {
  const named = /(?:path|value)\s*=\s*(["'])([^"']+)\1/.exec(args);
  if (named?.[2]) return named[2];
  const positional = /^\s*(["'])([^"']+)\1/.exec(args);
  return positional?.[2] ?? null;
}

const feignClient: CallPatternExtractor = (fileText, ref) => {
  void ref;
  const sites: CallPatternOccurrence[] = [];
  const headerRe =
    /@FeignClient\b(?:\([^)]*\))?\s*(?:public\s+|protected\s+|private\s+)*(?:interface|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (let hm; (hm = headerRe.exec(fileText)) !== null;) {
    const className = hm[1];
    if (!className) continue;
    const body = findClassBodyRange(fileText, headerRe.lastIndex);
    if (!body) continue;
    const bodyText = fileText.slice(body.start, body.end);
    const verbMappingRe = /@(Get|Post|Put|Patch|Delete)Mapping\b(?:\s*\(([^)]*)\))?/g;
    for (let mm; (mm = verbMappingRe.exec(bodyText)) !== null;) {
      const verb = mm[1];
      const args = mm[2] ?? "";
      if (!verb) continue;
      const path = mappingPath(args);
      if (!path) continue;
      const methodName = methodNameAfter(bodyText, mm.index + mm[0].length);
      sites.push({
        index: body.start + mm.index,
        verb: verb.toLowerCase(),
        rawArg: `"${path}"`,
        enclosingClass: className,
        enclosingMethod: methodName,
      });
    }
    const requestRe = /@RequestMapping\s*\(([^)]*)\)/g;
    for (let rm; (rm = requestRe.exec(bodyText)) !== null;) {
      const args = rm[1] ?? "";
      const methodMatch = /method\s*=\s*RequestMethod\s*\.\s*(GET|POST|PUT|PATCH|DELETE)/.exec(args);
      const path = mappingPath(args);
      if (!methodMatch?.[1] || !path) continue;
      const methodName = methodNameAfter(bodyText, rm.index + rm[0].length);
      sites.push({
        index: body.start + rm.index,
        verb: methodMatch[1].toLowerCase(),
        rawArg: `"${path}"`,
        enclosingClass: className,
        enclosingMethod: methodName,
      });
    }
  }
  sites.sort((a, b) => a.index - b.index);
  return sites;
};

const webClient: CallPatternExtractor = (fileText, ref) => {
  const recv = receiverDot(ref);
  const re = new RegExp(
    `${recv}(get|post|put|patch|delete)\\s*\\(\\s*\\)\\s*\\.\\s*uri\\s*\\(\\s*([^)\\n]+)`,
    "g",
  );
  const sites: CallPatternOccurrence[] = [];
  for (let m; (m = re.exec(fileText)) !== null;) {
    const verb = m[1];
    const rawArg = m[2];
    if (!verb || !rawArg) continue;
    sites.push(withEnclosing(fileText, m.index, verb, rawArg));
  }
  return sites;
};

/** In-core registry of BE→BE HTTP call-pattern shapes, keyed by `CallPatternRef.kind`. */
export const CallPatternCatalog: Record<string, CallPatternExtractor> = {
  "rest-template-exchange": restTemplateExchange,
  "feign-client": feignClient,
  "web-client": webClient,
};

/** The call-pattern shape kinds the core can extract. A profile whose `callPattern.kind` is
 *  not here cannot be resolved, so config validation rejects it up front (loud, at load time)
 *  instead of letting it degrade to zero extracted calls downstream. */
export const KNOWN_CALL_PATTERN_KINDS: ReadonlySet<string> = new Set(Object.keys(CallPatternCatalog));
