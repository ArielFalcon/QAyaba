/*
 * GitHub-as-identity for the control plane. The server verifies WHO the user token belongs to
 * and that they hold push/admin on a watched repo. Never trust a username the client claims.
 */

export type FetchLike = typeof fetch;

const API = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";

function authHeaders(githubToken: string): HeadersInit {
  return { authorization: `Bearer ${githubToken}`, accept: ACCEPT };
}

export async function verifyGithubIdentity(githubToken: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const res = await fetchImpl(`${API}/user`, { headers: authHeaders(githubToken) });
  if (!res.ok) return null;
  const body = (await res.json()) as { login?: unknown };
  return typeof body.login === "string" && body.login !== "" ? body.login : null;
}

export async function authorizeUser(
  githubToken: string,
  repos: string[],
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const headers = authHeaders(githubToken);
  for (const repo of repos) {
    const res = await fetchImpl(`${API}/repos/${repo}`, { headers });
    if (!res.ok) continue;
    const body = (await res.json()) as { permissions?: { push?: boolean; maintain?: boolean; admin?: boolean } };
    const p = body.permissions;
    if (p && (p.push || p.maintain || p.admin)) return true;
  }
  return false;
}
