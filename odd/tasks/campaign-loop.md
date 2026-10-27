# campaign-loop

Objective: a bounded, self-paced loop that measures qayaba on one fixed case, fixes one root cause per cycle and stops on a defined end. Run it with `/loop` (dynamic mode, no interval) in a fresh session, following the `qayaba-campaign` skill.
Branch: main (single branch; governance changes as their own commits). Test runner: the full CI gate in AGENTS.md.

## Charter

- **Case (fixed for the whole loop):** app `name-webapp`, sha `ed28973`, 3-commit range, mode `diff`, shadow, capture `full`. The suite store is restored from its snapshot before every run (`~/.claude/skills/qayaba-campaign/scripts/suite-store.sh restore name-webapp config/benchmarks/suite-snapshots/name-webapp-zero-2026-10-27-d.json`); one replicate per cycle; a new campaign id per cycle (`loop-<n>-<date>`).
- **Target (stop with success when met on 2 consecutive cycles):**

  | Metric | Source | Target |
  |---|---|---|
  | verdict | run record | `pass` (or `flaky` with a quarantined case only) |
  | change line coverage | `gateSignals.changeCoverage` / grade `change_coverage_ratio` | ≥ 0.70 |
  | change branch coverage | `gateSignals.branchCoverage` | ≥ 0.50 |
  | real mutants killed | `gateSignals.bundleMutation` | ≥ 1 of the applied |
  | plan candidate coverage | `gateSignals.coordination` | ≥ 0.875 |
  | wall time | run record | ≤ 40 min |
  | cost | run record | ≤ $0.60 |

- **Budget (stop and report when spent, whichever comes first):** 4 cycles, or 6 hours of wall time, or $4 of run cost.

## Cycle (exactly one per loop iteration)

1. **Hypothesis.** Append a row to the ledger below: the change being measured and the metric it should move.
2. **Run.** Preflight (telemetry health, quota, the sha in the mirror), restore the snapshot, enqueue one run tagged with the cycle's campaign id. The next wake-up is the run's completion; schedule a 1800 s fallback wake-up only.
3. **Evaluate.** Record, `/evaluation`, `npm run probe-report`, Tempo/Loki only when the record is not enough. Rank findings by furthest phase; every finding carries its run id and proving field.
4. **Fix ONE root cause.** RED test → smallest transversal fix → full gate → commit naming the run id. Restart `orchestrator`/`agents` through Doppler (`doppler run -- docker compose up -d`).
5. **Report.** One short message to the owner: metrics vs the previous cycle, the finding fixed, the next hypothesis.

## Stops that hand control back to the owner (pause, ask, wait)

- A product or design decision, or a change to security, the sandbox, credentials, agent write authority or another governance-sensitive surface.
- The same finding reappears after its fix (the fix did not work: do not iterate blind).
- Any target metric regresses against the previous cycle.
- A single fix would exceed ~400 changed lines.
- An environment cause: DEV down or slow, provider quota, host sleep, egress denial (re-run once; if it repeats, stop).

## Guardrails

- One root cause per cycle; other findings are appended to the backlog below, never fixed "on the way".
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
