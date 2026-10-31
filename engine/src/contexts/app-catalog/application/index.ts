/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { AuthPreconditionError } from "../domain/auth-precondition.ts";
export type { PreconditionKind } from "../domain/auth-precondition.ts";
export type { AppRepositoryPort } from "./ports/app-repository.port.ts";
export type { AuthSessionPort } from "./ports/auth-session.port.ts";
export type { AuthDeclaration, AuthSession, AuthSessionContext, AuthSessionRequest } from "../domain/auth-session.ts";
export { PRECONDITION_KIND } from "../domain/auth-precondition.ts";
export { AppConfigSchema, describeAppConfigError } from "./app-config.schema.ts";
export type { ValidatedAppConfig } from "./app-config.schema.ts";
export { AppConfigInvalidError, AppNotFoundError, describeAppLoadFailure } from "./app-config-errors.ts";
export { LoginPathSchema } from "../domain/login-path.ts";
export { APP_NAME_RULE, appCreationDefaults, isValidAppName } from "../domain/app-creation.ts";
export type { AppCreationChoices, CreationRepo } from "../domain/app-creation.ts";
export { expandEnv } from "../domain/env-expansion.ts";
export { buildYaml, suggestName } from "../domain/app-config-yaml.ts";
export type { OnboardAuthInput, OnboardInput, OnboardServiceInput } from "../domain/app-config-yaml.ts";
export { patchAppYaml } from "./patch-app-yaml.ts";
export type { AppYamlPatch, AppYamlPatchOptions } from "./patch-app-yaml.ts";
