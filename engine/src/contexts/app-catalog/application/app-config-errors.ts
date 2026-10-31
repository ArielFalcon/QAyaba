/* The two ways loading a watched app's config fails that a caller is meant to tell apart, and the words a caller that reports instead of throwing uses for them. */

/* The app has no config file: it was never onboarded, or was deleted. */
export class AppNotFoundError extends Error {
  constructor(readonly app: string) {
    super(`config/apps/${app}.yaml not found — is the app onboarded?`);
    this.name = "AppNotFoundError";
  }
}

/* The app has a config file that cannot be turned into a valid config: it cannot be read, an env var it names is unset, the YAML does not parse or the schema rejects it. `reason` is the underlying message; `cause` keeps the original error. */
export class AppConfigInvalidError extends Error {
  constructor(readonly app: string, readonly reason: string, options?: { cause?: unknown }) {
    super(`app config invalid: '${app}': ${reason}`, options);
    this.name = "AppConfigInvalidError";
  }
}

/** The words a caller that reports instead of throwing uses for a failed load, or undefined when the failure is not about the app's config and must propagate. */
export function describeAppLoadFailure(name: string, err: unknown): string | undefined {
  if (err instanceof AppNotFoundError) return `app not found: '${name}'`;
  if (err instanceof AppConfigInvalidError) return err.message;
  return undefined;
}
