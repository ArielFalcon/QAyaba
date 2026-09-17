/* Privilege-drop sandbox for untrusted code. scrubEnv removes secrets from the environment, but watched-repo commands still run as the orchestrator user (root in the container) with its filesystem — a test could read the API token, tamper with /app, write sibling mirrors, or plant a .git hook that later runs as root on publish. Untrusted spawns run as the image's `sandbox` user; the working copy is chowned to it. `.git` stays root-owned. NETWORK is left intact (Maven/Gradle resolve deps). `resolveSandbox` does not read process.env — the composition-root shell passes env in (the one standing env-read exception in qa-engine is scrub-env.ts). */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

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

/** Spawn options that drop to the sandbox: the uid/gid plus a HOME pointing at the sandbox's own writable home (so toolchain caches — ~/.m2, ~/.gradle, ~/.cache, ~/.cargo — never touch root's), merged onto the scrubbed env. When `sandbox` is null this is just the scrubbed env (unchanged), so the spawn runs exactly as before. */
export function sandboxSpawnOptions(
  base: Record<string, string>,
  sandbox: Sandbox | null,
): { env: Record<string, string>; uid?: number; gid?: number } {
  if (!sandbox) return { env: base };
  return {
    env: { ...base, HOME: sandbox.home, USER: "sandbox", LOGNAME: "sandbox" },
    uid: sandbox.uid,
    gid: sandbox.gid,
  };
}

/** Hand the run's working copy to the sandbox user so its install/test can write ONLY there. The chown runs on the SOURCE tree (before install/deps). `.git` is kept ROOT-owned: a sandbox-writable `.git/hooks` would run as root on the next `git commit`. Root retains full access regardless of ownership, so publish/mirror git ops are unaffected. No-op when the sandbox does not apply. `sandbox` is required (no default) — the composition-root shell injects an already-resolved identity. */
export function prepareSandboxWorkdir(repoDir: string, sandbox: Sandbox | null): void {
  if (!sandbox) return;
  execFileSync("chown", ["-R", `${sandbox.uid}:${sandbox.gid}`, repoDir], { stdio: "ignore" });
  const gitDir = join(repoDir, ".git");
  if (existsSync(gitDir)) execFileSync("chown", ["-R", "0:0", gitDir], { stdio: "ignore" });
}
