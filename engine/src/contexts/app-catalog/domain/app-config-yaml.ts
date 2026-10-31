/* The text of a new app config, and the name a repository suggests for its app. */

export interface OnboardServiceInput {
  repo: string;
  openapi?: string;
  versionUrl?: string;
}

export interface OnboardAuthInput {
  kind: "form" | "mtls";
  usernameEnv?: string;
  passwordEnv?: string;
  certEnv?: string;
  certPassEnv?: string;
  /** Form logins only: a path on the app's own origin (see LoginPathSchema). */
  loginPath?: string;
}

export interface OnboardInput {
  name: string;
  repo: string;
  baseBranch: string;
  baseUrl: string;
  versionUrl?: string;
  needsReview: boolean;
  shadow: boolean;
  testDataPrefix: string;
  services?: OnboardServiceInput[];
  /** Absent = public app. */
  auth?: OnboardAuthInput;
}

export function buildYaml(input: OnboardInput): string {
  const lines: string[] = [
    `name: "${input.name}"`,
    `repo: "${input.repo}"`,
    `baseBranch: "${input.baseBranch}"`,
  ];

  lines.push(
    "",
    "dev:",
    `  baseUrl: "${input.baseUrl}"`,
  );

  if (input.versionUrl) {
    lines.push(`  versionUrl: "${input.versionUrl}"`);
  }

  if (input.auth) {
    lines.push("", "auth:", `  kind: ${input.auth.kind}`);
    if (input.auth.usernameEnv) lines.push(`  usernameEnv: "${input.auth.usernameEnv}"`);
    if (input.auth.passwordEnv) lines.push(`  passwordEnv: "${input.auth.passwordEnv}"`);
    if (input.auth.certEnv) lines.push(`  certEnv: "${input.auth.certEnv}"`);
    if (input.auth.certPassEnv) lines.push(`  certPassEnv: "${input.auth.certPassEnv}"`);
    if (input.auth.kind === "form" && input.auth.loginPath) lines.push(`  loginPath: ${JSON.stringify(input.auth.loginPath)}`);
  }

  if (input.services?.length) {
    lines.push("", "services:");
    for (const s of input.services) {
      lines.push(`  - repo: "${s.repo}"`);
      if (s.openapi) lines.push(`    openapi: "${s.openapi}"`);
      if (s.versionUrl) lines.push(`    versionUrl: "${s.versionUrl}"`);
    }
  }

  lines.push(
    "",
    "qa:",
    `  needsReview: ${input.needsReview}`,
    `  shadow: ${input.shadow}`,
    `  testDataPrefix: "${input.testDataPrefix}"`,
    "",
    "report:",
    `  onFailure: "github-issue"`,
    "",
  );

  return lines.join("\n");
}

export function suggestName(repo: string): string {
  const parts = repo.split("/");
  return (parts[1] ?? parts[0] ?? "app").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
