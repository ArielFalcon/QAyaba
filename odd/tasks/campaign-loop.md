# campaign-loop

Objective: a bounded, self-paced loop that measures qayaba on one fixed case, fixes one root cause per cycle and stops on a defined end. Run it with `/loop` (dynamic mode, no interval) in a fresh session, following the `qayaba-campaign` skill.
Branch: main (single branch; governance changes as their own commits). Test runner: the full CI gate in AGENTS.md.

## Charter

- **Case (fixed for the whole loop):** app `name-webapp`, sha `ed28973`, 3-commit range, mode `diff`, shadow, capture `full`. The suite store is restored from its snapshot before every run (`~/.claude/skills/qayaba-campaign/scripts/suite-store.sh restore name-webapp config/benchmarks/suite-snapshots/name-webapp-zero-2026-10-27-d.json`); **3 replicates per cycle** (one campaign id per cycle, `validation-<date>-<letter>` or `loop-<n>-<date>`, replicates 1..3, the same launch body: `"commits": 3`, `shadow`, `captureMode: full`); a cycle's fixes land only after its 3 replicates end (the orchestrator mounts the code live).
- **Target (the case is good when the median of a cycle's 3 replicates meets every row and no replicate regresses a fixed failure class; then the loop moves to a new commit selection):**

  | Metric | Source | Target |
  |---|---|---|
  | verdict | run record | `pass` (or `flaky` with a quarantined case only) |
  | change line coverage | `gateSignals.changeCoverage` / grade `change_coverage_ratio` | ≥ 0.70 |
  | change branch coverage | `gateSignals.branchCoverage` | ≥ 0.50 |
  | real mutants killed | `gateSignals.bundleMutation` | ≥ 1 of the applied |
  | plan candidate coverage | `gateSignals.coordination` | ≥ 0.875 |
  | known defect surfaced | `gateSignals.dataContradictions` / a failing case / an Issue section naming the geo collection's missing cuisine key (hand QA, `odd/tasks/hand-qa-gaps.md`) | surfaced, not normalised |
  | reviewer consistent with execution | `gateSignals.reviewer` + `reviewerCorrections` | no blocking finding a passing execution contradicts |
  | wall time | run record | ≤ 40 min |
  | cost | run record | ≤ $0.60 |

- **Budget:** no owner stop (L2). Each cycle reports proactively; a new commit selection starts when the case is good.

## Cycle (exactly one per loop iteration)

1. **Hypothesis.** Append a row to the ledger below: the change being measured and the metric it should move.
2. **Run.** Preflight (telemetry health, quota, the sha in the mirror), restore the snapshot, enqueue one run tagged with the cycle's campaign id. The next wake-up is the run's completion; schedule a 1800 s fallback wake-up only.
3. **Evaluate.** Record, `/evaluation`, `npm run probe-report`, Tempo/Loki only when the record is not enough. Rank findings by furthest phase; every finding carries its run id and proving field.
4. **Fix ONE root cause.** RED test → smallest transversal fix → full gate → commit naming the run id. Restart `orchestrator`/`agents` through Doppler (`doppler run -- docker compose up -d`).
5. **Report.** One short message to the owner: metrics vs the previous cycle, the finding fixed, the next hypothesis.

## Escalations (autonomous, L2: never wait for the owner)

- A plan for a non-trivial root cause, or the verification of a complex change: an independent reviewer agent (model opus, effort xhigh) before it lands.
- The same finding reappears after its fix: no blind iteration; an opus xhigh review of the cause before a second attempt.
- A target metric regresses against the previous cycle: find which change caused it (diff the cycles' signals, bisect by commit) before adding anything.
- Governance-sensitive changes (security, sandbox, credentials, agent write authority) ship as their own commit with an independent verifier.
- An environment cause (DEV down or slow, provider quota, host sleep, egress denial): re-run the replicate once; record it, never patch for it.

## Guardrails

- Every root cause a cycle proves is fixed before the next cycle (independent ones in parallel writers with disjoint surfaces); each fix comes with a regression test of the behaviour it must not break, and the full gate runs once over all of them. Findings without a proven cause go to the backlog.
- Transversal fixes only (golden rule); nothing tuned to name-webapp or a model. App facts go to `config/apps/` and say so in the ledger.
- A change that names a high-risk item gets its independent verifier before the next cycle.
- Never mix a mid-run edit into a measurement: fix between cycles only.

## Launch prompt

`/loop Follow odd/tasks/campaign-loop.md and the qayaba-campaign skill: run exactly one cycle per iteration, append it to the ledger, and stop as the charter says.`

## Ledger

| Cycle | Campaign id | Run id | Hypothesis | verdict | line | branch | mutants killed | candidates | wall | cost | Fix (commit) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | validation-2026-10-27-c | run-ed28973-mvra9a3s-09df0987 (r1) | hand-qa-gaps T1-T5 + route-availability T18-T25 | fail (E-EXEC-FAIL, 14/16) | n/a (red) | n/a | n/a | 3/3 flows delivered | ~36 min | | |

## Backlog

- **F1 (r1, proven): a run_spec call killed when its sidekick's session ended forfeits the flow's whole DEV-write share, and the replacement sidekick inherits it.** `run-ed28973-mvra9a3s-09df0987`: flow filter-facets' first sidekick (turn 1840+962 s) ended while its `run_spec` ran; the exec was SIGKILLed at 60.5 s, the call reported no ledger (`writesUncounted` → `chargeRunRemainder`, `run-spec.use-case.ts:220`, span `qayaba.tool.dev_writes=6 outcome=error`); the lead replaced the flow (`override_reason=session-gone`); the replacement's two calls were refused `no-writes`; its spec was delivered unproven and failed 2 cases (clicking an `aria-disabled` chip waits for enabled: `TimeoutError: locator.click`). Root cause (design review 2026-10-28): the seed writes a test's ledger only when the test finishes, so any interrupted call (session end, per-call timeout, cancel, crash, a grep matching nothing) has no count and is charged the whole run's remainder, refusing every flow, not just this one. Fix: the seed's counter (rev22) writes its ledger from the test's start and rewrites it atomically (tmp + rename) on every DEV write sent (`pending`) and answered (`writes`), with `done` at finish; the runner counts the tests that began from its own stream reporter, waits for the killed tree to exit, and charges finished `writes` plus unfinished `writes + pending`; no test began → 0; a forged, unreadable or missing ledger of a begun test → the run's remainder, unchanged. A v1 ledger reads as finished. A replacement sidekick keeps inheriting the flow's counted writes (pinned by a test). Governance (a DEV-write guard): its own commit with an independent verifier.
- **F2 (r1, proven): OpenCode sessions the run still holds disappear.** The first filter-facets sidekick's session was gone at review turn 1 (`session-gone`), and the lead's planning session at review turn 2 (`Session not found: ses_e806c2028ffe…`), so the review ended with "the flows stand as they are". Root cause (two paths, both deleting a session the run still references): (a) the orphan sweep `cleanupOrphans(maxAgeMs)` (`agent-transport-policy.ts`, every 60 s from `src/server/health-poller.ts`, threshold max(30 min, agent timeout + 5 min) in `wire-app.ts`) deletes by age since `openedAt`, so any session held past 30 min is deleted mid-run (the lead's was, at ~32 min); (b) a signal abort calls `abortSession` and `deleteSession` together, and a flow's budget expiry (`fan-out-dispatcher.ts`) aborts its signal, so the sidekick's session is deleted while OpenCode still writes its message, and `settle()` closes TIMED_OUT flows, turning the lead's `revise` into `replace`. Fix (writer in a worktree, lands after cycle 1): abort never deletes, `dispose()` is the single deleter; a timed-out flow keeps its session until the pass is released; the sweep collects only sessions idle past a threshold derived from the longest run deadline and with no prompt in flight.
- **F3 (r1, proven): the data-contradiction rule cannot see the known DEV defect.** The geo collection answers GeoJSON (`items=5 keys=[type,properties,geometry]`, the resource under `properties{id,name,slug,price,cuisineType,relevance,rating}`) while the list answers flat items with `activeMenuCuisineType`; top-level keys share nothing and even unwrapped `properties` share 4 of 16 keys (< 0.8). A threshold tweak would be one more special case: needs a design review (the consumer's declared contract, a service OpenAPI, or the frontend's own reading of the field). Design review (2026-10-28) settled it: the provider's own contract (`getRestaurantsGeoJSONByCountry` → `GeoRestaurantData`) does not declare the field either, so only the consumer states the expectation (`GeoRestaurant.activeMenuCuisineType`, read in the geo store and filter, never written; the app's runtime schema validates only the GeoJSON wrapper). Mechanism: **consumer expectation gaps** replace T4's similarity rule. A field the call site's declared response type holds, the consumer reads and never writes (a written field is client-owned) is expected; it is a gap when no complete live response of that operation carries it at any depth. Parts: nested key names in `DataShape` (names only, bounded, `complete:false` when cut); request → call site through the existing link resolver and `requestServesOperation` (extended to apps with no `services[]`); a per-language expectation extractor in the language registry (TypeScript through the compiler, unresolvable types yield no fact); the provider contract only classifies (`provider-undeclared` / `provider-declared-absent` / `no-provider-contract`). T4's publication, gate signal, pack section and reviewer citation stay, pointed at the new comparator; another operation carrying the field is context only. A T5 stub that fulfils a field the live operation lacks is listed under the gap it corroborates. Open: whether the mirror holds the frontend's dependency types (`z.infer` types need them). Large: its own feature document when cycle 1 closes.
- **F4 (proven, `run-ed28973-mvr9sbey-cb4eceda`): the deterministic DOM pre-check rejects a spec that passed on DEV.** Round 1 rejected "asserts link \"Inicio\", but the captured page at /home does not expose it" (`deterministic-review-precheck.ts:~167`, built in `review.steps.ts:~201-215`, never filtered or rebuttable, terminal at `MAX_REVIEW_ROUNDS`); the spec set a mobile viewport the Context Pack capture does not use, and `confidentWindowEnd` (`selector-check.ts:~190`) does not see `setViewportSize`. The pre-check never reads the run's execution. Fix: a spec file whose every case passed on its current bytes is proven to resolve its positive assertions, so the pre-check skips it (counted); unproven bytes keep the pre-check as it is.
- **F5 (proven, `run-ed28973-mvr4s6br-7cfce5f0`): a reviewer answer cut mid-JSON fails closed with no repair.** Span `qayaba.review.outcome=parse-miss`, output cut at 2397 chars with `approved:true` readable in the prefix; `review-port.adapter.ts:~61-160` sends one prompt and no repair turn, though AGENTS.md documents a tools-disabled contract repair for the reviewer. Fix: one tools-disabled repair turn on `parsed:false` under `REPAIR_TURN_TIMEOUT_MS`; still fail closed when the repair is unreadable.
- **Kept from r1 (signals working):** T22 token requests reported as session requests (`dev_session_requests=POST …/token ×5`, 0 writes); route availability `change-introduced` 3 (the upload routes) and `unexplained` 1; T5 4 stubbed tests in 2 spec files (they fulfil the geo collection with the cuisine field, so they cover the frontend and do not expose the backend defect); lead review turn 1 worked.

## Log

- L1 (2026-10-27) owner: "Luego explicame cómo funciona /loop y si debería definir uno en esta sesión para la rutina que llevamos haciendo de ejecutar campaña, evaluar y debuggear, corregir y repetir. Como quedaría un loop óptimo para esto, de forma que sea efectivo y no se vuelva un trabajo infinito o una serie de cambios sin control ni sentido"
- L2 (2026-10-28) owner: "Haz un flujo de forma autónoma sin parate a preguntarme, campaña de 3 replicas luego detecta los errores y busca la causa raíz, aplícalos y repite la campaña. Es importante evitar arreglar una cosa y que se rompa otra, deben ser soluciones robustas y transversales, que arreglen la causa del problema. Cuando tengas una versión buena de las replicas haz una nueva campaña con otra selección de commits. Repite el ciclo de probar, analizar, debuggear y corregir. No dependas de mi autorización, hazlo en autónomo. Si necesitas un plan importante o verificar un proceso complejo usa agentes con esfuerzo xhigh modelo opus 5.5 como revisores"
- L3 (2026-10-28) cycle 1 = campaign `validation-2026-10-27-c` (code at main 3cefe940: route-availability T18-T25 and hand-qa-gaps T1-T5); replicate 1 `run-ed28973-mvra9a3s-09df0987` running. Baseline for comparison: `validation-2026-10-27-a` (`run-ed28973-mvr4s6br-7cfce5f0`: pass, line 0.88, branch 77/132, mutants 0/3, reviewer rejected, writes refused 3, 44 min, $0.43). Earlier 3-commit runs on the same sha (2026-10-27 06:37-07:30): line 0.47-0.57, branch 46-71/130, mutants 0-1/3.
- L4 (2026-10-28) owner: "A la 1am o 2 am hora local se borran los restaurantes del entorno. Tenlo en cuenta". Every replicate is gated: no launch between 00:15 and 02:30 local, launch only when DEV lists restaurants (read-only probe of `/restaurantes/madrid`), and a replicate whose run ends on an empty DEV is ENVIRONMENT-INVALID. Replicate 2 of `validation-2026-10-27-c` waits behind that gate.
