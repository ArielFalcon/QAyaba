/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export type { AuthSession, AuthSessionContext, AuthSessionPort } from "./ports/auth-session.port.ts";
export { AuthPreconditionError } from "../domain/auth-precondition.ts";
export type { PreconditionKind } from "../domain/auth-precondition.ts";
