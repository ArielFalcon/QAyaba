/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export type { CleanupPort } from "./ports/cleanup.port.ts";
export type { ConfinementPort } from "./ports/confinement.port.ts";
export type { MirrorGcPort } from "./ports/mirror-gc.port.ts";
export type { ObserverPort } from "./ports/observer.port.ts";
export type { PublicationPort } from "./ports/publication.port.ts";
export type { RunHistoryPort } from "./ports/run-history.port.ts";
export type { RunPipelinePort } from "./ports/run-pipeline.port.ts";
export type { SetupPort } from "./ports/setup.port.ts";
export type { WorkspacePort } from "./ports/workspace.port.ts";
export type { RunInput } from "../domain/run-input.ts";
export type { WorkspaceHandle, WorkspaceKind } from "../domain/workspace-handle.ts";
export type { ConfinementResult } from "../domain/confinement-result.ts";
export { RequestContextHeal } from "./request-context-heal.use-case.ts";
export type { ContextStaleFlagPort } from "./ports/context-stale-flag.port.ts";
export type { EnqueueContextRun } from "./ports/enqueue-context-run.port.ts";
export type { ContextHealRunRequest } from "../domain/context-heal-run-request.ts";
