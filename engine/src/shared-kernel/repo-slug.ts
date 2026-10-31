/*
 * The one rule for a repository an app names: one or more parts joined by `/` (`<owner>/<name>` on GitHub), each of letters,
 * digits, `.`, `_` and `-`, as GitHub names allow. The value becomes a remote URL, a mirror directory and a staged directory, so
 * a part that is `.` or `..`, an empty part or a part starting with a dash, which would name another place or reach git as an
 * option, is refused.
 */
const REPO_PART = /^[A-Za-z0-9._-]+$/;

export function isRepoSlug(value: unknown): value is string {
  return typeof value === "string" && value.split("/").every((part) => REPO_PART.test(part) && part !== "." && part !== ".." && !part.startsWith("-"));
}

export function assertRepoSlug(value: unknown): asserts value is string {
  if (!isRepoSlug(value)) throw new Error(`invalid repo (parts joined by '/', none of them . or .. or starting with a dash): ${JSON.stringify(value)}`);
}
