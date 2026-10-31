/* Signs in again and refreshes the saved session the next call copies. Resolves whether the session is usable. */
export interface SessionRenewalPort {
  renew(signal?: AbortSignal): Promise<boolean>;
}
