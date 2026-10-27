/*
 * The relevance class of a changed path, from its name alone: the code of a declared language (the language registry decides),
 * other kinds the change may still need (templates, data), style sheets, generated files (lockfiles, build output, maps,
 * snapshots) and files whose diff says little (binaries, changelogs). Pure. Project-agnostic: the only language fact is the
 * registry's.
 */
import { LanguageRegistry } from "./language-id.ts";

export type FileClass = "code" | "other" | "style" | "generated" | "low-relevance";

/* Most relevant first: the order a prompt shows changed files in. */
export const FILE_CLASS_ORDER: readonly FileClass[] = ["code", "other", "style", "generated", "low-relevance"];

const GENERATED_PATTERNS = [
  /^(package-lock|yarn\.lock|pnpm-lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock|poetry\.lock|Gemfile\.lock)$/i,
  /\.(generated|gen|pb|pb\.go|pb_grpc\.go|swagger\.json|openapi\.json|openapi\.yaml)$/i,
  /\bgenerated?\b/i,
  /\.snap$/i,
  /\/(dist|build|\.cache|__pycache__|\.next|\.nuxt|\.out|target)\/[^/]+\.(js|css|map|ts)$/i,
  /\.map$/i,
];

const LOW_RELEVANCE_PATTERNS = [
  /\.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|pdf|zip|tar|gz)$/i,
  /^(CHANGELOG|CHANGES|HISTORY)\.(md|txt)$/i,
];

/* A style sheet changes how a page looks; the code beside it decides what the page does. */
const STYLE_SHEET = /\.(css|scss|sass|less|styl)$/i;

function matchesAny(patterns: readonly RegExp[], filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? filePath;
  return patterns.some((p) => p.test(filePath) || p.test(basename));
}

/* npm's lockfiles carry an extension the generic lockfile pattern above does not match. They are generated for a slice (never owned); the prompt-cap's relevance groups keep their original membership. */
const NPM_LOCKFILES = /^(package-lock|npm-shrinkwrap)\.json$/;

/* Whether the file is one whose diff is rarely worth reading: generated or low-relevance. */
export function isLowRelevance(filePath: string): boolean {
  return matchesAny(GENERATED_PATTERNS, filePath) || matchesAny(LOW_RELEVANCE_PATTERNS, filePath);
}

export function classifyPath(filePath: string): FileClass {
  if (matchesAny(GENERATED_PATTERNS, filePath) || matchesAny([NPM_LOCKFILES], filePath)) return "generated";
  if (matchesAny(LOW_RELEVANCE_PATTERNS, filePath)) return "low-relevance";
  if (STYLE_SHEET.test(filePath)) return "style";
  return LanguageRegistry.languageForFile(filePath) !== null ? "code" : "other";
}

/* Whether the file is a style sheet. */
export function isStyleSheet(filePath: string): boolean {
  return STYLE_SHEET.test(filePath);
}
