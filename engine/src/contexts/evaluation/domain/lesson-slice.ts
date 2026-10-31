/*
 * What one run records for the lesson cycle (docs/architecture/rfc/0013-learning-slice.md, section 6): the commit it measured, the pages of the
 * lessons its briefs stated, its data-state failures by page and, for each delivered spec that went green, the pages its flow was given and the
 * `run_spec` calls it took. The cycle compares two runs over the pages the learning run's lessons cover, so the figures stay per page here and are
 * summed only by the comparison. Carried by the categorical score `lesson_slice` (a JSON text), the one channel the campaign report reads.
 */

export const LESSON_SLICE_SCORE = "lesson_slice";

export interface LessonSlice {
  /* The commit the run measured: runs are paired by it. */
  commit: string;
  /* The pages (pathnames, or templates of the map) of the lessons the run's briefs stated; empty for a run that was told none. */
  scopes: string[];
  /* The data-state failures by page; null when the run measured none. */
  failures: Array<{ path: string; count: number }> | null;
  /* Each delivered spec that went green: the pages its flow was given and the `run_spec` calls up to and including its first pass. */
  specs: Array<{ routes: string[]; calls: number }>;
}

export function encodeLessonSlice(slice: LessonSlice): string {
  return JSON.stringify({ v: 1, commit: slice.commit, scopes: slice.scopes, failures: slice.failures, specs: slice.specs });
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/* The slice a score carries, or undefined for a value that is not one (an older grader version, a score of another shape). */
export function decodeLessonSlice(value: unknown): LessonSlice | undefined {
  if (typeof value !== "string") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.commit !== "string" || !isStrings(o.scopes) || !Array.isArray(o.specs)) return undefined;
  const failures = o.failures === null ? null : Array.isArray(o.failures) && o.failures.every((f) => f !== null && typeof f === "object" && typeof (f as { path?: unknown }).path === "string" && isCount((f as { count?: unknown }).count)) ? (o.failures as Array<{ path: string; count: number }>) : undefined;
  if (failures === undefined) return undefined;
  const specs = o.specs as unknown[];
  if (!specs.every((s) => s !== null && typeof s === "object" && isStrings((s as { routes?: unknown }).routes) && isCount((s as { calls?: unknown }).calls))) return undefined;
  return { commit: o.commit, scopes: o.scopes, failures, specs: specs as LessonSlice["specs"] };
}

/* A segment that stands for any one value of a page's address, in the three spellings route templates use. */
const PARAMETER_SEGMENT = /^(?::[A-Za-z0-9_]+|\{[A-Za-z0-9_.-]+\}|\[[A-Za-z0-9_-]+\])$/;

const segmentsOf = (path: string): string[] => path.split("/").filter((segment) => segment !== "");

/* Whether a lesson's page covers `path`: the same page, or a template of the map whose parameters take the path's values segment by segment. */
export function scopeCovers(scope: string, path: string): boolean {
  if (scope === path) return true;
  const wanted = segmentsOf(scope);
  const given = segmentsOf(path);
  return wanted.length === given.length && wanted.every((segment, index) => segment === given[index] || PARAMETER_SEGMENT.test(segment));
}

/* Whether a flow's page and a lesson's page name the same page, either of them being the template. */
export const routeCoveredBy = (scope: string, route: string): boolean => scopeCovers(scope, route) || scopeCovers(route, scope);
