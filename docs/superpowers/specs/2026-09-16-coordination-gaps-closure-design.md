# Coordination gaps closure — design

Closes the remaining multi-agent coordination gaps on top of the already-wired Fases 0–14 (`qa/multi-agent-coordination`), using the grounded-v2 doc as normative context and the current `RunQaUseCase` / `history.ts` seams as the implementation surface. **One document:** Parte A (MVP → evidence → safe active) and Parte B (ops, escalated model, durable adaptive, LeadContext expose, promotion).

**Source context:** `/Users/arielyumn/Downloads/QAyaba-multi-agent-coordination-architecture-grounded-v2.md` (Fases 11–13, §37 migration, cost §20–21, LeadContext §6.2). **Code baseline:** `qa-engine/.../application/coordination/*`, `run-qa.use-case.ts`, `composition-root.ts`, `src/server/rewritten-engine-factory.ts` (`COORDINATION_MODE`), `src/server/history.ts` (SQLite).

## Quick path

1. Implement Parte A in order (A1→A5) until shadow can emit `better`/`worse` and active is gated by durable evidence.
2. Implement Parte B (B1→B6) without reopening A invariants.
3. Keep `COORDINATION_MODE` absent/`off` as the byte-identical default until eligibility (or operator override) says otherwise.

## Locked decisions

| Topic | Decision |
|-------|----------|
| Deliverable shape | Single design + single implementation plan (MVP first, rest in same docs) |
| Shadow compare | Hybrid: deterministic proxy always; dual-path sidekick only on sample rate / allowlist |
| Evidence store | New `CoordinationEvidencePort` + SQLite table in shell (`history.ts`); do **not** widen `RunOutcome` |
| Cost | Fold existing `AgentRuntimePort` `onUsage` / `onTurn` at one infra point; Codex stays honest-null |
| Active | Honor `pre-generate` / `fix-loop-regen` only when per-app evidence passes thresholds (or explicit override) |
| Models | Capability → role/model resolution stays in infra/config; never in domain |

## Invariants (never violate)

- Shadow: canonical verdict/publication remains the current pipeline (lead path).
- FixLoop keeps retries, adjudication, selector checks, filtered retry, regression guard.
- Reviewer, publication policy, and learning semantics unchanged by coordination.
- Fail-open: sidekick / evidence / dual-path errors never invent a green verdict.
- `qa-engine` never imports `src/` (`npm run arch:check`).
- No LLM router; no second retry loop; no model names in application/domain.

## Non-goals (forever out)

- Replacing FixLoop or ReviewPort with the coordinator.
- Dual-path on 100% of shadow runs by default.
- Using the deleted legacy engine as rollback (coordination.mode is the rollback).
- Persisting full transcripts into LeadContext.

---

# Parte A — MVP (unlock evidence-gated active)

## A0 — Current state (do not re-build)

Already on branch: CoordinationPort, SidekickExecutor, advisory proposals, active points `pre-generate` + `fix-loop-regen`, FixLoop capability selection, escalation floor on `needs-lead`, in-run LeadContext, InMemory telemetry + `outcome` event, shadow classifier (`same` / `non-comparable` / `infrastructure`), adaptive file-threshold from **process-local** telemetry.

Gaps A closes: cost fold, real `better`/`worse`, durable evidence, automatic active eligibility.

## A1 — Cost proxy (Fase 11 remainder)

**Problem:** Telemetry records duration/attempts but does not fold `onUsage`/`onTurn`. Doc requires one infra cost point.

**Design:**

- Composition/factory wires a **single** usage sink into the runtime used by generation + sidekick (OpenCode path).
- Sink aggregates per `runId`: `agentCalls`, `inputTokens`, `outputTokens`, optional `cost` if provider supplies it.
- At coordination `outcome` + evidence `record`, attach `costProxy: { agentCalls, inputTokens?, outputTokens?, cost? }`.
- Codex: leave tokens/cost null; still count `agentCalls` via `onTurn` if available.

**Files (expected):** `rewritten-engine-factory.ts` / agent-runtime wiring; thin helper under `qa-engine/.../coordination/` or shell adapter; `run-qa.use-case.ts` outcome record; tests for OpenCode aggregate + Codex null.

**DoD:** One calculation site; no second token counter in coordination domain; tests green.

## A2 — Shadow proxy classifier (Fase 12 partial)

**Problem:** Delegate proposals always `non-comparable` because no sidekick result exists.

**Design:** Extend `classifyShadowDivergence` (or sibling pure function) with **deterministic** rules when dual-path did not run:

| Signal | Class |
|--------|--------|
| `infra-error` | `infrastructure` |
| proposal `direct` / `takeover` | `same` |
| proposal `delegate` + no dual-path + pipeline `pass` with `retries===0` and FixLoop never engaged | `same` (sidekick was unnecessary) |
| proposal `delegate` + no dual-path + any other pipeline verdict / retries / FixLoop | `non-comparable` |
| Dual-path ran — see A3 | `better` / `worse` / `same` / `non-comparable` |
| Insufficient signals | `non-comparable` |

Never emit `better` or `worse` from proxy-only rules. Only dual-path (A3) may produce `better`/`worse`.

**DoD:** Contract tests for each rule; no LLM.

## A3 — Dual-path sampled shadow (Fase 12 remainder)

**Problem:** Doc wants compare “current pipeline result vs coordination proposed result” for `better`/`worse`.

**Design:**

- When mode=`shadow`, proposal=`delegate`, and (`app` in allowlist **or** `random() < sampleRate`):
  1. Run lead path as today (canonical).
  2. Additionally run sidekick once (same brief shape as active pre-generate) into an isolated namespace / scratch; **do not** publish its specs.
  3. Optional: execute sidekick specs once against DEV only if cheap and safe; otherwise compare static gate + “produced usable specs” as weak signal — **prefer execute** when sample fires so `better`/`worse` means something.
  4. Classify: sidekick green + lead needed retries → `better`; both green similar cost → `same`; sidekick worse/fails → `worse`; errors → `non-comparable`.
- `sampleRate=0` and empty allowlist ⇒ dual-path off (proxy only).
- Hard cap: at most one dual-path attempt per run; fail-open on throw.

**Config (A-phase via env is enough):** `COORDINATION_SHADOW_SAMPLE_RATE`, `COORDINATION_SHADOW_ALLOWLIST` (comma apps). Parte B moves these into YAML.

**DoD:** Tests with sampleRate forced 1.0 and 0.0; canonical verdict unchanged when dual-path fails.

## A4 — Durable evidence store

**Problem:** InMemory dies on restart; adaptive/eligibility need cross-run data.

**Design:**

```ts
// qa-engine port (application)
interface CoordinationEvidencePort {
  record(row: CoordinationEvidenceRow): Promise<void>;
  summarize(app: string, opts?: { limit?: number }): Promise<CoordinationEvidenceSummary>;
}

interface CoordinationEvidenceRow {
  runId: string;
  app: string;
  mode: "shadow" | "active" | "off";
  proposalAction?: string;
  divergence?: ShadowDivergenceClass;
  finalOutcome: string;
  reviewOutcome?: string;
  dualPath: boolean;
  costProxy?: { agentCalls: number; inputTokens?: number; outputTokens?: number; cost?: number };
  at: number;
}

interface CoordinationEvidenceSummary {
  sampleSize: number;
  betterCount: number;
  worseCount: number;
  sameCount: number;
  nonComparableCount: number;
  infrastructureCount: number;
  betterRatio: number | null; // better / (better+worse+same) when denom>0
}
```

- Shell: `CREATE TABLE coordination_evidence (...)` in `history.ts` (append-only; retention aligned with run retention).
- Adapter implements the port; composition injects it when `coordinationMode` is shadow/active.
- `record` called once at end of run (alongside outcome telemetry). Fail-open on DB error.

**DoD:** Restart preserves rows; `summarize` unit-tested with fake + SQLite adapter test.

## A5 — Evidence-gated active

**Problem:** Doc: activate active only with evidence of improvement; today `active` honors both points for every run.

**Design:**

```ts
function isActivePointEligible(input: {
  mode: CoordinationMode;
  point: CoordinationActivePoint;
  summary: CoordinationEvidenceSummary;
  thresholds: { minSamples: number; minBetterRatio: number };
  operatorOverride: boolean;
}): boolean
```

- `shouldHonorActiveDelegation` / `shouldHonorFixLoopSidekick` also require eligibility (or override).
- Default thresholds (plan may tune): `minSamples=10`, `minBetterRatio=0.55` over comparable set (`better+worse+same`).
- Override: `COORDINATION_ACTIVE_OVERRIDE=true` (ops escape hatch).
- Without enough samples: active mode still **records** proposals/telemetry but does **not** replace generation (safe default).

**DoD:** Use-case test: active + empty evidence → GenerationPort only; active + summary above threshold → sidekick may run.

---

# Parte B — Full closure (same guide, after A)

## B1 — YAML `qa.coordination`

Add optional block in `config/apps/*.yaml` + `schemas.ts`:

```yaml
qa:
  coordination:
    mode: off | shadow | active   # env COORDINATION_MODE overrides when set
    shadowSampleRate: 0.1
    shadowAllowlist: []           # app names or omit for global rate
    activePoints: [pre-generate, fix-loop-regen]
    eligibility:
      minSamples: 10
      minBetterRatio: 0.55
    activeOverride: false
```

Factory merges: env > YAML > defaults. Document in operator docs (B5).

## B2 — `sidekick-escalated` model resolver (infra)

- Map stays: `lead→primary`, `sidekick-standard→worker`, `sidekick-escalated→worker` + **model from config**.
- Config surface: env `COORDINATION_ESCALATED_MODEL` and/or YAML `qa.coordination.escalatedModel` (string provider id).
- `SidekickExecutor.execute` already accepts `model?: string` — wire from composition only when capability is escalated.
- Domain still has zero model names.

## B3 — Adaptive from durable summarize

- `createCoordinationPort({ telemetry, evidence, policy })`: `signals()` prefers `deriveAdaptiveSignalsFromSummary(evidence.summarize(app))` when sample≥5; else process telemetry; else default threshold 8.
- Never bypass budgets/gates/FixLoop/authority.

## B4 — LeadContext snapshot (optional expose)

- At run end, optionally persist a **redacted** LeadContext projection on the evidence row (`leadDelegations`, `decisionActions`, `unresolvedQuestionCount`) — not full criteria text if sensitive.
- Read API: extend existing runs API or TUI digest with coordination summary fields (B5).
- Still no transcripts.

## B5 — Operator docs + TUI/API minimum

- Doc: how to set mode, sample rate, read eligibility, promote an app.
- API/TUI: show `coordination.mode`, last divergence, `betterRatio`, whether points are eligible.

## B6 — Promotion playbook

Explicit checklist in this design (copied into operator doc):

1. App runs `shadow` ≥ `minSamples` with sampleRate>0 or allowlist dual-path enough to have comparable rows.
2. `betterRatio ≥ minBetterRatio` and infra rate below agreed cap.
3. Cost proxy per successful run not worse than baseline window (A1).
4. Flip YAML/env to `active` for that app (or global with override only for experiments).
5. Watch first N active runs; rollback = `mode: shadow` or `off`.

---

# Error handling

| Failure | Behavior |
|---------|----------|
| Dual-path sidekick throws | Log loud; divergence `non-comparable`; canonical path unchanged |
| Evidence `record` throws | Log loud; run completes; eligibility unchanged (no fabricated rows) |
| Usage sink missing (Codex) | `costProxy` partial/null; still record outcome |
| Active without eligibility | Proposals recorded; points not honored |

# Testing strategy

- Contract tests for classifier rules and eligibility pure functions.
- Use-case tests: shadow sample 0/1; active gated; fail-open dual-path.
- Adapter test: SQLite evidence round-trip (Node 22 + better-sqlite3).
- Cost: OpenCode fake emits usage; Codex path null tokens.
- Parte B: schema parse; escalated model reaches `openSession` opts; adaptive uses summarize.

# Rollback

- `COORDINATION_MODE=off` / omit → no ports → pre-feature behavior.
- Drop or ignore `coordination_evidence` table without affecting QA verdicts.
- Disable dual-path via `sampleRate=0`.

# Implementation order (for the plan doc)

```text
A1 cost → A2 proxy classifier → A3 dual-path sample → A4 SQLite evidence → A5 active gate
B1 YAML → B2 escalated model → B3 adaptive durable → B4 LeadContext snapshot → B5 docs/API → B6 promotion checklist in docs
```

Each slice: tests first, minimal code, commit as work unit.

---

## Checklist (reader)

- [ ] Understands Parte A unlocks evidence-gated active without changing FixLoop/reviewer.
- [ ] Understands shadow hybrid (proxy + sampled dual-path) and that canonical verdict stays lead.
- [ ] Knows evidence lives in SQLite via a qa-engine port, not inside `RunOutcome`.
- [ ] Sees Parte B as same guide, ordered after A, including YAML, escalated model, docs, promotion.

## Next step

Write `docs/superpowers/plans/2026-09-16-coordination-gaps-closure.md` (implementation plan, task checkboxes) and execute task-by-task when requested.
