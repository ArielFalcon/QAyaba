// qa-engine/.dependency-cruiser.cjs
// Structural security invariant (§8 R4): the agent is READ-ONLY on watched repos; only the
// workspace-and-publication context may import the VCS write seam. The rule is inverted: deny the
// VcsWritePort import from EVERY context path that is NOT workspace-and-publication. This is broader
// than the prior generation|agent-runtime allowlist — it covers any new context added in future plans
// without requiring a whitelist update.
//
// ONE deliberate, narrow exemption (Task E.2): the run-orchestration COMPOSITION ROOT
// (composition-root.ts) is, per the plan's own design (§5.2), "the ONLY module that imports
// concrete adapters" — it is where the REAL PublishDecisionService/GitHubPrAdapter/
// GitHubIssueAdapter/ShadowLogAdapter instances are constructed and passed into the
// PublicationPortAdapter (which itself stays exempt-free — see its own header note on
// depending only on LOCAL structural interfaces). Every OTHER path under run-orchestration/
// (the adapters, the domain, the application layer) remains DENIED — only the single composition
// file is excepted, so a future adapter/domain/use-case addition is still secure by default.
// Known limitation: dependency-cruiser may miss dynamic import() — flagged for manual audit.
//
// options.baseDir (judgment-day round-1): pinned to the repo root, NOT left to default to
// process.cwd(). This fixes the `from`/`to` RULE-MATCHING regexes (anchored to
// "qa-engine/src/"/"^src/") so they resolve against repo-root-relative module ids no matter which
// directory the command is invoked from — see qa-engine/test/arch/no-src-import.test.ts's
// cwd=qa-engine/ variant.
//
// CONTRACT (judgment-day round-2 — the round-1 fix did NOT make every invocation form safe, only
// baseDir-relative ones): because baseDir is pinned to the repo root, dependency-cruiser ALSO
// resolves the CLI's own TARGET ARGUMENT against that same baseDir, not against the invoking cwd —
// so the target must itself be baseDir-relative ("qa-engine/src"), regardless of cwd. A bare
// relative target like `src`, run from inside qa-engine/ (e.g. `cd qa-engine && npx depcruise
// --config .dependency-cruiser.cjs src`), resolves as `<repo-root>/src` — the shell's root src/
// tree, a completely different, still-existing directory — not qa-engine/src. This does not error;
// it silently scans the wrong tree and reports a false "clean" even with a real qa-engine/src/
// violation present, because none of that tree's module ids match the `^qa-engine/src/` `from`
// pattern. Reproduced: 392 modules cruised (root src/) vs. 172 modules (qa-engine/src) on
// otherwise-identical HEAD. The canonical invocation is `npm run arch:check` FROM THE REPO ROOT
// (root package.json); from a subtree with its own package.json (qa-engine/, web/, packages/*)
// npm resolves the nearest manifest and fails LOUDLY with "Missing script" — an error, never a
// silent wrong-tree scan. The always-enforced gate is qa-engine/test/arch/ inside `npm test`,
// which pins its own cwd and is invocation-independent.
const path = require("node:path");

module.exports = {
  forbidden: [
    {
      name: "no-vcs-write-in-agent-contexts",
      severity: "error",
      comment: "Only workspace-and-publication (and the run-orchestration composition root, its one declared exception) may import the VCS write seam. All other contexts/* paths are denied — this rule is inverted so new contexts are secure by default without a whitelist update.",
      from: {
        path: "qa-engine/src/contexts/(?!workspace-and-publication)",
        pathNot: "qa-engine/src/contexts/run-orchestration/composition/composition-root\\.ts$",
      },
      to: { path: "contexts/workspace-and-publication" },
    },
    {
      name: "no-telemetry-sdk-in-engine",
      severity: "error",
      comment: "The engine sees tracing and metrics only through the TelemetryPort in shared-kernel/telemetry (no SDK types). The OpenTelemetry SDK, and any Langfuse client, is imported only by the shell, under src/telemetry/. Swapping or removing the backend must never touch the engine.",
      from: { path: "^qa-engine/src/" },
      to: { path: "(^|/)node_modules/(@opentelemetry/|langfuse)" },
    },
    {
      name: "no-detached-git-hardening-in-engine",
      severity: "error",
      comment: "Every git call the engine makes on a working copy goes through hardenGitArgs, which verifies the git dir first. The hardening that verifies nothing (a clone, an ls-remote) lives in its own module and is for the shell, which owns such calls. The allowlist of engine importers is empty by design: a git call in the engine that seems to need it has a working copy to pass to hardenGitArgs.",
      from: { path: "^qa-engine/src/" },
      to: { path: "^qa-engine/src/shared-infrastructure/process-sandbox/detached-git-hardening\\.ts$" },
    },
    {
      name: "no-git-hardening-flags-outside-hardening",
      severity: "error",
      comment: "The bare hardening flags are the hardening minus the working-copy verification. Only the two hardening modules (hardenGitArgs, which verifies the git dir first, and the detached variant, which the engine may not import) build argv from them: an engine module holding them could run git on a sandbox-touched working copy without its git dir ever being judged.",
      from: { path: "^qa-engine/src/", pathNot: "^qa-engine/src/shared-infrastructure/process-sandbox/(detached-)?git-hardening\\.ts$" },
      to: { path: "^qa-engine/src/shared-infrastructure/process-sandbox/git-hardening-flags\\.ts$" },
    },
    {
      name: "no-child-process-outside-launchers",
      severity: "error",
      comment: "Every child process that runs code an agent influenced (a spec, a login script, the e2e project's tsc/eslint/--list and installs, the watched repo's own test command) starts through the execution launcher, which owns the sandbox uid, the profile's environment, the work directory and the egress lease. A module that imports child_process can start a child as the orchestrator, with its environment and its network, so the allowlist is the launcher, the generic runner for trusted binaries (git), the git hardening, and the privilege-drop module (chown), and the iptables applier of the egress filter. Type-only imports (ChildProcess) are not a way to start anything.",
      from: {
        path: "^qa-engine/src/",
        pathNot: [
          "^qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox\\.ts$",
          "^qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner\\.adapter\\.ts$",
          "^qa-engine/src/shared-infrastructure/process-sandbox/git-hardening\\.ts$",
          "^qa-engine/src/shared-infrastructure/process-sandbox/sandbox\\.ts$",
          "^qa-engine/src/shared-infrastructure/egress/iptables-runner\\.ts$",
          "^qa-engine/src/contexts/test-execution/infrastructure/code-execution\\.runner\\.ts$",
        ],
      },
      to: { path: "^(node:)?child_process$", dependencyTypes: ["core"], dependencyTypesNot: ["type-only"] },
    },
    {
      name: "no-fs-in-agent-browser",
      severity: "error",
      comment: "The authenticated agent browser holds the run's saved session in memory only: the cookies are handed to the browser as data and nothing it refreshes is saved. The module that hosts the browser and the one that starts it import no file API, so a refreshed cookie, a download or a profile written by the host cannot exist; what they hold arrives through their dependencies.",
      from: { path: "^qa-engine/src/contexts/test-execution/infrastructure/agent-browser/" },
      to: { path: "^(node:)?(fs|fs/promises)$", dependencyTypes: ["core"] },
    },
    {
      name: "playwright-core-only-in-agent-browser-loader",
      severity: "error",
      comment: "The orchestrator process drives a browser only through the agent-browser loader, which hands the host the few methods it uses. A second import of playwright-core would be a second way to open a page in the orchestrator, with its credentials and network, outside the route guard.",
      from: { path: "^qa-engine/src/", pathNot: "^qa-engine/src/contexts/test-execution/infrastructure/agent-browser/playwright-core\\.loader\\.ts$" },
      to: { path: "(^|/)playwright-core($|/)" },
    },
    {
      // The direction enforced here is ONE-WAY: qa-engine/src/ may never import src/ (below). The OPPOSITE
      // direction — src/ importing qa-engine/src/ — is open by design (the shell consumes the
      // engine, not the reverse) and is NOT machine-enforced by this rule; src/server/
      // run-engine-factory.ts (the composition factory) is one such importer, but not the
      // only one — src/integrations/repo-mirror.ts (MirrorProvisionAdapter),
      // src/orchestrator/sanitizer.ts, src/server/webhook-routing.ts, and src/contract/{commands,
      // events}.ts all import qa-engine/src/ deliberately too. `*-parity.
      // test.ts` files under qa-engine/test/ are also outside this rule's
      // `from` scope (qa-engine/src/ only), so none of the above ever trips this gate.
      name: "no-src-import-in-qa-engine",
      severity: "error",
      comment: "No qa-engine production module may import src/ — qa-engine stays src-free by construction. The opposite direction (src/ importing qa-engine/src/) is open by design: the shell consumes the engine, never the reverse.",
      from: { path: "^qa-engine/src/" },
      to: { path: "^src/" },
    },
    {
      name: "domain-imports-nothing-outward",
      severity: "error",
      comment: "A context's domain depends on nothing outside itself: not its own application, infrastructure or composition layers, not another context's, and not shared-infrastructure. The domain holds the rules; every layer around it depends on it, never the reverse.",
      from: { path: "^qa-engine/src/contexts/([^/]+)/domain/" },
      to: { path: "^qa-engine/src/(contexts/[^/]+/(application|infrastructure|composition)/|shared-infrastructure/)" },
    },
    {
      name: "application-not-infrastructure",
      severity: "error",
      comment: "A context's application layer reaches the outside only through ports it declares. It never imports an infrastructure adapter, of its own context or another, nor shared-infrastructure; the composition root wires adapters to ports.",
      from: { path: "^qa-engine/src/contexts/([^/]+)/application/" },
      to: { path: "^qa-engine/src/(contexts/[^/]+/infrastructure/|shared-infrastructure/)" },
    },
    {
      name: "cross-context-internals",
      severity: "error",
      comment: "A context reaches another context only through its public surface, application/index.ts. Composition roots wire contexts together by design and are exempt. Everything else of another context (domain, infrastructure, other application files) is internal.",
      from: { path: "^qa-engine/src/contexts/([^/]+)/", pathNot: "composition/" },
      to: {
        path: "^qa-engine/src/contexts/",
        pathNot: ["^qa-engine/src/contexts/$1/", "^qa-engine/src/contexts/[^/]+/application/index\\.ts$"],
      },
    },
    {
      name: "no-circular",
      severity: "error",
      comment: "A module never depends on itself through other modules: a cycle makes every module in it impossible to understand, test or move alone.",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // Repo root, regardless of the invoking cwd — see the header note above.
    baseDir: path.resolve(__dirname, ".."),
    // Use the root tsconfig (no composite flag) so the run works from the repo root.
    // The root tsconfig carries the same @kernel/@contexts/@interface path aliases as
    // qa-engine/tsconfig.json, so alias-based imports are resolved correctly.
    tsConfig: { fileName: "tsconfig.json" },
    // Include pre-compilation (type-only) imports so `import type { VcsWritePort } from ...`
    // is treated as a dependency and the gate catches structural type leaks, not just runtime ones.
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: { extensions: [".ts"] },
  },
};
