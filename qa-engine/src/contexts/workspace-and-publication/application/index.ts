/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { WriteConfinementService } from "../domain/write-confinement.service.ts";
export type { CleanupPort } from "./ports/cleanup.port.ts";
export type { ConfinementPort } from "./ports/confinement.port.ts";
export type { MirrorGcPort } from "./ports/workspace-mirror-gc.port.ts";
export type { PublicationPort } from "./ports/publication.port.ts";
export type { SetupPort } from "./ports/setup.port.ts";
export type { WorkspacePort } from "./ports/workspace.port.ts";
export type { WorkspaceHandle, WorkspaceKind } from "../domain/workspace-handle.ts";
export type { ConfinementResult } from "../domain/confinement-result.ts";
