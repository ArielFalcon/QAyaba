/*
 * Server-side app onboarding/deletion. Secrets and config writes live here
 * (the orchestrator has the tokens; the TUI does not).
 */

import { parse } from "yaml";
import { AppConfigSchema } from "../orchestrator/schemas";
import { expandEnv, type AppConfig } from "../orchestrator/config-loader";
import { buildYaml, suggestName, type OnboardAuthInput, type OnboardInput, type OnboardServiceInput } from "./onboard";
import { patchAppYaml } from "./onboarding/patch-app-yaml";
import type { RepoInfo } from "../integrations/github";
import type { TestTarget } from "../types";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface AppAdminDeps {
  getRepoInfo(repo: string): Promise<RepoInfo>;
  configExists(name: string): boolean;
  writeConfig(name: string, yaml: string): string;
  deleteConfig(name: string): void;
  deleteMirror(repo: string): void;
  deleteHistory(app: string): number;
  /** Removes the app's stored login session / client certificate (orchestrator-only auth directory). */
  deleteAuthMaterial(app: string): void;
  applyEnv(vars: Record<string, string>): string[];
  loadApp(name: string): AppConfig;
  /** The config file's text exactly as written: comments and `${VAR}` placeholders included (loadApp returns them expanded). */
  readConfig(name: string): string;
  env: Record<string, string | undefined>;
}

export interface CreateAppInput {
  repo: string;
  name?: string;
  baseUrl?: string;
  versionUrl?: string;
  target?: TestTarget;
  needsReview?: boolean;
  shadow?: boolean;
  testDataPrefix?: string;
  services?: OnboardServiceInput[];
  env?: Record<string, string>;
  auth?: OnboardAuthInput;
  dryRun?: boolean;
  validateOnly?: boolean;
}

export interface UpdateAppInput {
  name: string;
  repo?: string;
  baseUrl?: string;
  versionUrl?: string;
  target?: TestTarget;
  needsReview?: boolean;
  shadow?: boolean;
  testDataPrefix?: string;
  services?: OnboardServiceInput[];
  env?: Record<string, string>;
  /** Absent on update preserves the auth block already in the YAML. */
  auth?: OnboardAuthInput;
  /** true drops the YAML auth block. Absent preserves it when auth is also absent. */
  clearAuth?: boolean;
  dryRun?: boolean;
}

export interface CreateAppResult {
  ok: boolean;
  errors?: string[];
  repoInfo?: RepoInfo;
  yaml?: string;
  name?: string;
  path?: string;
  envApplied?: string[];
  warnings?: string[];
}

export async function createApp(input: CreateAppInput, deps: AppAdminDeps): Promise<CreateAppResult> {
  let repoInfo: RepoInfo;
  try {
    repoInfo = await deps.getRepoInfo(input.repo);
  } catch (err) {
    return { ok: false, errors: [`repo validation failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (input.validateOnly) return { ok: true, repoInfo };

  const name = input.name ?? suggestName(input.repo);
  if (!NAME_RE.test(name)) return { ok: false, errors: [`invalid app name '${name}' (expected [a-z0-9][a-z0-9-]*)`] };
  if (!input.dryRun && deps.configExists(name)) return { ok: false, errors: [`app '${name}' already exists`] };

  const onboard: OnboardInput = {
    name,
    repo: repoInfo.fullName,
    baseBranch: repoInfo.defaultBranch,
    baseUrl: input.baseUrl || `https://github.com/${repoInfo.fullName}`,
    versionUrl: input.versionUrl || undefined,
    target: input.target ?? "e2e",
    needsReview: input.needsReview ?? true,
    shadow: input.shadow ?? true,
    testDataPrefix: input.testDataPrefix || "qa-bot",
    services: input.services,
    ...(input.auth ? { auth: input.auth } : {}),
  };
  const yaml = buildYaml(onboard);

  const expansionEnv = { ...deps.env, ...(input.env ?? {}) };
  try {
    AppConfigSchema.parse(parse(expandEnv(yaml, expansionEnv)));
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)], yaml };
  }

  if (input.dryRun) return { ok: true, repoInfo, name, yaml };

  let envApplied: string[] = [];
  if (input.env && Object.keys(input.env).length > 0) {
    envApplied = deps.applyEnv(input.env);
  }
  const path = deps.writeConfig(name, yaml);
  const warnings = envApplied.length
    ? ["env vars persisted to .env and applied live — if you deploy with Doppler, add them in Doppler too or they die with the container"]
    : [];
  return { ok: true, repoInfo, name, path, envApplied, warnings };
}

export async function updateApp(input: UpdateAppInput, deps: AppAdminDeps): Promise<CreateAppResult> {
  let existing: AppConfig;
  try {
    existing = deps.loadApp(input.name);
  } catch (err) {
    return { ok: false, errors: [`app '${input.name}' not found`] };
  }

  const repo = input.repo ?? existing.repo;
  let repoInfo: RepoInfo | undefined;
  if (repo !== existing.repo) {
    try {
      repoInfo = await deps.getRepoInfo(repo);
    } catch (err) {
      return { ok: false, errors: [`repo validation failed: ${err instanceof Error ? err.message : String(err)}`] };
    }
  }

  let rawYaml: string;
  try {
    rawYaml = deps.readConfig(input.name);
  } catch (err) {
    return { ok: false, errors: [`cannot read the config of app '${input.name}': ${err instanceof Error ? err.message : String(err)}`] };
  }

  /* Edit the file in place: only what this call supplies is written, everything else stays as the operator left it. */
  let yaml: string;
  try {
    yaml = patchAppYaml(rawYaml, {
      ...(repoInfo ? { repo: repoInfo.fullName, baseBranch: repoInfo.defaultBranch } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.versionUrl !== undefined ? { versionUrl: input.versionUrl } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.needsReview !== undefined ? { needsReview: input.needsReview } : {}),
      ...(input.shadow !== undefined ? { shadow: input.shadow } : {}),
      ...(input.testDataPrefix !== undefined ? { testDataPrefix: input.testDataPrefix } : {}),
      ...(input.services !== undefined ? { services: input.services } : {}),
      ...(input.auth !== undefined ? { auth: input.auth } : {}),
      ...(input.clearAuth ? { clearAuth: true } : {}),
    });
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }

  const expansionEnv = { ...deps.env, ...(input.env ?? {}) };
  try {
    AppConfigSchema.parse(parse(expandEnv(yaml, expansionEnv)));
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)], yaml };
  }

  if (input.dryRun) return { ok: true, repoInfo, name: input.name, yaml };

  let envApplied: string[] = [];
  if (input.env && Object.keys(input.env).length > 0) {
    envApplied = deps.applyEnv(input.env);
  }
  const path = deps.writeConfig(input.name, yaml);
  const warnings = envApplied.length
    ? ["env vars persisted to .env and applied live — if you deploy with Doppler, add them in Doppler too or they die with the container"]
    : [];
  return { ok: true, repoInfo, name: input.name, path, envApplied, warnings };
}

export function deleteApp(name: string, purge: boolean, deps: AppAdminDeps): { removed: string[] } {
  if (!NAME_RE.test(name)) throw new Error(`invalid app name: ${JSON.stringify(name)}`);
  const app = deps.loadApp(name);  /* throws if not onboarded */
  const removed: string[] = [];
  deps.deleteConfig(name);
  removed.push(`config:${name}`);
  /* Login material (session cookies, client certificate, its passphrase) is a live credential for an
     app that no longer exists: every delete removes it, purge or not. */
  deps.deleteAuthMaterial(name);
  removed.push(`auth:${name}`);
  if (purge) {
    /* Only the primary mirror: a service repo's mirror may be shared with another app. */
    deps.deleteMirror(app.repo);
    removed.push(`mirror:${app.repo}`);
    deps.deleteHistory(name);
    removed.push(`history:${name}`);
  }
  return { removed };
}
