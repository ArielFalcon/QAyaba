# ADR-0008: The served version comes from the product

- **Status:** Accepted, 2026-10-28, owner
- **Decision source:** D9. On 2026-10-28 (15:32Z) the owner approved the recommendations D1-D13 together: "Regarding the 13 recommendations I agree with everything" (translated). The D9 recommendation the owner approved: a version source in the product (a git commit id on Spring services, a build-stamped version in the Angular build), a precondition of learning, and qayaba records "version unknown" until then. The two examples are the ones in that recommendation. Supporting words, 2026-10-28 13:36Z (translated): "Qayaba is an E2E testing engine that is agnostic to the app it tests ... it was decided to build it mainly for JavaScript with the Angular framework and for Java with Spring ... But these are implementations of its corresponding ports, which lets qayaba be scalable and flexible."
- **Code references at 4105c582:**
  - Gate seam and adapters: `qa-engine/src/shared-kernel/ports/deploy-gate.port.ts:7-9`, `qa-engine/src/contexts/run-orchestration/infrastructure/adapters/deploy-gate-port.adapter.ts:9`, `:21-36`, `:38-43`, `qa-engine/src/contexts/run-orchestration/composition/build-run-orchestration.ts:45-61`
  - Where the gate runs and what a failure does: `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/opening.steps.ts:15-36`, `qa-engine/src/contexts/run-orchestration/application/run-flow/run-end.ts:120`, `:128`
  - The only version reader today: `src/server/run-engine-factory.ts:290-298`, `:1423-1454`, `qa-engine/src/shared-kernel/sha.ts:34-43`
  - What an app declares: `src/orchestrator/schemas.ts:111`, `:125`, `config/apps/example.yaml:89-92`
  - Learning gate input (no version fact): `qa-engine/src/contexts/cross-run-learning/domain/learning-gates.ts:13-22`
  - Docs: `AGENTS.md:126`, `docs/observability-design.md:249`, `docs/observability-context.md:79`, `docs/efficiency-benchmark.md:322-323`
- **Related:** [ADR-0001](0001-design-pillars.md), [ADR-0003](0003-learning-layer-rebuild.md), [ADR-0011](0011-root-cause-fix-policy.md), [RFC-0001](../rfc/0001-dormant-features.md)

**In one line:** the product tells qayaba which commit its DEV serves; qayaba never infers it, and records "version unknown" until the product does (Correction 2026-10-29: "version unknown" is not a state of the closed set accepted in RFC-0001 OD-10 (`undeclared`, `unreadable`, `equal`, `behind`, `ahead`, `unrelated`). Read it as `undeclared`: no source is declared. A declared source that cannot be read is `unreadable`, with a typed reason.).

## Context

qayaba asks one question about DEV before it spends tokens: does DEV serve the commit under test? The answer today is a boolean that only some products can give, and the engine records nothing about it.

| Situation | What the code does | Where |
|---|---|---|
| App declares no version source | A gate that answers ok at once; nothing is recorded | `build-run-orchestration.ts:45-52`, `deploy-gate-port.adapter.ts:38-43` |
| Source declared, but unreadable (non-2xx, timeout, body that is not JSON) | `fetchVersion` returns null, the poll answers "not serving", the gate waits to its timeout, then the run ends `infra-error` (`deploy-gate-failed`); that end saves no run outcome, publishes nothing and teaches nothing | `run-engine-factory.ts:290-298`, `:1428-1433`, `deploy-gate-port.adapter.ts:27-35`, `run-end.ts:128` |
| Source declared, serves another commit | The same "not serving" answer as the row above | `sha.ts:35-43` (equal, or a prefix of at least 7 characters) |
| Source declared, serves this commit and reports healthy | ok; nothing is recorded | `opening.steps.ts:15-20` |

What follows from it, each point checked at 4105c582:

1. **One shape, one reader.** A declared source must answer `{ sha, healthy }` (`config/apps/example.yaml:89-92`), read by one bare GET with no headers (`run-engine-factory.ts:290-298`). The seam is a boolean poll (`deploy-gate-port.adapter.ts:9`), so the engine cannot tell "no source", "unreadable" and "another commit" apart: the first passes silently, the other two fail the same way.
2. **Nothing is recorded.** The gate step returns nothing when it passes (`opening.steps.ts:15-20`). The span attribute the design names, "deploy verified | unverified | skipped-no-version-url" (`docs/observability-design.md:249`), is set by no code: searching for those terms and for a served-version field finds documentation only.
3. **No app declares a source.** In the five app configs of the running orchestrator on 2026-10-28 none has an active `versionUrl` (three carry a comment saying the gate is skipped; the files are the owner's data, outside the repository). The docs say the same for name-webapp, the one app every analyzed run tested (`docs/observability-context.md:79`, `docs/efficiency-benchmark.md:322-323`). The history database holds 34 runs, all of name-webapp, so the gate is skipped for all of them (hypothesis for runs before 2026-10-28: the config did not differ earlier).
4. **Runs replay one commit against a live DEV.** The baseline (run-ed28973-mvs7oo0f-17041c71, main 4105c582) and the three replicates of cycle 3 (run-ed28973-mvs0onsn-6ad17f30, run-ed28973-mvs2ukug-c82da7be, run-ed28973-mvs49h5y-acdab309, 40513c1e) all ran sha ed28973 against whatever DEV served at that time. The run records do not say which build that was, so an outcome, and any lesson drawn from it, presumes DEV served the change.
5. **One observed miss.** A 2026-10-24 run (mvmtsugu, sha 40371fa) ended with the note "DEV is not running this commit": the lead declined both flows after 845 s of generation and 68 DEV writes, with nothing delivered (from the investigation's map of historical runs; the record is no longer in the history database). Why the gate did not wait for it is not established; hypothesis: no `versionUrl`.

**Why the product.** DEV content does not say which commit built it; the product's build does. Anything qayaba infers instead (a hash of the served bundle, response headers, dates compared with git) is a heuristic per framework, tuned on the app that showed the problem. That is what the pillar "app-agnostic through ports" rules out: app specifics live only behind a port ([ADR-0001](0001-design-pillars.md), P4).

**What this does not explain.** It is not the cause of a failure family. The investigation refuted the run-induced-conditions hypothesis (H03) as a single cause, and the stale-deployment run above is one occurrence. The reason to decide now is learning: a lesson is tied to the commit a run observed, and with no served version that tie is an assumption. The learning gates read no version fact today (`learning-gates.ts:13-22`).

## Decision

| # | Decided |
|---|---|
| 1 | The served version of the app under test comes from the product. qayaba does not infer it. |
| 2 | The app declares where its served version is read, for the primary repository and for each service. One port implementation per framework or backend kind turns what that product serves into one typed answer; the engine knows only the port. The examples named in the approved recommendation: a git commit id reported by a Spring service, a version stamped into an Angular build. |
| 3 | Until an app provides a version source, qayaba records "version unknown" for its runs. It does not report the deploy gate as verified, and it does not infer. |
| 4 | A known served version is a precondition of learning ([ADR-0003](0003-learning-layer-rebuild.md)). |
| 5 | It is also the precondition for the deploy gate to be a served-version fact on every run, in place of today's silent skip ([RFC-0001](../rfc/0001-dormant-features.md) gives the shape). |

The version source is a change in the product, which only its owner can make. qayaba's side is the port, the declaration and the record.

**Not decided here** (left to the RFCs named; decided 2026-10-28 as recommended, [ADR-0013](0013-owner-decisions-remaining-questions.md)):

- The closed set of states and the field that records them, for example whether a known version that differs from the run's sha is a state of its own (RFC-0001).
- Whether the learning precondition applies per run or per app (ADR-0003, RFC-0001).
- Whether the gate keeps waiting for the commit on a deploy-triggered run and only records on a replay (RFC-0001).
- The declaration's config format, and which port implementations ship first. (Correction 2026-10-29: no answer existed; recommended in [ADR-0013](0013-owner-decisions-remaining-questions.md), "Correction 2026-10-29": extend `versionUrl`, one reader first; decided when T19 lands.)

## Consequences

- Every run carries a served-version fact. For every app today it reads "version unknown": a typed fact in place of silence. Runs are not blocked by it.
- A lesson can only come from a run whose served version is known; whether the precondition is checked per run or per app is left to [ADR-0003](0003-learning-layer-rebuild.md). Either way, for name-webapp and its services it needs a product change by the owner, which puts that change on the critical path of the first lesson kind (D4).
- The baseline and every later replicate run against a DEV whose served build the run records do not say. A before/after pair ([ADR-0011](0011-root-cause-fix-policy.md)) compares qayaba against whatever DEV served at each time and says nothing about which build of the product it ran, until the product provides a version source.
- The declaration replaces or extends `dev.versionUrl` and `services[].versionUrl` (`src/orchestrator/schemas.ts:111`, `:125`). That is a config-format change, so it ships on its own; the app configs are the owner's data.
- Today's `{ sha, healthy }` poll (`run-engine-factory.ts:1428-1433`) becomes the first port implementation, not the contract.

## Enforcement

Not enforced yet. What will hold it, each named by the change that adds it:

- A test through the engine's public seam (the run use case with a fake gate port): an app with no declared source ends with the served-version fact "unknown", never a silent ok. Added by the standalone served-version change that the investigation's audit places before the learning slice ([RFC-0001](../rfc/0001-dormant-features.md)).
- A learning-gate test: a run without a known served version yields no lesson input, with the reason recorded (D14). Added by the learning slice ([ADR-0003](0003-learning-layer-rebuild.md)).

Until those land, nothing holds this decision.

## Alternatives considered

| Alternative | Why it is not the decision |
|---|---|
| Infer the version from the DEV site (bundle hash, headers, dates against git) | No ground truth. A heuristic per framework, shaped by the app that exposed the problem; against the app-agnostic pillar. |
| Keep the optional `{ sha, healthy }` endpoint as the only shape | One shape every product must build for qayaba. No configured app has built it (point 3), and the gate would still collapse "no source", "unreadable" and "another commit". As one port implementation among several it stays. |
| Require a version and refuse runs without one | Every app would stop today, none declares one. The approved decision records "version unknown" until the product provides it. |
| Leave the gate skipped silently | Keeps "every outcome, and any lesson, assumes DEV served the change" unrecorded. |
