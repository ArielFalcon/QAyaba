# Coordination Gaps Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close remaining multi-agent coordination gaps so shadow can produce evidence (`better`/`worse` via sampled dual-path) and active points are honored only when durable per-app evidence passes thresholds — then finish ops/YAML/escalated-model/docs in the same guide.

**Architecture:** Keep Fases 0–14 seams. Add cost fold from `AgentRuntimePort` usage sinks, extend shadow classification + sampled dual-path, persist rows via new `CoordinationEvidencePort` → SQLite in `src/server/history.ts`, gate `shouldHonor*` on eligibility. Parte B adds YAML, escalated model wiring, durable adaptive signals, LeadContext snapshot, operator docs/API.

**Tech Stack:** TypeScript / `tsx`, `node:test`, better-sqlite3 (`history.ts`), existing qa-engine hexagonal ports, Doppler/env + optional YAML.

**Spec:** `docs/superpowers/specs/2026-09-16-coordination-gaps-closure-design.md`

## Global Constraints

- `qa-engine` never imports `src/` (`npm run arch:check`).
- Shadow never changes canonical verdict/publication.
- FixLoop / ReviewPort / publish / learning semantics unchanged.
- Fail-open everywhere; no fabricated eligibility rows.
- No model names in domain/application coordination modules.
- Node 22.12.0 for tests touching better-sqlite3.
- Work-unit commits; tests with code; Conventional Commits `feat(qa):` / `fix(qa):` / `docs(qa):`.
- Default `COORDINATION_MODE` absent/off remains byte-identical.

## File map

| Path | Responsibility |
|------|----------------|
| `qa-engine/.../coordination/shadow-divergence.ts` | Pure classifier (proxy + dual-path inputs) |
| `qa-engine/.../coordination/coordination-evidence.ts` | Row/summary types + `isActivePointEligible` |
| `qa-engine/.../ports/coordination-evidence.port.ts` | Port interface |
| `qa-engine/.../coordination/cost-proxy.ts` | Aggregate usage snapshots → costProxy shape |
| `src/server/history.ts` | `coordination_evidence` table + CRUD |
| `src/server/coordination-evidence-sqlite.adapter.ts` | Implements port (shell) |
| `run-qa.use-case.ts` | Wire cost, dual-path sample, record evidence, eligibility |
| `composition-root.ts` / `rewritten-engine-factory.ts` | Wire ports, env/YAML, usage sink, escalated model |
| `src/orchestrator/schemas.ts` | Parte B `qa.coordination` |
| `docs/coordination-operator.md` | Parte B operator guide |

---

### Task 1: A1 — Cost proxy helper + contract tests

**Files:**
- Create: `qa-engine/src/contexts/qa-run-orchestration/application/coordination/cost-proxy.ts`
- Modify: `qa-engine/src/contexts/qa-run-orchestration/application/coordination/index.ts`
- Test: `qa-engine/test/contract/coordination-cost-proxy.contract.test.ts`

**Interfaces:**
- Produces: `CostProxy`, `createCostProxyAccumulator()`, `CostProxyAccumulator.recordUsage(UsageSnapshot)`, `.recordTurn()`, `.snapshot()`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCostProxyAccumulator } from "@contexts/qa-run-orchestration/application/coordination/index.ts";

test("accumulator sums OpenCode usage and counts turns", () => {
  const acc = createCostProxyAccumulator();
  acc.recordTurn();
  acc.recordUsage({ inputTokens: 10, outputTokens: 5, provider: "opencode" });
  acc.recordTurn();
  acc.recordUsage({ inputTokens: 3, outputTokens: 2, provider: "opencode" });
  assert.deepEqual(acc.snapshot(), {
    agentCalls: 2,
    inputTokens: 13,
    outputTokens: 7,
  });
});

test("snapshot omits tokens when never recorded (Codex-honest)", () => {
  const acc = createCostProxyAccumulator();
  acc.recordTurn();
  assert.deepEqual(acc.snapshot(), { agentCalls: 1 });
});
```

- [ ] **Step 2: Run test — expect FAIL (module missing)**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22.12.0
node --import tsx --test qa-engine/test/contract/coordination-cost-proxy.contract.test.ts
```

- [ ] **Step 3: Implement `cost-proxy.ts` and export from `index.ts`**

```ts
export interface CostProxy {
  readonly agentCalls: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cost?: number;
}

export interface CostProxyAccumulator {
  recordTurn(): void;
  recordUsage(u: { inputTokens: number; outputTokens: number }): void;
  snapshot(): CostProxy;
}

export function createCostProxyAccumulator(): CostProxyAccumulator {
  let agentCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  return {
    recordTurn() { agentCalls += 1; },
    recordUsage(u) {
      sawUsage = true;
      inputTokens += u.inputTokens;
      outputTokens += u.outputTokens;
    },
    snapshot() {
      return sawUsage
        ? { agentCalls, inputTokens, outputTokens }
        : { agentCalls };
    },
  };
}
```

- [ ] **Step 4: Re-run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add qa-engine/src/contexts/qa-run-orchestration/application/coordination/cost-proxy.ts \
  qa-engine/src/contexts/qa-run-orchestration/application/coordination/index.ts \
  qa-engine/test/contract/coordination-cost-proxy.contract.test.ts
git commit -m "$(cat <<'EOF'
feat(qa): add coordination cost proxy accumulator

Fold AgentRuntime usage/turns into one CostProxy shape without a second
token counter in the coordination domain.
EOF
)"
```

---

### Task 2: A1 — Wire cost accumulator into RunQaUseCase outcome

**Files:**
- Modify: `qa-engine/.../run-qa.use-case.ts` (deps + outcome telemetry)
- Modify: `qa-engine/.../composition/composition-root.ts` and/or `src/server/rewritten-engine-factory.ts` to inject optional `coordinationCost?: CostProxyAccumulator` **or** create accumulator inside use-case when coordination is wired
- Test: extend `coordination-shadow.use-case.test.ts` to assert `outcome` can carry cost fields once deps expose accumulator

**Interfaces:**
- Consumes: `createCostProxyAccumulator`
- Produces: outcome telemetry event includes optional `costProxy` via extending `CoordinationTelemetryEvent` **or** evidence row later (Task 5). Prefer extend telemetry event:

```ts
readonly costProxy?: CostProxy;
```

- [ ] **Step 1: Extend `CoordinationTelemetryEvent` with optional `costProxy?: CostProxy`**

- [ ] **Step 2: In `RunQaUseCase`, when coordination is wired, `const costAcc = createCostProxyAccumulator()` and pass `onTurn`/`onUsage` into sidekick execute opts if runtime supports them; on outcome record attach `costProxy: costAcc.snapshot()`**

Note: If factory does not yet forward usage into sidekick sessions, wire accumulator increments at known call sites (each `sidekick.execute`, each `generation.generate` as `recordTurn()` minimum) so agentCalls≥1 without inventing tokens.

- [ ] **Step 3: Test shadow use-case: `outcome` event has `costProxy.agentCalls >= 1`**

- [ ] **Step 4: `npm run typecheck` + coordination tests PASS**

- [ ] **Step 5: Commit** `feat(qa): attach cost proxy to coordination outcome telemetry`

---

### Task 3: A2 — Expand shadow proxy classifier

**Files:**
- Modify: `qa-engine/.../coordination/shadow-divergence.ts`
- Modify: `qa-engine/test/contract/coordination-phases-5-14.contract.test.ts` (or dedicated `coordination-shadow-divergence.contract.test.ts`)

**Interfaces:**
- Replace/extend:

```ts
export function classifyShadowDivergence(input: {
  mode: CoordinationMode;
  proposal: CoordinationDecision | undefined;
  pipelineVerdict: string;
  retries?: number;
  fixLoopEngaged?: boolean;
  dualPath?: {
    ran: boolean;
    sidekickVerdict?: string;
    sidekickUsableSpecs?: boolean;
    error?: boolean;
  };
}): ShadowDivergenceClass | undefined
```

- [ ] **Step 1: Write failing tests for rules in the spec (direct→same; delegate+pass+retries0+no fixloop→same; delegate+pass+retries>0→non-comparable; infra→infrastructure; dualPath better/worse)**

- [ ] **Step 2: Implement classifier; never `better`/`worse` without `dualPath.ran`**

- [ ] **Step 3: Update `run-qa.use-case.ts` call site to pass `retries` and whether FixLoop ran**

- [ ] **Step 4: Tests PASS + commit** `feat(qa): expand shadow divergence proxy rules`

---

### Task 4: A3 — Sampled dual-path in shadow

**Files:**
- Modify: `RunQaUseCaseDeps` with optional `coordinationShadowSampleRate?: number`, `coordinationShadowAllowlist?: readonly string[]`
- Modify: `run-qa.use-case.ts` shadow branch after lead path completes generation… **dual-path must not replace lead specs**. Practical placement: after `decide()` or after execute, if shadow+delegate+sample, run sidekick in isolation and classify with `dualPath`.
- Modify: factory to read `COORDINATION_SHADOW_SAMPLE_RATE` (float 0–1, default 0) and `COORDINATION_SHADOW_ALLOWLIST`
- Test: `coordination-shadow.use-case.test.ts`

**Algorithm:**

```ts
function shouldRunDualPath(app: string, rate: number, allowlist: readonly string[], proposalAction: string): boolean {
  if (proposalAction !== "delegate") return false;
  if (allowlist.includes(app)) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}
```

Inject `Math.random` via deps `random?: () => number` for tests (`() => 0` / `() => 0.99`).

- [ ] **Step 1: Failing test — sample forced on → dualPath classification can be `better` when sidekick usable and lead had retries; canonical verdict still from lead**

- [ ] **Step 2: Implement dual-path block fail-open; do not publish sidekick files**

- [ ] **Step 3: Test sample off → no sidekick in shadow**

- [ ] **Step 4: Commit** `feat(qa): add sampled shadow dual-path for better/worse`

---

### Task 5: A4 — CoordinationEvidencePort + SQLite

**Files:**
- Create: `qa-engine/.../application/coordination/coordination-evidence.ts` (types + summarize pure helper from rows)
- Create: `qa-engine/.../application/ports/coordination-evidence.port.ts`
- Create: `src/server/coordination-evidence-sqlite.adapter.ts`
- Modify: `src/server/history.ts` — create table + statements
- Modify: composition + factory to inject adapter when coordination on
- Modify: `run-qa.use-case.ts` — `await evidence.record(...)` at end (fail-open)
- Test: contract summarize; adapter SQLite test under `src/server/` or qa-engine with injected fake

**Table:**

```sql
CREATE TABLE IF NOT EXISTS coordination_evidence (
  run_id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  mode TEXT NOT NULL,
  proposal_action TEXT,
  divergence TEXT,
  final_outcome TEXT NOT NULL,
  review_outcome TEXT,
  dual_path INTEGER NOT NULL DEFAULT 0,
  cost_proxy TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coordination_evidence_app_at
  ON coordination_evidence(app, at DESC);
```

- [ ] **Step 1: Types + `summarizeRows(rows): CoordinationEvidenceSummary` pure + tests**

- [ ] **Step 2: Port + InMemoryEvidence for tests**

- [ ] **Step 3: SQLite adapter + history init**

- [ ] **Step 4: Wire record in use-case**

- [ ] **Step 5: Commit** `feat(qa): persist coordination evidence in SQLite`

---

### Task 6: A5 — Evidence-gated active

**Files:**
- Modify: `coordination-evidence.ts` — `isActivePointEligible`
- Modify: `active-gate.ts` — accept eligibility boolean **or** check inside honor helpers via new param `eligible: boolean`
- Modify: `run-qa.use-case.ts` — before honor, `summarize(app)` then eligibility (fail-open: treat summarize throw as ineligible)
- Modify: factory — `COORDINATION_ACTIVE_OVERRIDE`, thresholds env defaults
- Test: active + empty evidence → no sidekick; override → sidekick allowed

```ts
export function isActivePointEligible(input: {
  mode: CoordinationMode;
  summary: CoordinationEvidenceSummary;
  minSamples: number;
  minBetterRatio: number;
  operatorOverride: boolean;
}): boolean {
  if (input.mode !== "active") return false;
  if (input.operatorOverride) return true;
  if (input.summary.sampleSize < input.minSamples) return false;
  if (input.summary.betterRatio === null) return false;
  return input.summary.betterRatio >= input.minBetterRatio;
}
```

`betterRatio = better / (better+worse+same)` when denom>0 else null.

- [ ] **Step 1: Contract tests for eligibility**

- [ ] **Step 2: Wire honor gates**

- [ ] **Step 3: Use-case tests**

- [ ] **Step 4: Commit** `feat(qa): gate active coordination points on evidence`

---

### Task 7: B1 — YAML `qa.coordination`

**Files:**
- Modify: `src/orchestrator/schemas.ts`
- Modify: `src/orchestrator/config-loader` types / `AppConfig`
- Modify: `rewritten-engine-factory.ts` merge env > yaml > defaults
- Test: schema parse test colocated with schemas tests
- Update: `config/apps/example.yaml` commented example

- [ ] **Step 1: Zod schema + failing parse test for valid block**

- [ ] **Step 2: Factory merge**

- [ ] **Step 3: Commit** `feat(qa): add qa.coordination YAML config`

---

### Task 8: B2 — Escalated model from infra config

**Files:**
- Modify: composition / factory — when building SidekickExecutor calls sites, pass `model` if capability is `sidekick-escalated` from `process.env.COORDINATION_ESCALATED_MODEL` or YAML
- Modify: FixLoop + pre-generate sidekick `execute` opts
- Test: unit test that execute receives model when capability escalated (mock SidekickExecutor)

- [ ] **Step 1–4: TDD + commit** `feat(qa): resolve sidekick-escalated model from config`

---

### Task 9: B3 — Adaptive signals from evidence.summarize

**Files:**
- Modify: `adaptive-routing.ts` or new `deriveAdaptiveSignalsFromSummary`
- Modify: `create-coordination-port.ts` to accept `evidence?: CoordinationEvidencePort` + `app?: string` **or** factory passes `signals: () => derive...`
- Note: `decide()` has `context.runId` but app may need threading — pass app via closure in composition when creating the port

- [ ] **Step 1: Pure derive from summary + test**

- [ ] **Step 2: Wire createCoordinationPort**

- [ ] **Step 3: Commit** `feat(qa): drive adaptive thresholds from durable evidence`

---

### Task 10: B4 — LeadContext snapshot on evidence row

**Files:**
- Extend `CoordinationEvidenceRow` with optional `leadSnapshot?: { decisions: number; delegations: number; openQuestions: number }`
- Persist JSON column or fields
- Use-case fills from `leadContext` at record time

- [ ] **Step 1–3: TDD + commit** `feat(qa): snapshot lead context counts into evidence`

---

### Task 11: B5 + B6 — Operator doc + promotion checklist + minimal API/TUI hook

**Files:**
- Create: `docs/coordination-operator.md` (mode, sample, eligibility, promotion checklist from spec B6)
- Modify: optional small fields on run digest / API if an existing endpoint is trivial; otherwise doc-only for API and a follow-up issue noted in the doc

- [ ] **Step 1: Write operator doc with Quick path + promotion checklist**

- [ ] **Step 2: Link from `AGENTS.md` or `docs/` index if one exists (one line)**

- [ ] **Step 3: Commit** `docs(qa): add coordination operator guide and promotion checklist`

---

### Task 12: Verification gate

- [ ] **Step 1: Run**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22.12.0
npm run typecheck
npm run arch:check
node --import tsx --test qa-engine/test/contract/coordination*.ts \
  qa-engine/test/contexts/qa-run-orchestration/application/coordination*.ts
```

Expected: typecheck clean, arch clean, coordination tests pass.

- [ ] **Step 2: Confirm `COORDINATION_MODE` unset still skips coordination ports in composition**

- [ ] **Step 3: Final commit only if verification fixes were needed**

---

## Spec coverage check

| Spec slice | Task |
|------------|------|
| A1 Cost | 1–2 |
| A2 Proxy classifier | 3 |
| A3 Dual-path sample | 4 |
| A4 SQLite evidence | 5 |
| A5 Active gate | 6 |
| B1 YAML | 7 |
| B2 Escalated model | 8 |
| B3 Adaptive durable | 9 |
| B4 LeadContext snapshot | 10 |
| B5–B6 Docs/promotion | 11 |
| Verification | 12 |

## Placeholder scan

No TBD/TODO steps; dual-path execute-vs-static preference is fixed in Task 4 as: attempt sidekick execute when dual-path fires; if execute unavailable in test harness, assert on `sidekickUsableSpecs` + classifier inputs.
