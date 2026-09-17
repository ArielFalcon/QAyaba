/* Reads `boundaries[]` from app YAML into BoundaryProfile[]. App-specific patterns are config strings, never literals in engine core. The reader is injected — this module never touches the filesystem. Per-entry validation is fail-closed (warn + skip). Malformed YAML, a non-array `boundaries`, or a throwing reader degrade to [] (fail-open). */
import { parse as parseYaml } from "yaml";
import type { BoundaryProfileProviderPort } from "../application/ports/index.ts";
import type {
  BoundaryProfile, HttpBoundaryProfile, EventBoundaryProfile, HttpBackendBoundaryProfile,
  CallSiteRef, EventPatternRef, CallPatternRef,
} from "../domain/index.ts";
import { KNOWN_CALL_SITE_KINDS } from "./call-site-catalog.ts";
import { KNOWN_EVENT_PATTERN_KINDS } from "./event-pattern-catalog.ts";
import { KNOWN_CALL_PATTERN_KINDS } from "./call-pattern-catalog.ts";

const REQUIRED_HTTP_STRING_FIELDS = [
  "frontFiles",
  "servicePrefixTemplate",
  "serviceRepoTemplate",
  "openApiPath",
] as const;

const REQUIRED_EVENT_PATTERN_STRING_FIELDS = [
  "listenerBaseType",
  "listenerEventCall",
  "subscriberBaseType",
  "publishCall",
] as const;

const REQUIRED_HTTP_BACKEND_STRING_FIELDS = [
  "sourceFiles",
  "servicePrefixTemplate",
  "serviceRepoTemplate",
  "openApiPath",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a single raw `boundaries[]` entry into an HttpBoundaryProfile, or null if it does not structurally conform. Pure — no I/O, no logging — so the caller can decide how to report the reason (adapter warns with app + index context). */
export function parseHttpBoundaryProfile(raw: unknown): HttpBoundaryProfile | null {
  if (!isRecord(raw)) return null;
  if (raw["transport"] !== "http") return null;

  for (const field of REQUIRED_HTTP_STRING_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || value.trim().length === 0) return null;
  }

  const rawCallSite = raw["frontCallSite"];
  if (!isRecord(rawCallSite) || typeof rawCallSite["kind"] !== "string") return null;
  if (!KNOWN_CALL_SITE_KINDS.has(rawCallSite["kind"])) return null;
  const frontCallSite: CallSiteRef = { kind: rawCallSite["kind"] };
  if (typeof rawCallSite["receiver"] === "string") frontCallSite.receiver = rawCallSite["receiver"];

  return {
    transport: "http",
    frontFiles: raw["frontFiles"] as string,
    frontCallSite,
    servicePrefixTemplate: raw["servicePrefixTemplate"] as string,
    serviceRepoTemplate: raw["serviceRepoTemplate"] as string,
    openApiPath: raw["openApiPath"] as string,
  };
}

/** Validate a single raw `boundaries[]` entry into an EventBoundaryProfile, or null if it does not structurally conform. Pure — no I/O, no logging — mirrors parseHttpBoundaryProfile's validation style exactly (isRecord guard, required-string-field rejection with blank-string rejection, plus an eventPattern.kind check against the in-core catalog). */
export function parseEventBoundaryProfile(raw: unknown): EventBoundaryProfile | null {
  if (!isRecord(raw)) return null;
  if (raw["transport"] !== "event") return null;

  const files = raw["files"];
  if (typeof files !== "string" || files.trim().length === 0) return null;

  const rawPattern = raw["eventPattern"];
  if (!isRecord(rawPattern)) return null;
  if (typeof rawPattern["kind"] !== "string") return null;
  if (!KNOWN_EVENT_PATTERN_KINDS.has(rawPattern["kind"])) return null;

  for (const field of REQUIRED_EVENT_PATTERN_STRING_FIELDS) {
    const value = rawPattern[field];
    if (typeof value !== "string" || value.trim().length === 0) return null;
  }

  const eventPattern: EventPatternRef = {
    kind: rawPattern["kind"],
    listenerBaseType: rawPattern["listenerBaseType"] as string,
    listenerEventCall: rawPattern["listenerEventCall"] as string,
    subscriberBaseType: rawPattern["subscriberBaseType"] as string,
    publishCall: rawPattern["publishCall"] as string,
  };

  return { transport: "event", files, eventPattern };
}

/** Validate a single raw `boundaries[]` entry into an HttpBackendBoundaryProfile, or null if it does not structurally conform. Pure — no I/O, no logging. Unknown callPattern.kind is rejected at load time so it cannot silently extract zero calls downstream. */
export function parseHttpBackendBoundaryProfile(raw: unknown): HttpBackendBoundaryProfile | null {
  if (!isRecord(raw)) return null;
  if (raw["transport"] !== "http-backend") return null;

  for (const field of REQUIRED_HTTP_BACKEND_STRING_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || value.trim().length === 0) return null;
  }

  const rawPattern = raw["callPattern"];
  if (!isRecord(rawPattern) || typeof rawPattern["kind"] !== "string") return null;
  if (!KNOWN_CALL_PATTERN_KINDS.has(rawPattern["kind"])) return null;
  const callPattern: CallPatternRef = { kind: rawPattern["kind"] };
  if (typeof rawPattern["receiver"] === "string") callPattern.receiver = rawPattern["receiver"];

  return {
    transport: "http-backend",
    sourceFiles: raw["sourceFiles"] as string,
    callPattern,
    servicePrefixTemplate: raw["servicePrefixTemplate"] as string,
    serviceRepoTemplate: raw["serviceRepoTemplate"] as string,
    openApiPath: raw["openApiPath"] as string,
  };
}

/** Dispatch a single raw `boundaries[]` entry to the parser matching its `transport` field. Returns null for an entry whose transport is missing/unrecognized OR whose recognized parser rejects it — the caller (forApp) cannot distinguish "unknown transport" from "malformed known transport" from this return value alone, which is intentional: both cases warn+skip identically (mirrors the pre-dispatch behavior for http-only entries). */
function parseBoundaryProfile(raw: unknown): BoundaryProfile | null {
  if (!isRecord(raw)) return null;
  switch (raw["transport"]) {
    case "http":
      return parseHttpBoundaryProfile(raw);
    case "event":
      return parseEventBoundaryProfile(raw);
    case "http-backend":
      return parseHttpBackendBoundaryProfile(raw);
    default:
      return null;
  }
}

export class YamlBoundaryProfileAdapter implements BoundaryProfileProviderPort {
  constructor(private readonly readAppYaml: (appName: string) => string) {}

  async forApp(appName: string): Promise<BoundaryProfile[]> {
    let content: string;
    try {
      content = this.readAppYaml(appName);
    } catch (err) {
      console.warn(
        `[YamlBoundaryProfileAdapter] failed to read config for app "${appName}":`,
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }

    let doc: unknown;
    try {
      doc = parseYaml(content);
    } catch (err) {
      console.warn(
        `[YamlBoundaryProfileAdapter] failed to parse YAML for app "${appName}":`,
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }

    if (!isRecord(doc)) return []; /* malformed document root — fail-open */
    const rawBoundaries = doc["boundaries"];
    if (rawBoundaries === undefined) return [];
    if (!Array.isArray(rawBoundaries)) {
      console.warn(`[YamlBoundaryProfileAdapter] app "${appName}": "boundaries" is not an array — ignoring`);
      return [];
    }

    const profiles: BoundaryProfile[] = [];
    rawBoundaries.forEach((entry, index) => {
      const profile = parseBoundaryProfile(entry);
      if (profile === null) {
        console.warn(
          `[YamlBoundaryProfileAdapter] app "${appName}": boundaries[${index}] is malformed or declares an unsupported transport — skipping`,
        );
        return;
      }
      profiles.push(profile);
    });
    return profiles;
  }
}
