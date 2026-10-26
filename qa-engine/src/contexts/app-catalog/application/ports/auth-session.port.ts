import type { AuthSession, AuthSessionRequest } from "../../domain/auth-session.ts";

export interface AuthSessionPort {
  prepare(req: AuthSessionRequest, signal?: AbortSignal): Promise<AuthSession>;
}
