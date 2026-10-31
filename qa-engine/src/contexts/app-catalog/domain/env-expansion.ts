/* A config names its environment-dependent values as ${VAR} placeholders, so credentials never live in the repo; the environment they expand against is the caller's. */

export function expandEnv(s: string, env: Readonly<Record<string, string | undefined>>): string {
  /* Match any shell-style identifier (not uppercase-only) so a mis-cased ${myToken} fails as unset. */
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    const val = env[key];
    if (val === undefined) throw new Error(`config references unset env var \${${key}}`);
    return val;
  });
}
