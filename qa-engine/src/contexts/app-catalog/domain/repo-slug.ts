/*
 * The one rule for a repository an app names: one or more parts joined by `/` (`<owner>/<name>` on GitHub), each starting with a
 * letter or digit and holding only letters, digits, `.`, `_` and `-`. The value becomes a remote URL, a mirror directory and a
 * staged directory, so a part that is `.` or `..`, an empty part or a leading dash would name another place or reach git as an
 * option.
 */
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function isRepoSlug(value: unknown): value is string {
  return typeof value === "string" && REPO_SLUG.test(value);
}
