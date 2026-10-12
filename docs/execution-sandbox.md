# Execution sandbox

Everything the pipeline runs that an agent influenced is untrusted code: the generated Playwright specs, the e2e
project's own `tsc` / `eslint` / `playwright test --list` (they import the specs), its `npm ci` (lifecycle scripts come
from an agent-editable `package.json`), the login scripts, the DOM capture (it loads a package from the project's
`node_modules`), and a code-mode repo's own install and test command. The orchestrator runs as root with the API token,
the saved sessions and the provider keys in reach, so this code must not run as the orchestrator, with its
environment, or with open network. This document is how that is enforced and how to check it.

It replaces `docs/code-mode-sandbox.md`, which covered only the code target and only the privilege drop.

## The three boundaries

| Boundary | What it stops | Where it lives |
|---|---|---|
| **Identity and environment** | Agent code running as root, or seeing the orchestrator's secrets | the launcher: `qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox.ts`, `exec-env.ts` |
| **Files** | Reading the API token, the auth material, another repo's mirror; writing the mirror it runs in | `bin/container-entrypoint.sh`, `mirror-access.ts`, `exec-workdir.ts` |
| **Network** | Exfiltrating over the network, reaching the control-plane API or other containers | `qa-engine/src/shared-infrastructure/egress/`, `bin/egress-init.sh` |

A new spawn site cannot bypass the first: `npm run arch:check` fails on any `qa-engine/src` module that imports
`child_process` outside the launcher and the modules that start only trusted binaries (git, chown, iptables).

## The launcher and its profiles

One function starts every such child: `ExecSandboxPort.spawn(cmd, args, { cwd, profile, ... })`. It always runs the child
detached, as the sandbox uid and gid (`CODE_SANDBOX_UID`, `1002` in the image), inside the run's scope.

| Profile | Used for | Environment (besides `PATH`, `LANG`, `HOME=<work dir>/home`, `TMPDIR=<work dir>/tmp`, `PLAYWRIGHT_BROWSERS_PATH`) | Network |
|---|---|---|---|
| `offline` | `tsc`, `eslint`, `playwright test --list` | nothing | none |
| `suite` | the specs, the cleanup spec, the DOM capture | `PW_*` the caller names, `PW_STORAGE_STATE` (a per-spawn copy), the client certificate (a copy) and its passphrase, `DEV_ENV_USER/PASS` (the DEV HTTP-Basic gate) | the app's origins |
| `login` | the auth setup, the login discovery | the `suite` set without a session, plus **`DEV_TEST_USER/PASS` (the test account)** | the app's origins |
| `install` | `npm ci`, a code-mode install / test / coverage, Stryker | the package-manager and toolchain variables (`npm_config_*`, `JAVA_HOME`, `GOPATH`, ...) rebased under the run's home | registries |

The environment is built from an allowlist per profile, not by removing known secrets from the orchestrator's: a secret
the orchestrator gains later is absent from every child without anyone listing it. A caller can add only the
Playwright contract (`PW_*`, `PLAYWRIGHT_JSON_OUTPUT_NAME`, `QA_FAILURE_CAPTURE_DIR`, `QA_FAULT_INJECT`).

**The account.** The test account reaches the `login` profile and nothing else, with one opt-in: an app whose flows need a
login the saved session cannot give them sets `e2e.specCredentials: account` in its config, and its suite children also get
`DEV_TEST_USER/PASS` (the account its `auth` declaration names, else the conventional pair). It is a per-app choice because a spec
that holds the account can send it to any origin the app declares; it is registered as a run secret and redacted by value.

**Work dir.** Each run gets `/tmp/qa-exec/<runId>/` (made by root, owned by the sandbox uid, `0700`, removed when the
run ends). Playwright's `--output`, the JSON report, the stream reporter, the failure dumps, the login's session file,
`TMPDIR` and **`HOME`** all live there. There is no persistent sandbox home: a toolchain cache, a shell profile or a config
file one child plants is gone with the run, so it cannot reach a later child or a later run (the price is that package
manager and toolchain caches are re-filled every run).

**Survivors.** `killTree` signals a child's process group, and a process that made its own session (a daemon, a double fork)
escapes it; it would then share the sandbox uid with the next child and could read that child's `/proc/<pid>/environ` (a
login child carries the test account). `sandbox-reaper.ts` therefore kills by uid: every process of the sandbox uid that is
not a live child of the launcher (or its descendant) is SIGKILLed when a run's scope opens, before **every** spawn, when the
last live child exits, and when the scope closes, and the call fails closed (`E-SANDBOX`, reason `residue`: the spawn is
refused, or the run does not start) if any survives. Zombies are ignored (they hold nothing). A daemon a build tool means
to keep (Gradle's) is ended too, so it is restarted by the next build. Processes of a run not started through the launcher
(operator scripts in their own process) are not in the registry, which is per process: run those only while the queue is idle. The orchestrator reads results back only through the strict readers (no link, a regular
file, under a cap), because the child can plant a link, a pipe or an oversized file under any name.

**Session.** A suite never sees the orchestrator's auth dir: each spawn gets a fresh copy of the session in the work dir,
so a spec that rewrites its session cannot change the next spawn's. A login child writes its session in the work dir's
`login/` folder; the orchestrator reads it strictly and copies a confirmed one into the auth dir (`0600`).

**Install.** `npm ci` runs as the sandbox uid with only `node_modules`, the project directory entry and the lock handed to
it; afterwards the orchestrator seals them back to `root:root`, so a package that rewrote itself during install cannot do
it again during a run.

### Modes

`QA_EXEC_SANDBOX=required|best-effort` (unset: `required` for root on Linux, so a container that forgot the variable refuses instead of running agent code as root; `best-effort` elsewhere, where there is no uid to drop to; compose sets `required`). With `required` and no
sandbox uid (not root on Linux, the image lacks the user, `CODE_SANDBOX=off`), the launcher refuses to spawn and the run
ends `infra-error` with class `E-SANDBOX` (persisted, never learned from, no Issue). With `best-effort` the child runs as the
current user and the launcher warns, loudly, once per process; use it only on a host you do not care about.

## Files

`bin/container-entrypoint.sh` runs as root at every boot, before the service:

| Path | Mode | Why |
|---|---|---|
| `/app/data` | `0700` | run history, `auth/<app>/` (session, client certificate), the suite store, learning state |
| `/app/.codebase-memory` (`CBM_CACHE_DIR`) | `0700` | the code graph of every indexed repo: the structure of repos the sandbox uid must not read |
| `/app/config`, `config/.api_token` | `0750`, `0600` | app configs and the API token. A rw bind mount: **only the mode changes, never the owner**, so a Linux host's own user keeps its access |
| mirrors volume | `0711` | traversable, not listable |
| each mirror | `0750 root:root` | closed to the sandbox uid |
| `/tmp/qa-exec` | `0711` | per-run work dirs |

The mirror a run executes in is opened to the sandbox *group* (`root:<sandbox gid>`, `0750`) when its first child starts; every
mirror is sealed again when the run's scope opens and when it ends. Files in a mirror stay root-owned and world-readable, so
the sandbox reads specs and installed packages and cannot change them. **The only place it can write is its work dir; nothing a
child writes lands in the mirror** (the mirror is read by the agent, so a writable folder in it was a channel past the egress
filter and the redaction). The suite's fixtures still write their dumps to `e2e/.qa/coverage/<namespace>` and
`e2e/.qa/fault-injection/<namespace>`: while the child runs those two paths are links, made by the orchestrator, to a folder in
the run's work dir, and once the child is gone the links are removed and only what passes the check is copied over
(`run-dump-bridge.ts`): a file name pattern, a size cap, a parse and a rebuild field by field (a coverage dump keeps a script's
url, source, executed ranges and the source map's sources, root and mappings; a counter keeps its count), written by the
orchestrator as a plain file. The set is whole or nothing, as the readers take it. The residual: a string field the readers do
use (a script's source) can still carry a payload the writer chose, in bounded size. A code-mode repo is handed to the sandbox
user entirely (a build writes into it), as before.

`/proc/1/environ` (the service's environment, with every secret) is `0400 root` and so unreadable once a child dropped to the
sandbox uid; the smoke test checks it.

## Egress

The filter holds the **sandbox uid's** network (the orchestrator itself is untouched) to the origins a run declares.

1. `bin/egress-init.sh` (boot, needs `CAP_NET_ADMIN` and `xt_owner`) creates the `QA_EGRESS` chains **already closed** and
   jumps to them from `OUTPUT` for that uid, then proves it: as the sandbox uid it must be refused at once by a public IPv4
   address, a public IPv6 address and the API on loopback. It writes `ok` or `unavailable: <why>` to
   `/run/qa-egress.status`.
2. Before a run's first child the service brings up a DNS filter and one proxy listener per declared upstream port and
   rewrites the chain, atomically (`iptables-restore --noflush`, one commit per table): the uid's `udp/53` goes to the DNS
   filter, its `tcp/<declared port>` to the proxy, the proxy and DNS listeners are accepted on loopback, **everything
   else is rejected** (TCP with a reset), IPv6 entirely.
3. The **DNS filter** forwards a declared name to the real resolver and answers `NXDOMAIN` for any other, so a name cannot
   carry data out. An AAAA question for a declared name gets an empty answer.
4. The **transparent proxy** reads the TLS server name or the HTTP `Host` header of each redirected connection (it never
   decrypts), checks it against the leases the running children hold, and opens its own connection to that **name resolved
   afresh**, not to the address the client had. No name, an unreadable handshake, or an undeclared name: reset. The
   address the name resolves to is judged before the proxy connects (`address-class.ts`): loopback only when the rule names loopback itself (DNS rebinding toward the API); this container's own interface addresses never; and any other non-public address (RFC1918, which holds the docker networks and the host gateway, link-local including the cloud metadata address, carrier-grade NAT, multicast, IPv6 unique-local, the reserved blocks) only when the app declares **that exact IP literal** on that port in `dev.allowedOrigins` (for example `http://10.1.2.3:8443`, which also authorizes a TLS name that leads there). There is no CIDR form: a network is never declared, an address is. A DEV site on the host through `host.docker.internal` therefore needs the gateway address declared.
5. A child holds a **lease** on its profile's origins for as long as it lives; with no lease held nothing is allowed.

### Declaring origins

Origins are data, in config, never in code. An origin is `scheme://host[:port]`, or `scheme://*.suffix[:port]` (subdomains
only, at least two labels, never the bare domain, and never a public suffix: a small bundled list of country second-level
registries and multi-tenant hosting domains such as `co.uk`, `github.io`, `herokuapp.com`, not the full Public Suffix List, so
declare wildcards only below names you own); no path, query or credentials; an IP literal only over plain `http`.

| Where | What it widens |
|---|---|
| `dev.baseUrl` (always) and `dev.allowedOrigins` in `config/apps/<app>.yaml` | `suite` and `login` children |
| `config/egress/registries.yaml` (groups `npm`, `maven`, `gradle`, `pip`, `go`, `cargo`) | `install` children: the e2e target uses `npm`, the code target all groups |
| `egress.installOrigins` in the app config | `install` children: a private registry or mirror |

A bad origin is refused when the config loads. A run that tries an undeclared host does not fail for it by itself: the host
is recorded in `gateSignals.sandbox.denied` (at most 64 per run), which is how the first run of an app shows what to declare.

### Modes

`QA_EGRESS_MODE=enforce|warn` (default `enforce`). With no sandbox uid there is no filter (it matches on that uid), so under `enforce` the launcher refuses to spawn (`E-SANDBOX`, reason `egress`) instead of quietly running the child unfiltered; a host without the uid sets `warn` explicitly. The "agent code runs unisolated / unfiltered" warnings are said once per process. When the filter is not active (the boot self-test did not pass, the jumps
are gone, the rules could not be applied) and the mode is `enforce`, a run that would execute agent code ends `E-SANDBOX`;
`/api/health` answers 200 with `sandbox.degraded: true` and the reason. With `warn` the child runs with the container's full
network and the run records `gateSignals.sandbox.egress = "unenforced"`.

## The `run_spec` tool

With `qa.closedLoop.enabled` (or a run's own choice) the OpenCode generator may execute a spec it wrote while it authors. The agent never runs code: the tool
(`agents/tool/run_spec.ts`) sends the session id and agent name the runtime reports, the spec's path and a title fragment to the orchestrator, which decides, runs and answers.

| Boundary | How |
|---|---|
| Who may call | only a session the agent transport bound to the generator of a live run (`ClosedLoopRegistry`); `"run_spec": false` for every other agent in `agents/opencode.json`; a Codex role has no such tool |
| Transport | `POST /internal/run-spec` on a second listener (`QA_TOOLS_PORT`, default 459) that compose does **not** publish, behind `QA_TOOLS_TOKEN` (the same value on both services, **at least 32 characters** such as `openssl rand -hex 32`; unset or shorter on the orchestrator, a random one stands in, no run is granted the tool and the boot says so; unset on the agents service only, each call is refused with a message naming the variable). The listener is bounded: 8 KB bodies, 10 s for the headers and for the body, 20 s for a whole request, at most 60 calls per session and 20 rejected authentications per address in 10 s (429 `rate-limited`). It binds to the container's one non-loopback IPv4 address when `LISTEN_HOST` is a wildcard and there is exactly one (the interface of the network shared with the agents), or to `QA_TOOLS_LISTEN_HOST` when set; Docker picks a container's address at start, so a fixed address needs a user-defined network with a fixed subnet and `ipv4_address`, and with several interfaces the wildcard stays. What Docker cannot do is let one published-nothing port be reachable by the agents alone: any other container on the same network can open it, so the token is the control. The sandbox uid cannot reach it: its loopback ports and every undeclared address are rejected by the egress chain |
| What runs | one `*.spec.ts` of the suite (never `auth.setup.ts`, never outside `e2e/`), read with the strict reader, importing its `test` from the suite's fixtures; the `suite` profile, `retries 0`, a fresh session copy, `PW_NAMESPACE=<runId>-rs<n>`, the spec selected by an exact `--test-list` file the orchestrator writes (a bare argument would be an unanchored pattern: `a.spec.ts` would also run `schema.spec.ts`), the grep escaped, then the cleanup pass of that namespace; one call at a time per run, and one holder at a time per test account (`AccountLock`) |
| Caps | calls, seconds per call (also bounded by what the run deadline has left), mutating requests to DEV; counted by the orchestrator from the per-test ledger the suite's `fixtures.ts` writes (browser requests and the `request` fixture, `page.request`, `context.request`). **The counter runs inside agent-editable code**, so a count is believed only when every test that ran left a ledger in a finished run; a missing, malformed, oversized, short or stopped-run ledger is charged as the **whole write budget that was left** (fail closed), and a spec must import `test` from the fixtures (judged on the parsed import declarations, not on text a comment satisfies). The hard bound on what a call can do to DEV does not depend on the counter: `maxCalls × perCallMs`, plus the egress filter |
| What comes back | status, how many tests passed, and **only for a failing test** (at most 20) its title (160 chars), error (2 KB), final page address (no query), the accessibility tree (8 KB) and its time to the second; the budget left. Every text passes the run's by-value redaction (each secret, and the client certificate and session file, as text and base64, base64url and hex, at the three base64 alignments) and the pattern redaction; the title, error and address then lose any long (32+) random-looking token the failure's page capture does not show (`output-token-filter.ts`, a heuristic); never raw process output |
| Session lost | a failed call that ends on the login page may renew the saved session once per run, and only by running the app's login script **as it stood when the loop opened** (the stock seed, or the verified login the suite store restored: compared by the sha256 of the bytes). A login script the agent wrote while authoring is never run (it would run with the test account in its environment); otherwise the answer carries `sessionLost: true` and a note, and the run's own login phase renews the session outside the loop |
| Ledger | each call records the sha256 of the spec's bytes read before the run; the file is hashed again after it, and a call whose file changed (or vanished) meanwhile is recorded as not passed, so the loop is never closed over bytes that did not run |
| Probes | scratch specs under `e2e/.qa-probe/` are swept after every generation and when the run ends, and are never delivered, stored or validated |

In the agents image the tool's package is installed in `/root/node_modules` (the config directory is a read-only bind mount of `./agents`). `node agents/smoke/run-spec-tool.smoke.mjs`
(run in the built agents image, see its header) proves on the pinned OpenCode build that the tool loads from the global config with project configuration disabled, is allowed for `qa-generator` alone, and is called with the real
session id, agent name and token.

Known limits: a spec that forges its own ledger can under-report its writes (the counter is its own fixtures; the call cap, the per-call time and the egress filter are what bound it); writes sent by a spec through Node's own `fetch` or a `playwright.request.newContext()` are not counted (the same bounds apply); a spec that fails to
leave DEV data the fixtures' `cleanup()` should have undone is covered by the namespace cleanup pass only if the app's `cleanup.spec.ts` handles that namespace.

## The authenticated agent browser

With `qa.agentBrowser.enabled` (or a run's own choice) the authoring roles (`qa-generator`, `qa-sidekick`) may read DEV signed in as the test account, without ever holding
the session. The agent never runs a browser: four tools (`agents/tool/authbrowser.ts`: `authbrowser_navigate`, `_snapshot`, `_click`, `_type`) send the action to the
orchestrator, which owns the browser, decides and answers. It reuses the `run_spec` mechanism (endpoint, token, session binding, account lease); it is not an MCP server, because the
Playwright MCP's own build tracks a different Playwright than the image's browsers and a general MCP would have to be pruned instead of being small by construction.

| Boundary | How |
|---|---|
| Who may call | only a session the agent transport bound to an authoring role of a live run (`AgentBrowserRegistry`); the tools are off in the global tools map and for every role but those two (`agents/opencode.json`, pinned by `agent-tool-surface.test.ts`); the Codex config names nothing of them and a Codex generator is never granted the browser |
| Transport | `POST /internal/authbrowser` on the `run_spec` listener (`QA_TOOLS_PORT`, `QA_TOOLS_TOKEN`); the body is read key by key, so an action outside the four never reaches the browser. The tools are on for the authoring roles in the config, so a prompt of an authoring session the run did **not** grant carries a per-prompt `tools` map hiding them (`openCodePromptBody`, from the registry): a run without the browser does not list four tools the orchestrator would refuse |
| The browser | Chromium started through the execution launcher (profile `suite`: the sandbox uid, the run's work dir, the egress lease of the app's origins, a `timeout` wrapper so it ends by itself), driven by `playwright-core` (pinned to the image's version, imported by one loader module only). The protocol runs over a pipe pair the browser inherits (`--remote-debugging-pipe`), behind a loopback WebSocket on a path of 32 random bytes for one client: the egress filter rejects every loopback connection of the sandbox uid, so a debugging port could not even answer the orchestrator |
| The session | read into memory from the run's auth directory (strict reader) and handed to an ephemeral context as data; never staged to the browser's process, never written by the host (`npm run arch:check` fails on a file API in the browser modules), nothing the browser refreshes is saved; a context is built from the session as it is saved *then*, so a renewed login is picked up |
| What it may request | the route guard (`agent-browser-route-guard.ts`, pure) judges **every** request of the context, subresources, redirects and web sockets included, and fails closed: scheme, then an origin the run declares (the same list the filter holds the sandbox to), then `denyRoutes` (closed to every method, in any spelling of the path), then the method: a request that writes is blocked unless an `allowMutating` entry (`[POST ]/path`) names it. Service workers are blocked (Playwright's switch plus a prototype-level stub), downloads are off, a dialog is dismissed, a tab the page opens is closed. The surface is four actions: no evaluate, no script injection, no file chooser; typing into a password field is refused |
| DEV accounting | each call holds the test account's lease (`AccountLock`, the key `run_spec` uses) for its duration; a wait longer than `leaseWaitMs` answers `DEV busy`; calls per run and time per call are capped by the orchestrator |
| Session lost | a page that ended on a login path, answered its document 401, or shows a password field on a page that was not asked for: the call errors with `session invalidated`, the auth port signs in again (twice per run at most, and only with the login script as it stood when the browser opened, same rule as `run_spec`) and the browser is reset |
| What comes back | the address without query, the title, the accessibility tree (12 KB), what the guard blocked and the calls left; every text passes the run's by-value redaction |
| Lifecycle | the capability is revoked, the browser (context, process, pipe) closed and its work dir removed when the run ends, however it ends; at boot the orchestrator ends any browser process a previous process left in the work root |

`npx tsx scripts/agent-browser-smoke.ts` proves the browser half with real Chromium against a local server, and, run in the built orchestrator image as the sandbox uid, the same checks behind the
real filter (see its header for the `--cap-add NET_ADMIN` form with `QA_SMOKE_ORIGIN`): the session reaches the page and is in no file, a form POST and a fetch POST never reach the server, a denied route and an undeclared
origin are never requested, no service worker registers, no process outlives the host. `agents/smoke/authbrowser-tool.smoke.mjs` proves the agent half on the image's pinned OpenCode: the tools load under those names,
are offered to the two authoring roles alone, reach the endpoint with the real session id, agent name and token, and a per-prompt tools map can hide them. Re-run both after a pin bump.

Known limits: the page content the agent reads (account data among it) goes to the model provider, as it does through the plain Playwright MCP; a page can still obtain a pristine `ServiceWorkerContainer` from a fresh frame, in which case a worker's own requests
are held by the egress filter and the session's rights, not by the route guard; a sidekick holds the tools, but its prompt does not describe them (an app with a login keeps the lead, so none runs where the browser exists).

### The answer of a tool is a channel

A spec runs with the saved session and, when the app opted in, the account in reach, and whatever it prints can come back in a `run_spec` answer, which a model provider then sees. Three things limit it: the answer carries little a spec chooses (no passing test's title, bounded failing titles and errors, times to the second); the secrets the run knows are removed by value in the encodings above; and a long random-looking token the page did not show is dropped. **What this does not stop**: a payload cut into pieces under 32 characters, spelled as words, encoded some other way (rot13, XOR, a hash of a guess), spread over the error messages of several calls, or carried by whether a test passed or how long it ran (a few bits per call, at most `maxCalls` calls). The mitigation is the surrounding design, not the filter: the session is a short-lived copy that dies with the run (and is renewed only with the verified login), each call gets a fresh copy, the account's password reaches a suite only for an app that opted in, the spec's own reads are bounded by the egress filter and the file permissions, and `maxCalls` bounds how many answers there can be.

## What a run records

`gateSignals.sandbox = { egress: "enforced" | "unenforced" | "not-applicable", denied: string[] }`, persisted with the outcome.
It is observation only: nothing reads it to decide a verdict. A run that granted the `run_spec` tool also records
`gateSignals.closedLoop = { calls, devWrites, closed }`; there `closed` is read back by the run to skip regenerations that repeat what the generator already saw pass.
A run that granted the authenticated browser records `gateSignals.agentBrowser = { calls, blocks, invalidations, renewals }`, persist-only; the probe report prints it.

## Operating it

After a deploy that changes this layer, restart the orchestrator (`docker compose up -d --build orchestrator`), then in
the running container:

```bash
docker compose exec orchestrator npm run sandbox:smoke
```

It seeds a throwaway project under the mirrors volume, installs it as the sandbox uid, and runs `scripts/sandbox-smoke/*.spec.ts`
through the real runner with canary secrets planted in the service's environment. Every spec passes only when the isolation
holds: `/proc/1/environ`, `/app/data`, `/app/config/.api_token` are `EACCES`; the mirror it runs in and another one cannot be
written or listed; an undeclared host, raw TCP/UDP to a public address, IPv6 and the API on loopback all fail; no secret is in
`process.env`; and the one declared origin (`QA_SMOKE_ORIGIN`, default `https://example.com`) loads in a real browser. Exit 0
only if every expected case ran and passed. `QA_SMOKE_UNDECLARED` (default `https://example.org`) is the host that must stay
unreachable.

Docker Desktop: the LinuxKit kernel carries `xt_owner` and the nft backend and the self-test and smoke pass there; on any other
host the self-test decides, never an assumption.

## Residual gaps

- **Domain fronting.** The proxy trusts the TLS server name. A declared host that is a shared CDN can front for another tenant of
  the same CDN. Declare narrow hosts.
- **`DEV_ENV_USER/PASS` are visible to the specs** (the DEV HTTP-Basic gate is a suite input); they can only be sent to declared origins.
- **Loopback is closed to the sandbox uid except the filter.** A spec or a tool that needs a TCP server on `127.0.0.1` (a local
  mock, a Playwright `webServer`) will fail; Playwright's own browser and worker channels use pipes, not TCP.
- **Third-party subresources** of an app's pages (fonts, analytics) fail until declared; the denied list names them.
- A mirror created *during* a run (a service repo cloned for a cross-repo run) is readable by the sandbox until the run's scope
  ends and seals it.
- Operator scripts that run suites outside the queue (`baseline-agent`, `campaign`) use the same launcher in their own process:
  run them only while the queue is idle, since each rewrites the egress chain for its own listeners (the service puts its own back
  at its next run).
