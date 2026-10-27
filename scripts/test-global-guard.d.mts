/* Types of what scripts/test-global-guard.mjs exports for its tests. */
export function runsTestsInThisProcess(execArgv?: readonly string[], env?: Readonly<Record<string, string | undefined>>): boolean;
export function installGlobalTimerGuard(
  hooks: {
    beforeEach: (fn: () => void) => void;
    afterEach: (fn: (t: { fullName: string; filePath?: string }) => void) => void;
  },
  root?: string,
): void;
