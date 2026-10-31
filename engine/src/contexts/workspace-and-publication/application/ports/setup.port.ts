/**
 * Bootstraps fixtures/deps before generation. e2e-vs-code dispatch is the
 * adapter's concern. A throw must propagate: setup failure is infra-error,
 * never a code verdict.
 */
export interface SetupPort {
  setup(specDir: string, signal?: AbortSignal): Promise<void>;
}
