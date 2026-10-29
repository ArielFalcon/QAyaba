/*
 * Variables of features that were removed. Nothing reads them; one still set in an environment would be ignored in
 * silence, so a load reports each once. The operator's environment files are the operator's to edit.
 */
const RETIRED_SETTINGS: ReadonlyArray<{ readonly name: string; readonly gone: string }> = [
  { name: "SELF_MAINTAINER_AUTOMERGE", gone: "the self-maintainer was removed" },
  { name: "SELF_MAINTAINER_CI_CHECK", gone: "the self-maintainer was removed" },
  { name: "QAYABA_REPO", gone: "the self-maintainer was removed" },
  { name: "QA_REFLECTOR_ENABLED", gone: "the reflector was removed" },
  { name: "LANGFUSE_BASE_URL", gone: "the Langfuse score sink was removed" },
  { name: "LANGFUSE_PUBLIC_KEY", gone: "the Langfuse score sink was removed" },
  { name: "LANGFUSE_SECRET_KEY", gone: "the Langfuse score sink was removed" },
  { name: "LANGFUSE_ALLOW_EXTERNAL", gone: "the Langfuse score sink was removed" },
];

export function retiredSettingWarnings(env: Readonly<Record<string, string | undefined>>): string[] {
  return RETIRED_SETTINGS.filter(({ name }) => env[name] !== undefined && env[name] !== "").map(
    ({ name, gone }) => `${name} is set but no longer read: ${gone}; remove it from the environment`,
  );
}
