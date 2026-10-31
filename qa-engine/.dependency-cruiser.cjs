// qa-engine/.dependency-cruiser.cjs
// Structural security invariant (§8 R4): the agent is READ-ONLY on watched repos; only the
// workspace-and-publication context may import the VCS write seam. The rule is inverted: deny the
// VcsWritePort import from EVERY context path that is NOT workspace-and-publication. This is broader
// than the prior generation|agent-runtime allowlist — it covers any new context added in future plans
// without requiring a whitelist update.
//
// No exemption: the composition root lives in the shell (src/composition/engine-root.ts), outside the
// engine, so no engine module but workspace-and-publication reaches the seam.
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
const fs = require("node:fs");
const path = require("node:path");

/* Shell modules (src/, scripts/) that still import an infrastructure file of a context directly, because the symbol they need
   (an adapter the shell constructs, a registry it owns, a prompt builder a script renders) has no builder or application export yet.
   The list is frozen: it may only shrink, qa-engine/.dependency-cruiser-shell-exceptions.json holds it; qa-engine/test/arch/shell-public-surface.test.ts fails on an entry that no longer imports
   an infrastructure file and on any growth past its ceiling. A new shell module never joins it. */
/* A tree that carries a copy of this config without the list (the arch tests build such trees) has no exception. */
const EXCEPTIONS_FILE = path.join(__dirname, ".dependency-cruiser-shell-exceptions.json");
const SHELL_INFRASTRUCTURE_EXCEPTIONS = fs.existsSync(EXCEPTIONS_FILE) ? JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, "utf8")) : [];

/* The repository tooling scripts that start child processes of their own (a CI gate, the test runner, the mutation run, an operator measurement): none runs code an agent influenced. The list is frozen: it may only shrink, each entry carries its reason, qa-engine/.dependency-cruiser-tooling-spawners.json holds it and qa-engine/test/arch/exec-launcher-spawn-sites.test.ts fails on an entry that no longer imports child_process and on any growth past its ceiling. A new script that spawns is judged by whoever adds it: it goes through the launcher or it is argued onto the list. */
const TOOLING_SPAWNERS_FILE = path.join(__dirname, ".dependency-cruiser-tooling-spawners.json");
const TOOLING_SPAWNERS = fs.existsSync(TOOLING_SPAWNERS_FILE) ? Object.keys(JSON.parse(fs.readFileSync(TOOLING_SPAWNERS_FILE, "utf8"))) : [];

module.exports = {
  forbidden: [
    {
      name: "no-vcs-write-in-agent-contexts",
      severity: "error",
      comment: "The agent is read-only on watched repos; only the deterministic orchestrator writes to git. Every context other than workspace-and-publication is denied every file of workspace-and-publication (the VCS write port, adapter and domain, the GitHub PR and Issue ports and adapters, the publish policy and use case, the confinement and setup adapters, its composition) except its public index, application/index.ts. The rule is inverted so new contexts are secure by default without a whitelist update. The index is held to an allowlist of ports and types by workspace-public-surface-carries-no-write-seam.",
      from: { path: "qa-engine/src/contexts/(?!workspace-and-publication)" },
      to: { path: "contexts/workspace-and-publication", pathNot: "^qa-engine/src/contexts/workspace-and-publication/application/index\\.ts$" },
    },
    {
      name: "workspace-public-surface-carries-no-write-seam",
      severity: "error",
      comment: "The one file other contexts may import from workspace-and-publication re-exports only the run's workspace ports and the types they need, plus the write-confinement decision service and the publish decision (a pure rule from a run's verdict, review, coverage and shadow flag to what is published; it names no port and no adapter). Neither it nor any file it may reach imports anything else of the context, so an export of the VCS write port or adapter, a GitHub port, the publish policy or use case, or any infrastructure file through it, directly or through one of those files, is a violation. An allowlist, so a new file is denied until it is named here.",
      from: {
        path: [
          "^qa-engine/src/contexts/workspace-and-publication/application/index\\.ts$",
          "^qa-engine/src/contexts/workspace-and-publication/application/ports/(cleanup|confinement|publication|setup|workspace|workspace-mirror-gc)\\.port\\.ts$",
          "^qa-engine/src/contexts/workspace-and-publication/domain/(workspace-handle|confinement-result|write-confinement\\.service|publish-decision\\.service)\\.ts$",
        ],
      },
      to: {
        path: "^qa-engine/src/contexts/workspace-and-publication/",
        pathNot: [
          "^qa-engine/src/contexts/workspace-and-publication/application/ports/(cleanup|confinement|publication|setup|workspace|workspace-mirror-gc)\\.port\\.ts$",
          "^qa-engine/src/contexts/workspace-and-publication/domain/(workspace-handle|confinement-result|write-confinement\\.service|publish-decision\\.service)\\.ts$",
        ],
      },
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
      comment: "Every child process that runs code an agent influenced (a spec, a login script, the e2e project's tsc/eslint/--list and installs) starts through the execution launcher, which owns the sandbox uid, the profile's environment, the work directory and the egress lease. A module that imports child_process can start a child as the orchestrator, with its environment and its network, so the allowlist is the launcher, the generic runner for trusted binaries (git), the git hardening, and the privilege-drop module (chown), the iptables applier of the egress filter, and, in the shell, the mirror's git runner, the engine factory's hardened git calls and the boot probe that runs as the sandbox uid, and the frozen list of repository tooling scripts (each with its reason in qa-engine/.dependency-cruiser-tooling-spawners.json). Type-only imports (ChildProcess) are not a way to start anything, and the test files of the shell and of scripts/ are not production code.",
      from: {
        path: "^(qa-engine/src|src|scripts)/",
        pathNot: [
          "^qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox\\.ts$",
          "^qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner\\.adapter\\.ts$",
          "^qa-engine/src/shared-infrastructure/process-sandbox/git-hardening\\.ts$",
          "^qa-engine/src/shared-infrastructure/process-sandbox/sandbox\\.ts$",
          "^qa-engine/src/shared-infrastructure/egress/iptables-runner\\.ts$",
          "^src/composition/repo-mirror\\.ts$",
          "^src/composition/run-engine-factory\\.ts$",
          "^src/entrypoints/file-boundary-check\\.ts$",
          "^(src|scripts)/.*\\.test\\.ts$",
          ...TOOLING_SPAWNERS.map((f) => "^" + f.replace(/\./g, "\\.") + "$"),
        ],
      },
      to: { path: "^(node:)?child_process$", dependencyTypes: ["core"], dependencyTypesNot: ["type-only"] },
    },
    {
      name: "no-worker-threads-outside-the-executor",
      severity: "error",
      comment: "Work that would hold the event loop runs in a worker thread started for one call by the off-loop executor, which owns the heap limit, the typed outcomes and the end of the worker. A module that starts workers of its own would bypass them, so the allowlist is the executor and the worker-side module it serves.",
      from: {
        path: "^(qa-engine/src|src)/",
        pathNot: ["^qa-engine/src/shared-infrastructure/worker/(off-loop-executor|serve-bytes)\\.ts$"],
      },
      to: { path: "^(node:)?worker_threads$", dependencyTypes: ["core"], dependencyTypesNot: ["type-only"] },
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
      // engine, not the reverse) and is NOT machine-enforced by this rule; src/composition/
      // run-engine-factory.ts (the composition factory) is one such importer, but not the
      // only one — src/composition/repo-mirror.ts (MirrorProvisionAdapter),
      // src/telemetry/sanitizer.ts and src/entrypoints/contract/{commands,
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
      comment: "A context reaches another context only through its public surface, application/index.ts. Composition roots wire contexts together by design and are exempt. Everything else of another context (domain, infrastructure, other application files) is internal. The one other exemption is the coverage harvest's worker module, which has a rule of its own below.",
      from: { path: "^qa-engine/src/contexts/([^/]+)/", pathNot: ["composition/", "^qa-engine/src/contexts/test-execution/infrastructure/dump-sanitize\\.worker\\.ts$"] },
      to: {
        path: "^qa-engine/src/contexts/",
        pathNot: ["^qa-engine/src/contexts/$1/", "^qa-engine/src/contexts/[^/]+/application/index\\.ts$"],
      },
    },
    {
      name: "dump-worker-cross-context-import",
      severity: "error",
      comment: "A worker thread resolves no path alias, so the coverage harvest's worker module imports the pure sanitizer of objective-signal by relative path instead of through that context's public surface. That one file is the whole exemption: any other cross-context import of the worker module is internal like everywhere else.",
      from: { path: "^qa-engine/src/contexts/test-execution/infrastructure/dump-sanitize\\.worker\\.ts$" },
      to: {
        path: "^qa-engine/src/contexts/",
        pathNot: ["^qa-engine/src/contexts/test-execution/", "^qa-engine/src/contexts/[^/]+/application/index\\.ts$", "^qa-engine/src/contexts/objective-signal/domain/dump-sanitizers\\.ts$"],
      },
    },
    {
      name: "shell-public-surface",
      severity: "error",
      comment: "The shell (src/, scripts/) reaches a context only through its public surface, application/index.ts. The domain, the other application files and the infrastructure of a context are internal to it. The frozen SHELL_INFRASTRUCTURE_EXCEPTIONS list names the shell modules that still import an infrastructure file; it only shrinks.",
      from: { path: "^(src|scripts)/", pathNot: SHELL_INFRASTRUCTURE_EXCEPTIONS.map((f) => "^" + f.replace(/\./g, "\\.") + "$") },
      to: { path: "^qa-engine/src/contexts/", pathNot: ["^qa-engine/src/contexts/[^/]+/application/index\\.ts$", "^qa-engine/src/contexts/[^/]+/composition/"] },
    },
    {
      name: "composition-only-from-shell-root",
      severity: "error",
      comment: "A context's composition/ builders are imported by one module only, the engine root src/composition/engine-root.ts, which wires every context. Nothing else, shell or engine, builds a context.",
      from: { path: "^(src|scripts|qa-engine/src)/", pathNot: ["^src/composition/engine-root\\.ts$", "^qa-engine/src/contexts/([^/]+)/composition/"] },
      to: { path: "^qa-engine/src/contexts/[^/]+/composition/" },
    },
    {
      name: "no-circular",
      severity: "error",
      comment: "A module never depends on itself through other modules: a cycle makes every module in it impossible to understand, test or move alone.",
      from: { path: "^qa-engine/src/" },
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
