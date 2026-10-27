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

## Backlog

## Log

- L1 (2026-10-27) owner: "Luego explicame cómo funciona /loop y si debería definir uno en esta sesión para la rutina que llevamos haciendo de ejecutar campaña, evaluar y debuggear, corregir y repetir. Como quedaría un loop óptimo para esto, de forma que sea efectivo y no se vuelva un trabajo infinito o una serie de cambios sin control ni sentido"
- L2 (2026-10-28) owner: "Haz un flujo de forma autónoma sin parate a preguntarme, campaña de 3 replicas luego detecta los errores y busca la causa raíz, aplícalos y repite la campaña. Es importante evitar arreglar una cosa y que se rompa otra, deben ser soluciones robustas y transversales, que arreglen la causa del problema. Cuando tengas una versión buena de las replicas haz una nueva campaña con otra selección de commits. Repite el ciclo de probar, analizar, debuggear y corregir. No dependas de mi autorización, hazlo en autónomo. Si necesitas un plan importante o verificar un proceso complejo usa agentes con esfuerzo xhigh modelo opus 5.5 como revisores"
- L3 (2026-10-28) cycle 1 = campaign `validation-2026-10-27-c` (code at main 3cefe940: route-availability T18-T25 and hand-qa-gaps T1-T5); replicate 1 `run-ed28973-mvra9a3s-09df0987` running. Baseline for comparison: `validation-2026-10-27-a` (`run-ed28973-mvr4s6br-7cfce5f0`: pass, line 0.88, branch 77/132, mutants 0/3, reviewer rejected, writes refused 3, 44 min, $0.43). Earlier 3-commit runs on the same sha (2026-10-27 06:37-07:30): line 0.47-0.57, branch 46-71/130, mutants 0-1/3.
