/*
 * What the consumer's sources, read from the working copy, expect of the answers to requests: the sources and module
 * configurations of the languages the registry declares an expectation syntax for, read once through the confined reader (a mirror is
 * a directory the agent writes into: no link followed, bounded files and bytes), handed to the extractor of their syntax. The suite
 * the engine delivers into the working copy is not the consumer, and neither is a dependency or a build directory (`SKIP_VENDOR_DIRS`, the
 * one the topology resolvers skip) or a test file. What cannot be read
 * is skipped and said once; a language with no extractor, or a repository with no source of one, yields no expectation, never a guess.
 */
import { relative, sep } from "node:path";
import { LanguageRegistry } from "@kernel/language-id.ts";
import { SKIP_VENDOR_DIRS } from "@kernel/vendor-dirs.ts";
import type { ServiceLink } from "@kernel/service-links.ts";
import { RepoReader } from "../../../../shared-infrastructure/repo-reader.ts";
import type { ConsumerExpectationsOf } from "../../domain/consumer-expectation.ts";
import { createTypeScriptExpectations, type ExpectationLink } from "./typescript-expectations.ts";

/* One source, and the sources of one working copy: far beyond any file a person writes, and than any application holds. */
export const MAX_CONSUMER_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_CONSUMER_SOURCES = 6_000;

const CONFIG_NAME = /^(?:ts|js)config(?:\.[\w.-]+)?\.json$/;

/* The links the service-topology resolver made, as the extractor takes them: the HTTP ones that name the function that issues the call. */
function expectationLinks(links: readonly ServiceLink[] | undefined): ExpectationLink[] {
  return (links ?? []).flatMap((link) => (link.transport === "http" && link.operation !== undefined ? [{ file: link.from.file, symbol: link.from.symbol, operation: link.operation }] : []));
}

export function loadConsumerExpectations(opts: { mirrorDir: string; links?: readonly ServiceLink[]; excludeDir?: string }): ConsumerExpectationsOf | undefined {
  const reader = new RepoReader(opts.mirrorDir);
  const excluded = opts.excludeDir === undefined ? undefined : relative(opts.mirrorDir, opts.excludeDir).split(sep).join("/");
  const inExcluded = (rel: string): boolean => excluded !== undefined && excluded !== "" && !excluded.startsWith("..") && (rel === excluded || rel.startsWith(`${excluded}/`));
  const accepted = (name: string, rel: string): boolean => !inExcluded(rel) && (CONFIG_NAME.test(name) || LanguageRegistry.expectationSyntaxFor(name) !== null);
  const files = new Map<string, string>();
  for (const rel of reader.files(accepted, SKIP_VENDOR_DIRS).slice(0, MAX_CONSUMER_SOURCES)) {
    const text = reader.listedText(rel, MAX_CONSUMER_SOURCE_BYTES);
    if (text !== undefined) files.set(rel, text);
  }
  reader.warn("consumer expectations");
  if (![...files.keys()].some((file) => LanguageRegistry.expectationSyntaxFor(file) !== null)) return undefined;
  const isTestFile = (file: string): boolean => LanguageRegistry.isTestFile(file);
  const links = expectationLinks(opts.links);
  const typescript = createTypeScriptExpectations({ files, isTestFile, links });
  return (request) => typescript(request);
}
