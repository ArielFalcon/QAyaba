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

| Profile | Used for | Environment (besides `PATH`, `LANG`, `HOME=/home/sandbox`, `TMPDIR=<work dir>/tmp`, `PLAYWRIGHT_BROWSERS_PATH`) | Network |
|---|---|---|---|
| `offline` | `tsc`, `eslint`, `playwright test --list` | nothing | none |
| `suite` | the specs, the cleanup spec, the DOM capture | `PW_*` the caller names, `PW_STORAGE_STATE` (a per-spawn copy), the client certificate (a copy) and its passphrase, `DEV_ENV_USER/PASS` (the DEV HTTP-Basic gate) | the app's origins |
| `login` | the auth setup, the login discovery | the `suite` set without a session, plus **`DEV_TEST_USER/PASS` (the test account)** | the app's origins |
| `install` | `npm ci`, a code-mode install / test / coverage, Stryker | the package-manager and toolchain variables (`npm_config_*`, `JAVA_HOME`, `GOPATH`, ...) rebased under the sandbox home | registries |

The environment is built from an allowlist per profile, not by removing known secrets from the orchestrator's: a secret
the orchestrator gains later is absent from every child without anyone listing it. A caller can add only the
Playwright contract (`PW_*`, `PLAYWRIGHT_JSON_OUTPUT_NAME`, `QA_FAILURE_CAPTURE_DIR`, `QA_FAULT_INJECT`).

**The account.** The test account reaches the `login` profile and nothing else, with one opt-in: an app whose flows need a
login the saved session cannot give them sets `e2e.specCredentials: account` in its config, and its suite children also get
`DEV_TEST_USER/PASS` (the account its `auth` declaration names, else the conventional pair). It is a per-app choice because a spec
that holds the account can send it to any origin the app declares; it is registered as a run secret and redacted by value.

**Work dir.** Each run gets `/tmp/qa-exec/<runId>/` (made by root, owned by the sandbox uid, `0700`, removed when the
run ends). Playwright's `--output`, the JSON report, the stream reporter, the failure dumps, the login's session file and
`TMPDIR` all live there. The orchestrator reads results back only through the strict readers (no link, a regular
file, under a cap), because the child can plant a link, a pipe or an oversized file under any name.

**Session.** A suite never sees the orchestrator's auth dir: each spawn gets a fresh copy of the session in the work dir,
so a spec that rewrites its session cannot change the next spawn's. A login child writes its session in the work dir's
`login/` folder; the orchestrator reads it strictly and copies a confirmed one into the auth dir (`0600`).

**Install.** `npm ci` runs as the sandbox uid with only `node_modules`, the project directory entry and the lock handed to
it; afterwards the orchestrator seals them back to `root:root`, so a package that rewrote itself during install cannot do
it again during a run.

### Modes

`QA_EXEC_SANDBOX=required|best-effort` (compose: `required`; the engine's own default: `best-effort`). With `required` and no
sandbox uid (not root on Linux, the image lacks the user, `CODE_SANDBOX=off`), the launcher refuses to spawn and the run
ends `infra-error` with class `E-SANDBOX` (persisted, never learned from, no Issue). With `best-effort` the child runs as the
current user and the launcher warns, loudly, once per process; use it only on a host you do not care about.

## Files

`bin/container-entrypoint.sh` runs as root at every boot, before the service:

| Path | Mode | Why |
|---|---|---|
| `/app/data` | `0700` | run history, `auth/<app>/` (session, client certificate), the suite store, learning state |
| `/app/config`, `config/.api_token` | `0750`, `0600` | app configs and the API token. A rw bind mount: **only the mode changes, never the owner**, so a Linux host's own user keeps its access |
| mirrors volume | `0711` | traversable, not listable |
| each mirror | `0750 root:root` | closed to the sandbox uid |
| `/tmp/qa-exec` | `0711` | per-run work dirs |

The mirror a run executes in is opened to the sandbox *group* (`root:<sandbox gid>`, `0750`) when its first child starts; every
mirror is sealed again when the run's scope opens and when it ends. Files in a mirror stay root-owned and world-readable, so
the sandbox reads specs and installed packages and cannot change them. The only places it can write are its work dir and
`e2e/.qa/coverage` and `e2e/.qa/fault-injection` (the fixtures' dump folders, handed over non-recursively before a suite run).
A code-mode repo is handed to the sandbox user entirely (a build writes into it), as before.

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
   afresh**, not to the address the client had. No name, an unreadable handshake, or an undeclared name: reset. A declared
   name that re-resolves to loopback is refused unless the rule names loopback itself (DNS rebinding toward the API).
5. A child holds a **lease** on its profile's origins for as long as it lives; with no lease held nothing is allowed.

### Declaring origins

Origins are data, in config, never in code. An origin is `scheme://host[:port]`, or `scheme://*.suffix[:port]` (subdomains
only, at least two labels, never the bare domain); no path, query or credentials; an IP literal only over plain `http`.

| Where | What it widens |
|---|---|
| `dev.baseUrl` (always) and `dev.allowedOrigins` in `config/apps/<app>.yaml` | `suite` and `login` children |
| `config/egress/registries.yaml` (groups `npm`, `maven`, `gradle`, `pip`, `go`, `cargo`) | `install` children: the e2e target uses `npm`, the code target all groups |
| `egress.installOrigins` in the app config | `install` children: a private registry or mirror |

A bad origin is refused when the config loads. A run that tries an undeclared host does not fail for it by itself: the host
is recorded in `gateSignals.sandbox.denied` (at most 64 per run), which is how the first run of an app shows what to declare.

### Modes

`QA_EGRESS_MODE=enforce|warn` (default `enforce`). When the filter is not active (the boot self-test did not pass, the jumps
are gone, the rules could not be applied) and the mode is `enforce`, a run that would execute agent code ends `E-SANDBOX`;
`/api/health` answers 200 with `sandbox.degraded: true` and the reason. With `warn` the child runs with the container's full
network and the run records `gateSignals.sandbox.egress = "unenforced"`.

## What a run records

`gateSignals.sandbox = { egress: "enforced" | "unenforced" | "not-applicable", denied: string[] }`, persisted with the outcome.
It is observation only: nothing reads it to decide a verdict.

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
