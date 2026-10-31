/* Frozen sidekick authority. The worker cannot raise these flags via prompt or result JSON. */
export const SIDEKICK_AUTHORITY = {
  canModifyArchitecture: false,
  canChangeAcceptanceCriteria: false,
  canExpandScope: false,
  canChallengeBrief: true,
} as const;

export type SidekickAuthority = typeof SIDEKICK_AUTHORITY;
