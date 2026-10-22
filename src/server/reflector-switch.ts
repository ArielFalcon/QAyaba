/*
 * Operator switch, OFF by default, for the reflector: the qa-reflector pass that turns a run's outcome into a
 * learned rule, and the injection of the rules it (and any experiment) authored into later prompts.
 *
 * The reflector received about 1.5 KB of a run without its real error text, invented a cause from a false-positive
 * gate signal, and its "experimental rule" told a shell-less generator to run tsc in the next run's prompt. Until
 * a reflection can be trusted, the pass does not run and only rules that earned their place (active, above low
 * confidence, from measured outcomes) reach a prompt. The deterministic rule fold stays on either way.
 * Read once by the composition root; the engine never reads the environment. A mistyped value throws, as the
 * other operator switches do.
 */
export const REFLECTOR_ENABLED_ENV = "QA_REFLECTOR_ENABLED";

export function resolveReflectorEnabled(env: Record<string, string | undefined>): boolean {
  const raw = (env[REFLECTOR_ENABLED_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  throw new Error(`${REFLECTOR_ENABLED_ENV} must be 1, true, 0, false or empty, got ${JSON.stringify(env[REFLECTOR_ENABLED_ENV])}`);
}
