/*
 * The conditions that decide what a run is wired with and that its effectiveConfig must report: one definition each, used by the
 * composition (what is wired) and by the recorded run configuration (what is recorded), so the record cannot drift from the wiring.
 */

/* The service-topology collaborator and cross-repo impact (the "stitcher") are wired only for an app with services and declared boundaries. */
export function serviceTopologyWired(app: { services?: readonly unknown[] | undefined; boundaries?: readonly unknown[] | undefined }): boolean {
  return (app.services?.length ?? 0) > 0 && (app.boundaries?.length ?? 0) > 0;
}

/* The run_spec loop and the authenticated browser are on for every app unless it sets `enabled: false`: each degrades by itself where it cannot help (no saved session, a runtime that cannot call a custom tool), and an app with a login and neither has no sidekick able to author. */
export function closedLoopEnabled(app: { qa: { closedLoop?: { enabled?: boolean | undefined } | undefined } }): boolean {
  return app.qa.closedLoop?.enabled !== false;
}

export function agentBrowserEnabled(app: { qa: { agentBrowser?: { enabled?: boolean | undefined } | undefined } }): boolean {
  return app.qa.agentBrowser?.enabled !== false;
}
