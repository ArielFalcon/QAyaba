/* The pages a run observed, from the files the seed's capture left in the failure-capture directory when the run was asked to observe (`observed-*.json`: for each test that ran, the requests its page depended on and the accessible tree it ended on). The directory is the child's, which runs code the agent wrote, so every file is untrusted: the directory is read strictly and all or nothing (a file that cannot be used makes the observations unknown, since a part of a run's pages is no comparison), every request is re-derived as method and origin + pathname, every line is redacted by value and by pattern, and the lists are bounded. Each observation is matched to the case it describes by the same rule the failure dumps use. */
import { relative } from "node:path";
import { parseAriaSnapshotWithState } from "@contexts/generation/application/index.ts";
import { MAX_OBSERVED_DOM_LINES, MAX_OBSERVED_LINE_CHARS, MAX_OBSERVED_REQUESTS, type ObservedPage, type ObservedRequest } from "@contexts/objective-signal/application/index.ts";
import { redactByValue } from "../../../shared-kernel/run-secret-redaction.ts";
import { sanitizeText } from "../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { readRunOutputDir, type RunOutputLimits } from "../../../shared-infrastructure/run-output-reader.ts";

const OBSERVED_FILE_RE = /^observed-[A-Za-z0-9_-]+\.json$/;
export const OBSERVATION_LIMITS: RunOutputLimits = { maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, maxFiles: 4_096 };

/* What one file may hold before it is no observation: the seed keeps MAX_OBSERVED_REQUESTS distinct requests, so a list far past it is forged. */
const MAX_RECORDED_REQUESTS = MAX_OBSERVED_REQUESTS * 4;
const MAX_RECORDED_URL_CHARS = 300;
const MAX_RECORDED_COUNT = 1_000_000;
const METHOD_RE = /^[A-Z]{1,16}$/;

/* One file as read: the identity the capture gives a failure dump (so a case is matched to it by the same rule) and what the page did. */
interface Recorded {
  project: string;
  file?: string;
  title: string;
  retry: number;
  requests: ObservedRequest[];
  dom: string[];
}

const clean = (text: string): string => sanitizeText(redactByValue(text)).text;
const cut = (line: string): string => (line.length > MAX_OBSERVED_LINE_CHARS ? `${line.slice(0, MAX_OBSERVED_LINE_CHARS)}…` : line);

/* One recorded request, or a throw that makes the whole read untrusted. */
function recordedRequest(raw: unknown): ObservedRequest {
  const { method, url, count } = (raw ?? {}) as { method?: unknown; url?: unknown; count?: unknown };
  if (typeof method !== "string" || !METHOD_RE.test(method)) throw new Error("not a method");
  if (typeof url !== "string" || url.length > MAX_RECORDED_URL_CHARS) throw new Error("not a url");
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_RECORDED_COUNT) throw new Error("not a count");
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not a url");
  return { method, url: clean(`${parsed.origin}${parsed.pathname}`), count };
}

/* The requests of one file, equal ones merged (two addresses that differ only by a query are one) and cut at the cap. */
function mergedRequests(list: readonly ObservedRequest[]): ObservedRequest[] {
  const merged: ObservedRequest[] = [];
  for (const r of list) {
    const same = merged.find((m) => m.method === r.method && m.url === r.url);
    if (same) same.count += r.count;
    else merged.push({ ...r });
  }
  return merged.slice(0, MAX_OBSERVED_REQUESTS);
}

function toRecorded(_name: string, bytes: Buffer): Recorded {
  const body = JSON.parse(bytes.toString("utf8")) as { project?: unknown; file?: unknown; title?: unknown; retry?: unknown; requests?: unknown; yaml?: unknown };
  if (typeof body.title !== "string" || (body.file !== undefined && typeof body.file !== "string") || (body.yaml !== undefined && typeof body.yaml !== "string")) throw new Error("not an observation");
  if (!Array.isArray(body.requests) || body.requests.length > MAX_RECORDED_REQUESTS) throw new Error("not a list of requests");
  const lines = parseAriaSnapshotWithState(body.yaml ?? "");
  const dom = lines.nodes.slice(0, MAX_OBSERVED_DOM_LINES).map((node) => {
    const states = lines.states.get(node);
    return cut(clean(states ? `${node} [${states.join(", ")}]` : node));
  });
  return {
    project: typeof body.project === "string" ? body.project : "",
    ...(typeof body.file === "string" ? { file: body.file } : {}),
    title: body.title,
    retry: typeof body.retry === "number" && Number.isInteger(body.retry) ? body.retry : 0,
    requests: mergedRequests(body.requests.map(recordedRequest)),
    dom,
  };
}

/*
 * The page each of `caseNames` ended on, in the order of the cases, from the observation files in `dir`; undefined when the files cannot
 * all be used (never a part of them). A case no file describes has no page, and a file no case matches describes nothing.
 * `match` is the rule that ties a file's title to a case's name.
 */
export function readObservations(
  dir: string,
  root: string,
  caseNames: readonly string[],
  match: (caseName: string, dumps: Recorded[]) => Recorded[],
): ObservedPage[] | undefined {
  const files = readRunOutputDir({ mirrorDir: root, specDir: root }, relative(root, dir) || ".", (name) => OBSERVED_FILE_RE.test(name), toRecorded, OBSERVATION_LIMITS);
  if (files === undefined) return undefined;
  const pages: ObservedPage[] = [];
  for (const name of caseNames) {
    const found = match(name, files)[0];
    if (found) pages.push({ name, requests: found.requests, dom: found.dom });
  }
  return pages;
}
