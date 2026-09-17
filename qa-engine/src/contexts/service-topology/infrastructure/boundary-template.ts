
const PLACEHOLDER = "{service}";
const SERVICE_CHARSET = "[A-Za-z0-9_-]+";

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count non-overlapping occurrences of "{service}" in a template. */
function countPlaceholders(template: string): number {
  return template.split(PLACEHOLDER).length - 1;
}

/** Split a template on its one "{service}" placeholder into literal prefix/suffix. Returns null unless there is exactly one placeholder — zero placeholders become a phantom optional-capture group; two or more only match the first occurrence. Both shapes are unsupported config. */
function splitTemplate(template: string): { prefix: string; suffix: string } | null {
  if (countPlaceholders(template) !== 1) return null;
  const idx = template.indexOf(PLACEHOLDER);
  return {
    prefix: template.slice(0, idx),
    suffix: template.slice(idx + PLACEHOLDER.length),
  };
}

export interface PrefixMatch {
  service: string;
  resource: string;
}

/** Accepts an optional leading slash. */
export function compilePrefixTemplate(template: string): (path: string) => PrefixMatch | null {
  const split = splitTemplate(template);
  if (!split) {
    console.warn(
      `[compilePrefixTemplate] unsupported servicePrefixTemplate "${template}" — expected ` +
        `exactly one "{service}" token. Failing closed: this matcher will never match.`,
    );
    return (): null => null;
  }
  const { prefix, suffix } = split;
  const re = new RegExp(
    `^/?${escapeRegExp(prefix)}(${SERVICE_CHARSET}?)${escapeRegExp(suffix)}(?:/(.*)|)$`,
  );
  return (path: string): PrefixMatch | null => {
    const m = path.match(re);
    if (!m) return null;
    const service = m[1] ?? "";
    if (service.length === 0) return null;
    return { service, resource: m[2] ?? "" };
  };
}

/** Compile a repo-slug template into a slug→service extractor. Returns the original slug when the template does not match. Requires exactly one "{service}" token; an unsupported shape warns and fails closed — the extractor always returns the raw slug, never a phantom capture. */
export function compileRepoTemplate(template: string): (slug: string) => string {
  const split = splitTemplate(template);
  if (!split) {
    console.warn(
      `[compileRepoTemplate] unsupported serviceRepoTemplate "${template}" — expected exactly ` +
        `one "{service}" token. Failing closed: this extractor will always return the raw slug.`,
    );
    return (slug: string): string => slug;
  }
  const { prefix, suffix } = split;
  const re = new RegExp(`^${escapeRegExp(prefix)}(${SERVICE_CHARSET}?)${escapeRegExp(suffix)}$`);
  return (slug: string): string => {
    const m = slug.match(re);
    const service = m?.[1];
    return service && service.length > 0 ? service : slug;
  };
}
