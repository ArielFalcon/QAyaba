/* Privilege-drop sandbox for untrusted code. scrubEnv removes secrets from the environment, but watched-repo commands still run as the orchestrator user (root in the container) with its filesystem — a test could read the API token, tamper with /app, write sibling mirrors, or plant a .git hook that later runs as root on publish. Untrusted spawns run as the image's `sandbox` user; the working copy is chowned to it. `.git` stays root-owned. NETWORK is left intact (Maven/Gradle resolve deps). `resolveSandbox` does not read process.env — the composition-root shell passes env in (the one standing env-read exception in qa-engine is scrub-env.ts). */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_ENV_PREFIX } from "./scrub-env.ts";

export interface Sandbox {
  uid: number;
  gid: number;
  home: string;
}

/** Resolves the sandbox identity, or null when privilege-drop does not apply (not root, not Linux, explicitly disabled, or the sandbox home is absent → the image wasn't built with the user). When null, spawns run as the current user exactly as before — so local `npm run qa` on macOS still works. `env` is REQUIRED (no default) — the caller (composition-root shell) must read process.env and pass it in; see this file's header for why. */
export function resolveSandbox(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  getuid: () => number = () => process.getuid?.() ?? -1,
  homeExists: (p: string) => boolean = existsSync,
): Sandbox | null {
  if (env.CODE_SANDBOX === "off") return null;
  if (platform !== "linux") return null; /* uid/gid spawn needs POSIX privilege semantics */
  if (getuid() !== 0) return null; /* only root can setuid to the sandbox user */
  const uid = Number(env.CODE_SANDBOX_UID ?? 1001);
  const gid = Number(env.CODE_SANDBOX_GID ?? uid);
  const home = env.CODE_SANDBOX_HOME ?? "/home/sandbox";
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0) return null;
  if (!homeExists(home)) {
    console.warn(`[qa] code-mode sandbox DISABLED: home ${home} not found (image built without the sandbox user?). Untrusted code will run as the current user.`);
    return null;
  }
  return { uid, gid, home };
}

/* npm config vars that describe how the PARENT process was invoked rather than persisted user
   configuration: `local_prefix` names the PARENT's own project directory (wrong for a child
   installing a different repoDir under a different HOME — not a permission problem, a correctness
   one), and `user_agent`/`npm_version`/`node_gyp`/`init_module` describe the parent npm binary's
   own identity/installation, not anything the sandboxed child should inherit. Unlike a cache or
   config-file path, there is no sandbox-relative value that would make these correct, so they are
   dropped outright rather than rebased. */
const SANDBOX_DROP_ENV_EXACT = new Set([
  "npm_config_local_prefix",
  "npm_config_user_agent",
  "npm_config_npm_version",
  "npm_config_node_gyp",
  "npm_config_init_module",
]);

/** Rewrites a value's leading `fromHome` segment onto `toHome`; any other value (not under
 * `fromHome`, or `fromHome` unset) passes through unchanged. */
function rebaseUnderHome(value: string, fromHome: string, toHome: string): string {
  if (!fromHome || fromHome === toHome) return value;
  if (value === fromHome) return toHome;
  if (value.startsWith(`${fromHome}/`)) return toHome + value.slice(fromHome.length);
  return value;
}

/** Spawn options that drop to the sandbox: the uid/gid plus a HOME pointing at the sandbox's own
 * writable home (so toolchain caches — ~/.m2, ~/.gradle, ~/.cache, ~/.cargo — never touch root's),
 * merged onto the scrubbed env. When `sandbox` is null this is just the scrubbed env, unchanged, so
 * the spawn runs as the current user.
 *
 * `npm run start` (or any lifecycle-script parent) injects vars like `npm_config_cache=/root/.npm`
 * into every child process. Overriding only HOME/USER/LOGNAME would leave the sandboxed child
 * writing into root's own cache dir, which it cannot access (EACCES). So the rule is
 * ecosystem-agnostic: ANY package-manager config var (the same prefix family `scrubEnv` already
 * allows through — npm_config_, PIP_, CARGO_, GRADLE_, MAVEN_, PNPM_, YARN_, COREPACK_, ...) whose
 * value sits under the PARENT's home is rebased onto the sandbox's own home, never onto vars
 * outside that family (PATH must keep pointing at the real, world-readable node/npm install, not a
 * nonexistent path under the sandbox home). A legitimate, non-home-relative setting (a private
 * registry URL, a flag) is left untouched. */
export function sandboxSpawnOptions(
  base: Record<string, string>,
  sandbox: Sandbox | null,
): { env: Record<string, string>; uid?: number; gid?: number } {
  if (!sandbox) return { env: base };
  const fromHome = base.HOME ?? "";
  const env: Record<string, string> = { HOME: sandbox.home, USER: "sandbox", LOGNAME: "sandbox" };
  for (const [key, value] of Object.entries(base)) {
    if (key === "HOME" || key === "USER" || key === "LOGNAME") continue;
    if (SANDBOX_DROP_ENV_EXACT.has(key)) continue;
    env[key] = ALLOWED_ENV_PREFIX.test(key) ? rebaseUnderHome(value, fromHome, sandbox.home) : value;
  }
  return { env, uid: sandbox.uid, gid: sandbox.gid };
}

/** Hand the run's working copy to the sandbox user so its install/test can write ONLY there. The chown runs on the SOURCE tree (before install/deps). `.git` is kept ROOT-owned: a sandbox-writable `.git/hooks` would run as root on the next `git commit`. Root retains full access regardless of ownership, so publish/mirror git ops are unaffected. No-op when the sandbox does not apply. `sandbox` is required (no default) — the composition-root shell injects an already-resolved identity. */
export function prepareSandboxWorkdir(repoDir: string, sandbox: Sandbox | null): void {
  if (!sandbox) return;
  execFileSync("chown", ["-R", `${sandbox.uid}:${sandbox.gid}`, repoDir], { stdio: "ignore" });
  const gitDir = join(repoDir, ".git");
  if (existsSync(gitDir)) execFileSync("chown", ["-R", "0:0", gitDir], { stdio: "ignore" });
}
