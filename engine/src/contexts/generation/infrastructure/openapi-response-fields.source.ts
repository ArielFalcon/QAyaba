/*
 * The field names the app's own OpenAPI documents declare anywhere in an operation's response, read from the working copy: the documents its
 * `openapi` hint names (globs, as the app config declares them), or, with no hint, files named like one (`openapi*`, `swagger*`,
 * `api-definition*`, yaml or json). They are read once through the confined reader (a mirror is a directory the agent writes into:
 * no link followed, bounded files and bytes), parsed, and consulted per response. What cannot be read or parsed is skipped and said
 * once; the lookup is then silent for what it cannot answer. Used to classify an expectation gap by what the provider's contract
 * says of the field (`findExpectationGaps`), never to decide one.
 */
import { matchesGlob } from "node:path";
import { parse as parseYaml } from "yaml";
import { RepoReader } from "../../../shared-infrastructure/repo-reader.ts";
import { responseFieldNames } from "@contexts/service-topology/application/index.ts";
import type { ResponseFieldsOf } from "../domain/expectation-gaps.ts";

/* One OpenAPI document, and the documents of one working copy: far beyond what a person writes by hand, and than any repository holds. */
export const MAX_OPENAPI_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_OPENAPI_DOCUMENTS = 20;

const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "build", "target", ".next", ".cache"]);
const DEFAULT_DOCUMENT_NAME = /^(openapi|swagger|api-definition).*\.(ya?ml|json)$/i;

/* The lookup over documents already read and parsed (the provider's, as the link resolver read them); undefined when there is none. */
export function responseFieldsOfDocuments(documents: readonly unknown[]): ResponseFieldsOf | undefined {
  if (documents.length === 0) return undefined;
  return (method, url) => {
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      return undefined;
    }
    for (const document of documents) {
      const fields = responseFieldNames(document, method, path);
      if (fields !== undefined) return fields;
    }
    return undefined;
  };
}

/* The first of the lookups that knows the operation answers; undefined when there is none. */
export function firstResponseFields(...lookups: Array<ResponseFieldsOf | undefined>): ResponseFieldsOf | undefined {
  const present = lookups.filter((lookup): lookup is ResponseFieldsOf => lookup !== undefined);
  if (present.length === 0) return undefined;
  return (method, url) => {
    for (const lookup of present) {
      const fields = lookup(method, url);
      if (fields !== undefined) return fields;
    }
    return undefined;
  };
}

export function loadResponseFields(opts: { mirrorDir: string; openapi?: string | string[] }): ResponseFieldsOf | undefined {
  const hints = opts.openapi === undefined ? [] : Array.isArray(opts.openapi) ? opts.openapi : [opts.openapi];
  const reader = new RepoReader(opts.mirrorDir);
  const accepted = (name: string, rel: string): boolean => (hints.length > 0 ? hints.some((glob) => matchesGlob(rel, glob)) : DEFAULT_DOCUMENT_NAME.test(name));
  const documents: unknown[] = [];
  for (const rel of reader.files(accepted, SKIP_DIRS).slice(0, MAX_OPENAPI_DOCUMENTS)) {
    const text = reader.optionalText(rel, MAX_OPENAPI_DOCUMENT_BYTES);
    if (text === undefined) continue;
    try {
      documents.push(parseYaml(text));
    } catch {
      /* a document that does not parse declares nothing; its text is never quoted */
    }
  }
  reader.warn("OpenAPI response schemas");
  return responseFieldsOfDocuments(documents);
}
