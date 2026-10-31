/* The app-admin operations' inputs and result, as the control API declares them (the port its handlers call); the composition root's app admin (src/composition/app-admin.ts) implements them. */

import type { OnboardAuthInput, OnboardServiceInput } from "@contexts/app-catalog/application/index";

export interface RepoInfo {
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

export interface CreateAppInput {
  repo: string;
  name?: string;
  baseUrl?: string;
  versionUrl?: string;
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
