/** `fetch` and the auth-header supplier are injected so GITHUB_TOKEN (env-agnostic adapter invariant) is never read here — the composition factory (src/server/rewritten-engine-factory.ts, the sole src<->qa-engine seam) builds the real authHeaders() closure from requireEnv("GITHUB_TOKEN"). GitHub's documented hard limits for Issue/PR fields — exceeding either is a 422 ("title/body is too long"). */
export const GITHUB_MAX_TITLE = 256;
export const GITHUB_MAX_BODY = 65536;

export function clampTitle(title: string): string {
  if (title.length <= GITHUB_MAX_TITLE) return title;
  return title.slice(0, GITHUB_MAX_TITLE - 1).trimEnd() + "…";
}

export function clampBody(body: string): string {
  if (body.length <= GITHUB_MAX_BODY) return body;
  const notice = "\n\n_…(truncated to fit GitHub's 65536-character limit)_";
  return body.slice(0, GITHUB_MAX_BODY - notice.length) + notice;
}

export interface GitHubHttpDeps {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  authHeaders(): Record<string, string>;
}
