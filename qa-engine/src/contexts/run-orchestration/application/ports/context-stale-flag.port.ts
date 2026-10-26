/* The flag that marks an app's stored context map as condemned. */
export interface ContextStaleFlagPort {
  clear(app: string): void;
}
