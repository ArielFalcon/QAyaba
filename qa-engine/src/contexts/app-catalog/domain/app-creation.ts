/* The app-name rule is what keeps a name usable as a file name (`config/apps/<name>.yaml`), a volume key and a namespace. */
export const APP_NAME_RULE = "[a-z0-9][a-z0-9-]*";
const APP_NAME_PATTERN = new RegExp(`^${APP_NAME_RULE}$`);

export function isValidAppName(name: string): boolean {
  return APP_NAME_PATTERN.test(name);
}

/* What a caller may leave out when it creates an app. */
export interface AppCreationChoices {
  baseUrl?: string;
  versionUrl?: string;
  needsReview?: boolean;
  shadow?: boolean;
  testDataPrefix?: string;
}

/* The repository as the host knows it: its canonical name and the branch it ships from. */
export interface CreationRepo {
  fullName: string;
  defaultBranch: string;
}

/*
 * The fields of a new app's config: the repo's own name and default branch, and, for each choice the caller left out (an
 * empty url or prefix counts as left out), the default. A new app starts in shadow with its review on, so it publishes
 * nothing until an operator has seen it work; its url is the repo's page until the operator names the DEV site.
 */
export function appCreationDefaults(choices: AppCreationChoices, repo: CreationRepo) {
  return {
    repo: repo.fullName,
    baseBranch: repo.defaultBranch,
    baseUrl: choices.baseUrl || `https://github.com/${repo.fullName}`,
    versionUrl: choices.versionUrl || undefined,
    needsReview: choices.needsReview ?? true,
    shadow: choices.shadow ?? true,
    testDataPrefix: choices.testDataPrefix || "qa-bot",
  };
}
