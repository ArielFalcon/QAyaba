/* Behavioral tests for the privilege-drop sandbox primitives. resolveSandbox takes `env`
   explicitly in every call here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
/* 3 leading ../ from qa-engine/test/shared-infrastructure/process-sandbox/ to qa-engine/src/
   (same convention as this directory's own scrub-env.test.ts).
 */
import { resolveSandbox, sandboxSpawnOptions } from "../../../src/shared-infrastructure/process-sandbox/sandbox.ts";

/* Sandbox identity resolver — privilege-drop applies ONLY in the root-on-Linux container with
   the baked-in user; everywhere else it must degrade to "no sandbox" so local runs are unaffected.
 */
test("resolveSandbox applies only as root on Linux with an existing home; degrades safely otherwise", () => {
  const homeOk = () => true;
  const asRoot = () => 0;
  const base = { CODE_SANDBOX_UID: "1001" } as NodeJS.ProcessEnv;

  assert.deepEqual(resolveSandbox(base, "linux", asRoot, homeOk), { uid: 1001, gid: 1001, home: "/home/sandbox" });

  assert.equal(resolveSandbox(base, "darwin", asRoot, homeOk), null);
  assert.equal(resolveSandbox(base, "linux", () => 1000, homeOk), null); /* not root */
  assert.equal(resolveSandbox({ CODE_SANDBOX: "off" } as NodeJS.ProcessEnv, "linux", asRoot, homeOk), null);
  assert.equal(resolveSandbox(base, "linux", asRoot, () => false), null); /* image lacks the user/home */
  assert.equal(resolveSandbox({ CODE_SANDBOX_UID: "0" } as NodeJS.ProcessEnv, "linux", asRoot, homeOk), null);

  assert.deepEqual(
    resolveSandbox({ CODE_SANDBOX_UID: "2000", CODE_SANDBOX_GID: "2001", CODE_SANDBOX_HOME: "/sb" } as NodeJS.ProcessEnv, "linux", asRoot, homeOk),
    { uid: 2000, gid: 2001, home: "/sb" },
  );
});

test("sandboxSpawnOptions: passthrough env when no sandbox; uid/gid + redirected HOME when sandboxed", () => {
  const env = { PATH: "/usr/bin", HOME: "/root" };
  assert.deepEqual(sandboxSpawnOptions(env, null), { env }); /* unchanged, runs as current user */

  const opts = sandboxSpawnOptions(env, { uid: 1001, gid: 1001, home: "/home/sandbox" });
  assert.equal(opts.uid, 1001);
  assert.equal(opts.gid, 1001);
  assert.equal(opts.env.HOME, "/home/sandbox"); /* toolchain caches stay out of root's home */
  assert.equal(opts.env.USER, "sandbox");
  assert.equal(opts.env.PATH, "/usr/bin");
});

/* A sandboxed install must not write into root's own directories: `npm run start` injects
   npm_config_cache=/root/.npm (and siblings) into every child process, and a child that kept them
   would try to write to a cache directory it cannot own (EACCES, `npm ci` exit 243). The rule is
   general: ANY inherited package-manager config var (npm_config_*, PNPM_, YARN_, COREPACK_,
   CARGO_, GRADLE_, MAVEN_, PIP_, ...) whose value sits under the parent's HOME is rebased onto the
   sandbox's own (writable) home, not just npm's cache var specifically. */
test("sandboxSpawnOptions rebases root-home package-manager config paths onto the sandbox home", () => {
  const env = {
    HOME: "/root",
    npm_config_cache: "/root/.npm",
    npm_config_userconfig: "/root/.npmrc",
    CARGO_HOME: "/root/.cargo",
    GRADLE_USER_HOME: "/root/.gradle",
    PIP_CACHE_DIR: "/root/.cache/pip",
  };
  const opts = sandboxSpawnOptions(env, { uid: 1001, gid: 1001, home: "/home/sandbox" });
  assert.equal(opts.env.npm_config_cache, "/home/sandbox/.npm");
  assert.equal(opts.env.npm_config_userconfig, "/home/sandbox/.npmrc");
  assert.equal(opts.env.CARGO_HOME, "/home/sandbox/.cargo");
  assert.equal(opts.env.GRADLE_USER_HOME, "/home/sandbox/.gradle");
  assert.equal(opts.env.PIP_CACHE_DIR, "/home/sandbox/.cache/pip");
});

test("sandboxSpawnOptions leaves a package-manager config value untouched when it is not under the parent home (e.g. a private registry URL)", () => {
  const env = { HOME: "/root", npm_config_registry: "https://registry.local/npm" };
  const opts = sandboxSpawnOptions(env, { uid: 1001, gid: 1001, home: "/home/sandbox" });
  assert.equal(opts.env.npm_config_registry, "https://registry.local/npm");
});

test("sandboxSpawnOptions does not rebase unrelated vars that happen to start with the parent home (PATH must keep pointing at real, readable binaries)", () => {
  const env = { HOME: "/root", PATH: "/root/.nvm/versions/node/v24.11.0/bin:/usr/bin" };
  const opts = sandboxSpawnOptions(env, { uid: 1001, gid: 1001, home: "/home/sandbox" });
  assert.equal(opts.env.PATH, "/root/.nvm/versions/node/v24.11.0/bin:/usr/bin");
});

test("sandboxSpawnOptions drops npm lifecycle/invocation vars that describe the PARENT process rather than user configuration", () => {
  const env = {
    HOME: "/root",
    npm_config_local_prefix: "/app", /* the parent's own project root — wrong for a child install in a different repoDir */
    npm_config_user_agent: "npm/10.0.0 node/v24.11.0 linux x64",
    npm_config_npm_version: "10.0.0",
    npm_config_node_gyp: "/root/.nvm/versions/node/v24.11.0/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js",
    npm_config_init_module: "/root/.npm-init.js",
  };
  const opts = sandboxSpawnOptions(env, { uid: 1001, gid: 1001, home: "/home/sandbox" });
  for (const key of Object.keys(env)) {
    if (key === "HOME") continue;
    assert.equal(key in opts.env, false, `${key} must not leak into the sandboxed child`);
  }
});
