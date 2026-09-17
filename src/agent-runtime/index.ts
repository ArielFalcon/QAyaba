/*
 * Provider I/O shell: provider-agnostic facade dispatching each role to the OpenCode
 * or Codex runtime strategy (raw process/SDK edges). Not engine policy.
 */
export * from "./types";
export * from "./config";
export * from "./facades";
export * from "./opencode-strategy";
export * from "./codex-strategy";
