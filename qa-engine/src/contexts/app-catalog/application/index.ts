/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { AuthPreconditionError } from "../domain/auth-precondition.ts";
export type { PreconditionKind } from "../domain/auth-precondition.ts";
export type { AppRepositoryPort } from "./ports/app-repository.port.ts";
export type { AuthSessionPort } from "./ports/auth-session.port.ts";
export type { AuthDeclaration, AuthSession, AuthSessionContext, AuthSessionRequest } from "../domain/auth-session.ts";
export { PRECONDITION_KIND } from "../domain/auth-precondition.ts";
