/**
 * Captures the FE<->BE architecture map (`${specDir}/.qa/context.json`) a successful mode:context
 * generation wrote, and persists it as the app's durable stored map (shell-side SQLite — see
 * the history store's context_maps table). This is the write side; PreGenerationGroundingPort.loadContextMap
 * is the read side. Invoked once per clean context-mode pass, in BOTH shadow and non-shadow runs —
 * publishing e2e/.qa/context.json via PR stays independently shadow-gated (buildVcsPublish), but the
 * stored map must survive regardless, since the mirror's e2e/.qa/context.json is wiped by the next
 * run's `git checkout -f` + `git clean -fd`. Off-path: a capture fault is fault-isolated inside the
 * adapter (never gates a verdict or publish), same contract as CurriculumPort.fold above.
 */
export interface ContextMapCapturePort {
  capture(specDir: string, app: string, sha: string): Promise<void>;
}
