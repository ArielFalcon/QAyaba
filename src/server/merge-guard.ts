

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { WriteConfinementService } from "../../qa-engine/src/contexts/workspace-and-publication/domain/write-confinement.service";

/*
 * Validation + safety layers gating the maintainer's autonomous self-merge — the
 * highest-consequence path in this system: an LLM-authored fix, hot-swapped into the running
 * service and merged to main with no human in the loop unless a gate below stops it.
 *
 * The layered gates: PROTECTED_PATHS (this module) forbids an autonomous fix from rewriting the
 * recovery net, the secret boundary, or its own gate integrity; assessChange/assessRate cap an
 * autonomous fix's size and deploy frequency so a bad fix can't loop the system into
 * self-modification; a required `ci` check on main is the outer guard before merge; and the
 * canary-before-promote hot-swap (in index.ts) proves the fix healthy in the running process
 * BEFORE it is merged, with the boot-guard rollback net as the last line of defense if a swap
 * still ships something broken. Together: a rollback is always possible, an over-large/unscoped
 * rewrite is never auto-deployed, and a fix that doesn't fix cannot loop forever.
 */
export const PROTECTED_PATHS: string[] = [
  /* 1. recovery net */
  "boot-guard.mjs",
  "src/server/self-update.ts",
  "src/server/merge-guard.ts",
  /*
   * These sequence the autonomous-deploy gates themselves (the SELF_MAINTAINER_AUTOMERGE
   * kill-switch, assessChange/assessRate, performSwap/rollback, the mandatory justification
   * fields) — an autonomous fix that rewrites the maintainer runtime could silently skip its
   * own gates without ever touching merge-guard.ts, boot-guard.mjs or self-update.ts.
   */
  "src/server/maintainer-runtime.ts",
  "src/server/maintainer.ts",
  "src/server/maintainer-summary.ts",
  "src/server/maintainer-memory.ts",

  "src/orchestrator/sanitizer.ts",

  "qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts",
  /*
   * Builds the child env used to prepare an authenticated Playwright session (storageState form
   * login / PKCS#12 mTLS) — it handles credential material the same way scrub-env.ts does, so it
   * gets the same protection.
   */
  "qa-engine/src/shared-infrastructure/process-sandbox/auth-session-env.ts",
  /*
   * The adapter that actually WRITES auth material (storageState/client.p12/cert.pass) into the
   * orchestrator-only authDir — same risk class as scrub-env.ts / auth-session-env.ts above; an
   * unreviewed edit could silently redirect writes back into the agent-visible mirror.
   */
  "qa-engine/src/contexts/app-catalog/infrastructure/auth-session.adapter.ts",
  /*
   * The port contract auth-session.adapter.ts implements — an autonomous narrowing
   * (e.g. dropping a request field a caller relies on) silently disables the guard the type exists
   * to require, without touching the adapter file itself.
   */
  "qa-engine/src/contexts/app-catalog/application/ports/auth-session.port.ts",
  "qa-engine/src/contexts/app-catalog/domain/auth-session.ts",
  /*
   * Scrubs the account's credentials out of the note and log line a failed login leaves behind
   * (exact value, every spelling, before the cut). Weakening it leaks the account into the run
   * history, the logs and any Issue text. An exact entry: the helpers beside it stay editable.
   */
  "qa-engine/src/contexts/app-catalog/domain/helpers/login-evidence.ts",
  /*
   * The child that types the app's account into a login form and the runner that starts it: they
   * hold the credentials in their env, decide which page they are typed into and print what came
   * back. A directory entry, so a file added here later is protected without another line.
   */
  "qa-engine/src/contexts/app-catalog/infrastructure/login-discovery/",
  /*
   * Loads each watched app's YAML and expands its `${VARS}` from the environment, so it decides which
   * credentials and origins reach the rest of the engine. The whole app-catalog adapter directory is a
   * security-sensitive surface root; this one file has no reason to be edited autonomously.
   */
  "qa-engine/src/contexts/app-catalog/infrastructure/yaml-app-config.adapter.ts",
  /*
   * The login seed copied into every watched repo: it receives the app credentials in its env and
   * decides where the session is saved — an edit could log them or write the session back under
   * the agent-visible mirror.
   */
  "config/e2e/auth.setup.ts",
  /*
   * Decides which auth.setup.ts is the stock seed for both adapters above: setup overwrites only a
   * stock copy, and only a stock copy's failing sign-in is read as "not authored yet" instead of an
   * error. Widening it would let setup replace an app's own login and swallow its failure.
   */
  "qa-engine/src/shared-infrastructure/e2e-seed/auth-setup-seed.ts",
  /*
   * Decides the orchestrator root and the data directory (the qa-data volume the agents container
   * never mounts) that holds the web token file, per-app auth material, the history DB, the logs
   * and the coordination ledger — repointing it moves all of them into an agent-visible tree
   * without touching any file that uses them.
   */
  "src/paths.ts",
  /* Decides where operator-supplied secrets are written — repointing it moves them into a tree the
     agents container can read. */
  "src/server/env-store.ts",

  "qa-engine/src/contexts/workspace-and-publication/domain/write-confinement.service.ts",
  /*
   * The write-confinement EFFECTFUL adapter — actually runs the git restore/clean revert this
   * domain service decides on. Equally load-bearing; the domain service alone deciding correctly
   * is meaningless if this adapter's git calls are weakened.
   */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/write-confinement.adapter.ts",

  "qa-engine/src/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.ts",
  /*
   * The VcsWritePort/GitHubPrPort/GitHubIssuePort/ShadowPublicationPort interface definitions — an
   * autonomous narrowing (e.g. dropping commit()'s denyModifiedTracked param or its
   * revertedDenylisted return) silently disables the guards those types exist to require, without
   * touching the adapter files themselves.
   */
  "qa-engine/src/contexts/workspace-and-publication/application/ports/vcs-write.port.ts",
  "qa-engine/src/contexts/workspace-and-publication/application/ports/github-pr.port.ts",
  "qa-engine/src/contexts/workspace-and-publication/application/ports/github-issue.port.ts",
  "qa-engine/src/contexts/workspace-and-publication/application/ports/shadow-publication.port.ts",
  "qa-engine/src/contexts/workspace-and-publication/application/ports/mirror-gc.port.ts",
  "qa-engine/src/contexts/workspace-and-publication/domain/vcs-write.ts",

  /*
   * Composes the reviewer-facing Issue/PR body from the run's own artifacts. Deliberately NOT a
   * log dump — an earlier incident let an unsanitized raw execution log reach a public Issue
   * through this render path, bypassing the "concise, high-level account" it exists to produce.
   * An autonomous edit that starts appending unbounded/raw text here could reopen that leak even
   * though the whole-body sanitizer downstream still runs (it redacts known secret SHAPES, not
   * "is this actually a log dump").
   */
  "qa-engine/src/contexts/workspace-and-publication/domain/render-publication.ts",
  /*
   * Builds the Authorization header from GITHUB_TOKEN — the token-handling boundary for every
   * GitHub API call this context makes.
   */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/github-http.ts",
  /*
   * Clone/fetch auth-header injection (authHeaderArgs) + the tokenless-URL policy that keeps a
   * credential from being persisted in origin's URL — a credential-leak vector if weakened.
   */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/mirror-provision.adapter.ts",
  /*
   * Decides the scrubEnv() invocation (extraAllowed pattern) for the e2e install's npm lifecycle
   * scripts — an autonomous widening here leaks the orchestrator's own secrets to the WATCHED
   * repo's own (potentially attacker-influenced) install scripts.
   */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/setup.adapter.ts",
  /*
   * Decides which files of the agent-written suite outlive a run, and writes them back into the watched repo's working copy
   * through the confined writers: admitting a credential, a login session, or a login that never signed in (or following a link
   * on restore) would persist an attacker-influenced file into every later run. The login it keeps is the one that executes
   * with the test account's credentials.
   */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts",
  /*
   * The spawn primitives for the untrusted-code-execution sandbox (sandbox.ts, already protected,
   * delegates the actual spawn to these) — they receive an already-scrubbed env and run untrusted
   * agent-authored binaries; weakening the spawn/kill contract here is the same class of risk as
   * scrub-env.ts itself.
   */
  "qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.ts",

  /*
   * The ONE killTree an autonomous fix could neuter quietly (e.g. drop the process-group
   * signal, or swallow the kill and silently no-op) — the change would still compile and pass a
   * shallow test while a hung/runaway untrusted child (Playwright, npm/mvn/gradle)
   * is never actually torn down, a resource-exhaustion / hang risk the sandbox exists to prevent.
   */
  "qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter.ts",
  /*
   * The composition root — wires RedactionPortAdapter, WriteConfinementAdapter, VcsWriteAdapter,
   * CODE_PUBLISH_EXCLUDES, and every GitHub adapter. An autonomous edit here can rewire ANY security
   * port to a weaker (or fake) implementation without ever touching the port/adapter files
   * themselves — the single widest-blast-radius file in the whole security surface.
   */
  "src/server/run-engine-factory.ts",
  "src/server/engine-root.ts",
  /*
   * The test-execution builder — chooses the validation and execution strategy of a run's target. An
   * autonomous edit can route the code target to the e2e strategy (or the reverse) and run agent code
   * through the wrong sandbox profile without touching the strategies themselves.
   */
  "qa-engine/src/contexts/test-execution/composition/build-test-execution.ts",
  /*
   * The workspace-and-publication builder — the one place the VCS write seam, the publication route and the
   * handle registry that gates publication, confinement and gc are wired. An autonomous edit can route a
   * publication around the registry or drop the sanitizer without touching the adapters.
   */
  "qa-engine/src/contexts/workspace-and-publication/composition/build-workspace-and-publication.ts",
  /*
   * The agent-tools builder — decides which tool a run grants its authoring agents (run_spec, the authenticated
   * browser, the code-graph tools) and for which target. An autonomous edit can grant a tool to a code run or
   * drop the account lease without touching the adapters.
   */
  "qa-engine/src/contexts/agent-tools/composition/build-agent-tools.ts",
  /*
   * The app-catalog builder — the one place the auth session adapter, which holds the run's login material,
   * is constructed. An autonomous edit can hand the session another directory or environment without touching the adapter.
   */
  "qa-engine/src/contexts/app-catalog/composition/build-app-catalog.ts",
  /*
   * The run-orchestration builder — the one place the run's configuration block (shadow, review and coverage
   * policy, retries) and the deploy gate are fixed. An autonomous edit can turn shadow off or drop the gate
   * without touching the flow.
   */
  "qa-engine/src/contexts/run-orchestration/composition/build-run-orchestration.ts",

  "qa-engine/src/shared-kernel/ports/redaction.port.ts",
  /*
   * Pattern redaction of everything that leaves the system (diff/commit-body/reviewer-text → model,
   * logs → Issue, delegation briefs → provider) and the by-value redaction of the run's own account
   * secrets: a weakened pattern or a dropped by-value pass leaks a secret to a provider or a tracker.
   */
  "qa-engine/src/shared-infrastructure/redaction/",
  /*
   * The confined reader of every path the agent names or writes below the spec directory, the kernel port use
   * cases reach it through and the adapter that binds the two: a weakened check lets a link, a named pipe or
   * a path outside the directory be read, written or removed by the orchestrator on the agent's behalf.
   */
  "qa-engine/src/shared-infrastructure/spec-path-confinement.ts",
  "qa-engine/src/shared-infrastructure/spec-files.adapter.ts",
  "qa-engine/src/shared-kernel/ports/spec-files.port.ts",
  /* Also covered by the adapters/ prefix below; listed so narrowing that prefix cannot unprotect it. */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/publication-port.adapter.ts",
  /* The only map from a workspace handle to the mirror, the commit and the target; also covered by the adapters/ prefix below, listed so narrowing that prefix cannot unprotect it. */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/workspace-registry.ts",

  "src/server/auth.ts",
  "src/server/github-auth.ts",
  "src/server/webhook.ts",
  /*
   * The REST control-plane router — decides whether /api/auth/login and /api/auth/local ever
   * reach auth.ts/github-auth.ts at all. Those handlers being protected is meaningless if an
   * autonomous fix can silently stop routing to them (or route around them) here instead.
   */
  "src/server/api.ts",

  "qa-engine/src/contexts/generation/infrastructure/",

  "qa-engine/src/contexts/run-orchestration/infrastructure/adapters/",

  "qa-engine/src/contexts/change-analysis/infrastructure/adapters/",

  "qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/",

  "qa-engine/src/contexts/service-topology/infrastructure/adapters/",

  "qa-engine/src/contexts/cross-run-learning/infrastructure/adapters/",

  "qa-engine/src/contexts/test-execution/infrastructure/adapters/",

  "qa-engine/src/contexts/objective-signal/infrastructure/adapters/",

  "qa-engine/src/contexts/coordination/infrastructure/",

  /*
   * The ShadowPublicationPort implementation — log-only, no-ops every PR/Issue/commit/push side
   * effect when qa.shadow: true. This IS the shadow-mode safety boundary that lets a newly
   * onboarded app run the full pipeline without touching its real repo; an autonomous edit that
   * makes any of its methods actually perform the side effect defeats that boundary silently.
   */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/shadow-log.adapter.ts",

  "src/integrations/repo-mirror.ts",
  /* The supervisor inside the agents container: the env allowlist for the agent runtime it spawns and the trace context it forwards. Loosening it leaks the container's secrets to agent-authored code. */
  "agents/agent-supervisor.mjs",
  /*
   * The runtime role assignment validation and the reviewer-independence derivation the run record
   * reads — weakening either lets a misconfigured runtime start, or records a false fact about the
   * review, with no detectable failure.
   */
  "src/agent-runtime/config.ts",
  /*
   * The OpenCode agents' models and tool permissions — including the read-only boundary on watched
   * repos. Widening a role's permissions here grants the LLM write authority without touching code.
   */
  "agents/opencode.json",

  "*.test.ts",
  "*.test.mjs",
  "*_test.go",
  /*
   * What the protected tests read beside their own files — fixtures, goldens and helpers. Editing
   * one changes what a test checks without changing a protected file.
   */
  "qa-engine/test/",
  "**/__fixtures__/",
  /*
   * The test infrastructure every test run depends on: the preload that installs the
   * tracked-tree write guard, the guard itself, the web console harness and the mutation presets.
   * Weakening any of them lets a fix pass its own checks without the protected test files changing.
   */
  "test-setup.mjs",
  "scripts/test-write-guard.mjs",
  "src/server/web-console/console-harness.ts",
  "scripts/mutate.ts",
  /* Runs each mutation preset's tests and hands Stryker their exit status. */
  "scripts/run-in-group.mjs",
  /* The CI gate that keeps retired forms retired, and its allow-list: an autonomous fix must not weaken its own gate. */
  "scripts/check-previous-forms.ts",
  "scripts/previous-forms.allow.json",
  /*
   * Every TypeScript config decides what the typecheck gate (and the static gate on generated
   * specs) compiles; every dependency-cruiser config holds architecture rules such as the ban on VCS
   * writes outside workspace-and-publication. A copy added anywhere later is covered as well.
   */
  "**/tsconfig*.json",
  "**/.dependency-cruiser*",
  "src/index.ts",

  "qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner.ts",
  "qa-engine/src/contexts/test-execution/infrastructure/code-setup.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/sandbox.ts",
  /* The execution sandbox: the one launcher every child that runs agent-influenced code starts through (sandbox uid, per-profile environment allowlist, per-run work dir, egress lease), its environment builder, the work-dir and scope modules, the runner that puts it behind the collecting runner, and the composition that wires it. An autonomous fix that widened a profile's environment, dropped the uid or reopened the network would silently undo the isolation without touching any caller. */
  "qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/exec-env.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/exec-scope.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/exec-scope-provider.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/ambient-exec-scope.ts",
  "qa-engine/src/shared-kernel/ports/exec-scope.port.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/exec-workdir.ts",
  "qa-engine/src/shared-infrastructure/process-sandbox/exec-binary-runner.ts",
  /* The reaper that kills, by uid, whatever a sandboxed child left running (a daemon would share the uid with the next child and read its environment), and fails closed when something survives. */
  "qa-engine/src/shared-infrastructure/process-sandbox/sandbox-reaper.ts",
  /* Which mirror the sandbox group may traverse, and when it is closed again. */
  "qa-engine/src/shared-infrastructure/process-sandbox/mirror-access.ts",
  "src/server/exec-sandbox-factory.ts",
  /* The code-graph engine's edge: the workspace export (which files of a watched repo reach the sandbox uid, through a hardened checkout), the store cache (what one run hands the next, read back through the confined reader), the engine's command set under the graph profile, and the read-only store reader the orchestrator runs on a store the sandbox wrote. A fix that published a planted store or widened what the engine reads would cross the file boundary without touching the launcher. */
  "qa-engine/src/shared-infrastructure/code-graph/codegraph-workspace.ts",
  "qa-engine/src/shared-infrastructure/code-graph/codegraph-store-cache.ts",
  "qa-engine/src/shared-infrastructure/code-graph/codegraph-engine.ts",
  "qa-engine/src/shared-infrastructure/code-graph/codegraph-store-reader.mjs",
  /* The adapter that sequences them: it decides when a synced store is validated and published back to the cache, and which workspace a query reads. A fix that skipped the validation or published before it would hand the next run a planted store. */
  "qa-engine/src/shared-infrastructure/code-graph/codegraph-code-graph.adapter.ts",
  /* The egress filter: the policy compiler, the transparent proxy that decides on the name a connection asks for, the DNS filter, the iptables rules and their applier, the controller that holds the leases, and the wiring that reads the declared origins; plus the registries file, which is the list of package registries every install may reach. Widening any of them hands agent code a network. */
  "qa-engine/src/shared-infrastructure/egress/",
  "qa-engine/src/shared-kernel/egress-policy.ts",
  "src/server/egress-wiring.ts",
  "src/server/dns-forward.ts",
  "src/server/sandbox-health.ts",
  /* The file boundary's boot check: what the sandbox uid must see refused, the probing child that tries it as that uid, the judgment and the status the launcher refuses agent code on; plus where the API token lives, out of the host's config folder. An autonomous fix that dropped a probe or trusted a missing status would let agent code read the token or rewrite the orchestrator on a host whose filesystem does not enforce permissions. */
  "qa-engine/src/shared-infrastructure/process-sandbox/file-boundary.ts",
  "src/server/file-boundary.ts",
  "src/server/file-boundary-check.ts",
  "src/server/file-boundary-probe.mjs",
  "src/server/api-token.ts",
  "config/egress/",
  /* The container's entrypoint and the egress self-test: the file permissions that keep the sandbox uid out of the API token, the auth material and the provider keys, and the kernel filter that holds its network to the declared origins. */
  "bin/container-entrypoint.sh",
  "bin/egress-init.sh",
  /* The single definition of the git hardening (hooks, ownership, config-driven execution, git-dir trust) that repo-mirror.ts re-exports and every qa-engine git call uses. */
  "qa-engine/src/shared-infrastructure/process-sandbox/git-hardening.ts",
  /* The hardening flags themselves (hooks, fsmonitor, bare repositories): the arch gate lets only the two hardening modules import them, so no engine module can run git with the flags but without the working-copy check. */
  "qa-engine/src/shared-infrastructure/process-sandbox/git-hardening-flags.ts",
  /* The hardening for git calls with no working copy yet; the arch gate keeps the engine from importing it, so a git call on a working copy cannot slip past the git-dir check. */
  "qa-engine/src/shared-infrastructure/process-sandbox/detached-git-hardening.ts",
  /* The runners and git call sites that handle what untrusted code wrote: the check and lint runner and the mutation runner bound their child's output, the evidence scanner reads it line by line before the bound, and the git readers and the cross-repo fetch run git on a sandbox-owned working copy. */
  "qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks.ts",
  "qa-engine/src/contexts/test-execution/infrastructure/test-run-evidence.ts",
  "qa-engine/src/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts",
  "qa-engine/src/contexts/change-analysis/infrastructure/git-mirror-read.adapter.ts",
  "qa-engine/src/contexts/service-topology/application/resolve-cross-repo-impact.use-case.ts",
  /* The bounds every untrusted child's output passes through: without one, a flooding install or test run takes the orchestrator down with it. */
  "qa-engine/src/shared-kernel/process-sandbox/bounded-output-tail.ts",
  "qa-engine/src/contexts/test-execution/infrastructure/bounded-line-reader.ts",
  "qa-engine/src/shared-kernel/process-sandbox/bounded-whole-output.ts",

  "qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts",
  /* What a suite's fixtures write into the mirror's dump folders is carried over only through this adapter (the sandbox uid cannot write the mirror), and only after the checks of the two sanitizers it uses. */
  "qa-engine/src/contexts/test-execution/infrastructure/run-dump-bridge.ts",
  /* The authenticated agent browser: the route guard that decides every request its browser makes, the detector of a lost session, the capability and the call's use case, the host, launcher and DevTools bridge of the browser (which import no file API and hold the session in memory only), the sweep that ends a browser a restart left, the kernel types of its limits, the endpoint that serves its calls, and the tools and client the agents call it through. An autonomous fix that loosened any of them could let an agent write to DEV, reach a host the run does not declare or drive the browser around the guard, without touching a caller. */
  "qa-engine/src/contexts/test-execution/domain/agent-browser-route-guard.ts",
  "qa-engine/src/contexts/test-execution/domain/agent-browser-session-invalidation.ts",
  "qa-engine/src/contexts/test-execution/domain/agent-browser-capability.ts",
  "qa-engine/src/contexts/test-execution/application/agent-browser.use-case.ts",
  "qa-engine/src/contexts/test-execution/application/ports/agent-browser-host.port.ts",
  "qa-engine/src/contexts/test-execution/domain/agent-browser-host.ts",
  "qa-engine/src/contexts/test-execution/infrastructure/agent-browser/",
  "qa-engine/src/shared-infrastructure/process-sandbox/orphan-browser-sweep.ts",
  "qa-engine/src/shared-kernel/agent-browser.ts",
  /* Which session holds the browser (the registry), the adapter that serves the calls and the one place a session is renewed: the adapters/ prefix covers the last two, and they are listed so that narrowing it cannot unprotect them, like the closed-loop twins below. */
  "qa-engine/src/contexts/agent-tools/infrastructure/agent-browser-registry.ts",
  "qa-engine/src/contexts/agent-tools/infrastructure/adapters/agent-browser-port.adapter.ts",
  "qa-engine/src/contexts/agent-tools/infrastructure/adapters/agent-browser-session-material.ts",
  "qa-engine/src/contexts/agent-tools/infrastructure/adapters/trusted-session-renewal.ts",
  /* The one place a prompt's tools are decided for the runtime: the denial of writes for a read-only turn, the tools a session's run denied it, and which sessions are granted the browser. A fix that loosened it would hand a planning turn or a sidekick tools its run withheld. */
  "src/integrations/opencode-client.ts",
  "src/server/tools-endpoint.ts",
  "agents/tool/authbrowser.ts",
  "agents/lib/authbrowser-client.mjs",
  /* What an authoring agent may do against DEV and in the working copy while it writes: the lease that decides who acts on DEV and whether an action may write, the capability and the use case of run_spec (its calls, time, writes and the one spec a flow may run), the registry and the adapter that decide which session holds which loop, the tool and the client the agents call it through, and the workspace a sidekick works in with the one rule by which its files come back. An autonomous fix that loosened any of them could let a sidekick act on DEV at the same time as another action, run a spec that is not its own, or put into the suite a file its brief never named. */
  "qa-engine/src/contexts/test-execution/domain/dev-lease.ts",
  "qa-engine/src/contexts/test-execution/domain/account-lock.ts",
  "qa-engine/src/contexts/test-execution/domain/run-spec-capability.ts",
  "qa-engine/src/contexts/test-execution/application/run-spec.use-case.ts",
  "qa-engine/src/contexts/agent-tools/infrastructure/closed-loop-registry.ts",
  "qa-engine/src/contexts/agent-tools/infrastructure/adapters/closed-loop-port.adapter.ts",
  "qa-engine/src/contexts/coordination/application/ports/delegation-workspace.port.ts",
  "qa-engine/src/contexts/coordination/domain/delegation-workspace.ts",
  "qa-engine/src/contexts/coordination/infrastructure/adapters/delegation-workspace.adapter.ts",
  "agents/tool/run_spec.ts",
  /* What decides which flows a plan admits, where each may write, what each sidekick may author with and when the lead takes a change back: the plan's admission, the coordinator and the choice of tools. */
  "qa-engine/src/contexts/coordination/application/lead-plan.ts",
  "qa-engine/src/contexts/coordination/application/lead-sidekicks.ts",
  "qa-engine/src/contexts/coordination/application/sidekick-authoring.ts",
  /* What the lead's review and its routing of the reviewer's corrections may decide, and the orchestrator's facts that decide over them. */
  "qa-engine/src/contexts/coordination/application/lead-review.ts",
  "qa-engine/src/contexts/coordination/application/lead-correction.ts",
  "agents/lib/run-spec-client.mjs",
  /* What the lead may ask of the code graph and on which project: the admitted queries, the registry that binds a session, the adapter that runs the CLI on the run's project, the tool and its client. A fix that loosened them could let an agent query another app's code or run a free graph query. */
  "qa-engine/src/shared-kernel/code-graph-tools.ts",
  "qa-engine/src/contexts/agent-tools/domain/code-graph-query.ts",
  "qa-engine/src/contexts/agent-tools/infrastructure/code-graph-tool-registry.ts",
  "qa-engine/src/contexts/agent-tools/infrastructure/adapters/code-graph-tools-port.adapter.ts",
  /* Redacts the engine answer string by string and cuts it by its structure: weakening it leaks what the graph holds into the lead's prompt. */
  "qa-engine/src/contexts/agent-tools/domain/explore-answer.ts",
  "agents/tool/codegraph.ts",
  "agents/lib/codegraph-client.mjs",
  /* The spans a served call runs under and how its outcome is told: adapters/ covers them, and they are listed so that narrowing that prefix cannot unprotect them. */
  "qa-engine/src/contexts/agent-tools/infrastructure/adapters/tool-call-trace.ts",
  "qa-engine/src/contexts/agent-tools/infrastructure/adapters/tool-call-outcome.ts",
  "qa-engine/src/contexts/agent-tools/infrastructure/adapters/geolocation-port.adapter.ts",
  /* 4. build/topology the canary cannot verify (image rebuild only) */
  ".github/",
  "Dockerfile",
  "agents/Dockerfile",
  /* Decides what the image build context contains — dropping an entry can bake .env into the image. */
  ".dockerignore",
  "docker-compose.yml",
  "docker-compose.override.yml",
  "package.json",
  "package-lock.json",
];

/*
 * One repo-relative spelling for every path the gates compare: Windows separators become "/",
 * repeated slashes collapse, then leading "./" groups are stripped — in that order, so ".\\src\\x"
 * and ".//src/x" both become "src/x". Only whole "./" groups go: the dot of a dotfile path
 * (".github/", ".dockerignore") is kept.
 */
function normalizeRepoPath(file: string): string {
  const slashed = file.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return slashed.replace(/^(?:\.\/)+/, "");
}

const ANY_DEPTH = "**/";

// An ANY_DEPTH entry names a directory (trailing "/") or a file name at any depth; in a file name,
// "*" stands for any run of characters.
function matchesAtAnyDepth(f: string, name: string): boolean {
  if (name.endsWith("/")) return `/${f}`.includes(`/${name}`);
  const fileName = f.slice(f.lastIndexOf("/") + 1);
  const star = name.indexOf("*");
  return fileName.startsWith(name.slice(0, star)) && fileName.endsWith(name.slice(star + 1));
}

export function isProtectedPath(file: string): boolean {
  const f = normalizeRepoPath(file);
  return PROTECTED_PATHS.some((p) => {
    if (p.startsWith(ANY_DEPTH)) return matchesAtAnyDepth(f, p.slice(ANY_DEPTH.length));
    if (p.startsWith("*")) return f.endsWith(p.slice(1)); 
    if (p.endsWith("/")) return f.startsWith(p);  /* directory prefix */
    return f === p;  /* exact repo-relative path */
  });
}

export const SECURITY_SENSITIVE_SURFACE_ROOTS: string[] = [
  "qa-engine/src/contexts/workspace-and-publication/",
  "qa-engine/src/shared-infrastructure/process-sandbox/",
  "qa-engine/src/shared-infrastructure/egress/",
  "qa-engine/src/shared-infrastructure/redaction/",
  "qa-engine/src/contexts/generation/infrastructure/",
  "qa-engine/src/contexts/run-orchestration/infrastructure/adapters/",
  "qa-engine/src/contexts/change-analysis/infrastructure/adapters/",
  "qa-engine/src/contexts/service-topology/infrastructure/adapters/",
  "qa-engine/src/contexts/cross-run-learning/infrastructure/adapters/",
  "qa-engine/src/contexts/test-execution/infrastructure/adapters/",
  "qa-engine/src/contexts/objective-signal/infrastructure/adapters/",
  "qa-engine/src/contexts/app-catalog/infrastructure/",
  "qa-engine/src/contexts/agent-tools/infrastructure/",
  "qa-engine/src/contexts/coordination/infrastructure/",
];

/*
 * Explicit, reviewed allowlist: files under the surface roots above that are NOT security-sensitive.
 * Adding an entry here is a REVIEWED decision (same bar as adding one to PROTECTED_PATHS) — never a
 * default. Each entry states WHY it is safe to leave autonomously editable.
 */
export const NOT_SECURITY_SENSITIVE: string[] = [
  /*
   * Pure decision logic (verdict/reviewerApproved/coverageBlocks/shadow/e2eChanged -> pr|issue|
   * shadow|quarantine|noop) — no I/O, no secret handling, no git write; a regression here is caught
   * by its own heavily-covered *.test.ts (already protected by the gate-integrity group above).
   */
  "qa-engine/src/contexts/workspace-and-publication/domain/publish-decision.service.ts",
  /*
   * Thin GitHub API caller — consumes the injected github-http.ts client (which IS protected, it
   * owns the auth-header injection) and carries no credential of its own.
   */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/github-issue.adapter.ts",

  "qa-engine/src/contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts",
  /* `git gc --auto` only — no credential, no write-confinement/publish interaction. */
  "qa-engine/src/contexts/workspace-and-publication/infrastructure/mirror-gc.adapter.ts",
  /*
   * Holds the authoring location of one run (a latitude/longitude pair per scope) for the prompts and the
   * browser tool: no credential, no write, no process. The tool exposure itself is the protected
   * geolocation-port.adapter.ts.
   */
  "qa-engine/src/contexts/agent-tools/infrastructure/geolocation-registry.ts",
];

export function isSecuritySensitiveSurface(file: string): boolean {
  const f = normalizeRepoPath(file);
  return SECURITY_SENSITIVE_SURFACE_ROOTS.some((root) => f.startsWith(root));
}

export interface ChangeStat {
  files: string[];
  additions: number;
  deletions: number;
  unparsed?: string[];  /* diff-summary rows that could not be read; any one blocks the change */
}

export interface ChangeLimits {
  maxFiles: number;
  maxLines: number;  /* additions + deletions */
}

export const DEFAULT_CHANGE_LIMITS: ChangeLimits = { maxFiles: 15, maxLines: 400 };

export interface GateResult {
  ok: boolean;
  reasons: string[];  /* human-readable reasons it was blocked (empty when ok) */
}

export function assessChange(stat: ChangeStat, limits: ChangeLimits = DEFAULT_CHANGE_LIMITS): GateResult {
  const reasons: string[] = [];
  if (stat.files.length === 0) reasons.push("the fix changed no files");
  const unparsed = stat.unparsed ?? [];
  if (unparsed.length > 0) {
    reasons.push(`the diff summary holds rows the guard cannot read (human review required): ${unparsed.join(" | ")}`);
  }
  const protectedTouched = stat.files.filter(isProtectedPath);
  if (protectedTouched.length > 0) {
    reasons.push(`touches protected recovery/build files (human review required): ${protectedTouched.join(", ")}`);
  }
  if (stat.files.length > limits.maxFiles) {
    reasons.push(`changes ${stat.files.length} files, over the ${limits.maxFiles}-file limit for an autonomous fix`);
  }
  const lines = stat.additions + stat.deletions;
  if (lines > limits.maxLines) {
    reasons.push(`changes ${lines} lines, over the ${limits.maxLines}-line limit for an autonomous fix`);
  }
  return { ok: reasons.length === 0, reasons };
}

const RENAME_ARROW = " => ";

/* git's C-style path decoding (octal byte escapes to UTF-8, \" \\ \t \n …) has one owner: write
   confinement decodes the same quoting out of `git status`. */
const gitPaths = new WriteConfinementService();

/* Length of the C-quoted path `text` opens with, through its closing quote; -1 when it never closes. */
function quotedLength(text: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}

/* The path one side of a numstat path field names. git quotes every path holding `"`, `\` or a
   control character, so a side holding any must be exactly one quoted path with only escapes git
   prints — else null. */
function decodeSide(side: string): string | null {
  if (!/["\\\u0000-\u001f\u007f]/.test(side)) return side;
  if (!side.startsWith('"') || quotedLength(side) !== side.length) return null;
  try {
    return gitPaths.decodeGitPath(side);
  } catch {
    return null;
  }
}

/* A path field split into [path] or, for a rename, [old, new]; null when no single split exists.
   A quoted old side ends at its closing quote, a bare one at the first arrow — a second arrow
   leaves a bare split ambiguous. */
function renameSides(field: string): string[] | null {
  if (!field.startsWith('"')) {
    const sides = field.split(RENAME_ARROW);
    return sides.length <= 2 ? sides : null;
  }
  const end = quotedLength(field);
  if (end === field.length) return [field];
  /* An unclosed quote (-1) fails this check too: the field opens with a quote, not the arrow. */
  return field.startsWith(RENAME_ARROW, end) ? [field.slice(0, end), field.slice(end + RENAME_ARROW.length)] : null;
}

/*
 * git compacts a rename of two bare paths around their shared directory prefix and suffix as
 * `pfx{old => new}sfx`. Returns the two paths that reading names; [] when the field cannot be that
 * shape (no "{" before the arrow or no "}" after it); null when extra braces allow more than one
 * reading.
 */
function braceReading(oldSide: string, newSide: string): string[] | null {
  const [pfx, oldMid, ...moreOpen] = oldSide.split("{");
  const [newMid, sfx, ...moreClose] = newSide.split("}");
  if (oldMid === undefined || sfx === undefined) return [];
  if (moreOpen.length + moreClose.length > 0) return null;
  return [normalizeRepoPath(`${pfx}${oldMid}${sfx}`), normalizeRepoPath(`${pfx}${newMid}${sfx}`)];
}

/*
 * The repo paths a numstat path field names, or null when it fits no shape git prints. git C-quotes
 * a path holding `"`, `\`, a control character or (core.quotePath, the default) a non-ASCII byte,
 * and prints a rename as `old => new`: each whole path quoted on its own when either needs quoting,
 * otherwise brace-compacted. A brace-compacted field is also a valid plain rename of two brace-named
 * files, so both readings are returned — each side is checked whichever one git meant.
 */
function numstatPaths(field: string): string[] | null {
  const sides = renameSides(field);
  if (sides === null) return null;
  const paths = sides.map(decodeSide);
  if (!paths.every((p): p is string => p !== null)) return null;
  const [oldSide, newSide] = sides;
  /* a quoted side means git printed whole paths, never a brace-compacted pair */
  if (newSide === undefined || field.includes('"')) return paths;
  const braces = braceReading(oldSide as string, newSide);
  return braces === null ? null : [...paths, ...braces];
}

const NUMSTAT_ROW = /^(\d+|-)\t(\d+|-)\t(.+)$/;

/*
 * Parse `git diff --numstat` output into a ChangeStat. Binary files report "-" for the counts;
 * treat those as 0 lines (the file still counts toward the file limit). A row the parser cannot
 * read is kept in `unparsed`, never dropped: an unreadable row may name a protected path.
 */
export function parseNumstat(out: string): ChangeStat {
  const files: string[] = [];
  const unparsed: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const row = NUMSTAT_ROW.exec(line);
    const paths = row && numstatPaths(row[3] as string);
    if (!row || !paths) {
      unparsed.push(line);
      continue;
    }
    files.push(...paths);
    additions += row[1] === "-" ? 0 : Number(row[1]);
    deletions += row[2] === "-" ? 0 : Number(row[2]);
  }
  return { files, additions, deletions, unparsed };
}

export interface RateLimits {
  maxInWindow: number;  /* max autonomous deploys per window */
  windowMs: number;
  cooldownMs: number;  /* minimum gap between two deploys */
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  maxInWindow: 3,
  windowMs: 60 * 60 * 1000,
  cooldownMs: 5 * 60 * 1000,
};

/* Loop / rate guard: caps autonomous deploys in a sliding window and enforces a cooldown. */
export function assessRate(history: number[], now: number, limits: RateLimits = DEFAULT_RATE_LIMITS): GateResult {
  const reasons: string[] = [];
  const recent = history.filter((t) => now - t >= 0 && now - t < limits.windowMs);
  if (recent.length >= limits.maxInWindow) {
    reasons.push(`${recent.length} autonomous deploy(s) in the last ${Math.round(limits.windowMs / 60000)}min (limit ${limits.maxInWindow}) — possible self-modification loop`);
  }
  const last = history.length ? Math.max(...history) : Number.NEGATIVE_INFINITY;
  if (now - last < limits.cooldownMs) {
    reasons.push(`last autonomous deploy was ${Math.round((now - last) / 1000)}s ago (cooldown ${Math.round(limits.cooldownMs / 1000)}s)`);
  }
  return { ok: reasons.length === 0, reasons };
}

/*
 * Persisted deploy ledger (data/maintainer-deploys.json). It MUST survive restarts, because
 * a hot-swap restarts the process — without persistence the rate guard would reset every time
 * it deploys, defeating the loop protection. fs is injectable so the logic is unit-tested.
 */
export interface LedgerFs {
  read(p: string): string | null;
  write(p: string, s: string): void;
}

export const realLedgerFs: LedgerFs = {
  read: (p) => {
    try {
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    } catch {
      return null;
    }
  },
  write: (p, s) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, s);
  },
};

export function readDeployHistory(path: string, fs: LedgerFs = realLedgerFs): number[] {
  const raw = fs.read(path);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

export function recordDeploy(path: string, now: number, fs: LedgerFs = realLedgerFs, keep = 50): void {
  const hist = readDeployHistory(path, fs);
  hist.push(now);
  fs.write(path, JSON.stringify(hist.slice(-keep)));
}
