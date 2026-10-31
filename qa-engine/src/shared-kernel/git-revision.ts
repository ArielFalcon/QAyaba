/*
 * The one place a revision that did not originate in the orchestrator's own code is judged before it becomes a git argument.
 *
 * A commit sha, a branch or a ref reaches git as a positional argument, and git reads a positional argument that starts with a
 * dash as an option (`--output=<path>` writes a file, `--upload-pack=<command>` runs one). Anything an agent wrote (a context
 * map's `builtAtSha`), a stored record, a webhook or API payload or a repository's own configuration is untrusted until it
 * passes here. A value that passes can never be read as an option, so the callers need no `--end-of-options` of their own.
 */

/* An abbreviated or full SHA-1 commit id. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_SHA.test(value);
}

export function assertCommitSha(value: unknown): asserts value is string {
  if (!isCommitSha(value)) throw new Error(`invalid commit sha (must be 7–40 hex chars): ${JSON.stringify(value)}`);
}

/* Characters git refuses anywhere in a ref name (git check-ref-format): control characters, space, ~ ^ : ? * [ and backslash. */
// eslint-disable-next-line no-control-regex
const REF_FORBIDDEN_CHARS = /[\u0000- \u007f~^:?*[\\]/;

/*
 * A branch, tag or full ref name: what `git check-ref-format refs/heads/<name>` accepts, and never a name that starts with a
 * dash. The dash rule is the one git itself does not make: `-x` is a valid ref name and an option.
 */
export function isRefName(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.startsWith("-")) return false;
  if (REF_FORBIDDEN_CHARS.test(value) || value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  return value.split("/").every((component) => !component.startsWith(".") && !component.endsWith(".lock"));
}

export function assertRefName(value: unknown, what = "ref name"): asserts value is string {
  if (!isRefName(value)) throw new Error(`invalid ${what}: ${JSON.stringify(value)}`);
}
