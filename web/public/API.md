# Qayaba Console — endpoint requirements

What the dashboard needs from the **ai-pipeline** orchestrator to show real data in
every section, mapped against the **existing `/api/v1/*` contract**
(`contract/openapi.json` → `@ai-pipeline/sdk`). Each row is either:

- **✓ exists** — the contract already serves it (maybe with a small field/derivation note),
- **⚠ extend** — an existing endpoint that needs more fields, or
- **✗ new** — an endpoint/rollup the dashboard needs that does not exist yet.

> Transport: same-origin, dashboard served at `/app`, API under `/api/v1/*`, Bearer/credentials
> carried by the browser. Live feed is SSE. The console's data layer (`js/api.js`) already
> mirrors the SDK method-for-method; completing the server side is mostly filling the ⚠/✗ rows.

The console's **internal view model** (what `api.loadAll()` must return) is documented by the
mock in `js/data.mock.js`. Field names below in `code` are the dashboard's model fields; the
contract schema names are in (parens).

---

## 0. Cross-cutting

| Need | Endpoint | Status | Notes |
|---|---|---|---|
| Watched apps (sidebar, fleet) | `GET /api/v1/apps` → `AppView[]` | ✓ | `AppView` lacks a human **`stack`** label ("Astro · Vercel") and a **`status`** is derived from `code`/`shadow`. |
| Model ids (generator/reviewer) | `GET /api/v1/agent/config` → `PublicAgentConfig` | ⚠ extend | Dashboard shows `models.generator` / `models.reviewer`. Confirm both role→model ids are exposed here (or `/agent/models`). |
| Auth | — | — | Static shell public at `/app`; `/api/v1/*` Bearer-protected. The console sends `credentials:'include'` + optional `Authorization`. |

---

## 1. Fleet (Overview) — landing

| Block | Data needed (model field) | Endpoint | Status |
|---|---|---|---|
| **Live engine band** | engine `status`, `health{ok,last,interval}`, `queue{running,queued}`, `sessions`, `mirrors`, `webhook` | `GET /api/v1/queue` → `QueueStatus{pending, running{id,app}}` | ⚠ extend — only queue counts exist. Health-poller state, open sessions, last mirror-prune, webhook status are **not** in the contract. Add an **engine status** endpoint (or extend `/queue`). |
| **Running now** | the executing run summary (`id,app,mode,sha,message,stages,elapsed`) | `queue.running` + `GET /api/v1/runs/{id}` | ⚠ — pipeline `stages[]` is a dashboard concept; derive from `RunRecord.step`/`activity` or add a `stages` array. `elapsed` from `stepStartedAt`/`at`. |
| **Fleet signals (6 KPIs, period-over-period + sparkline)** | `valueOracle{v,prev,baseline,series}`, `reviewerPass{v,prev,series}`, `runs{measured,total,prevMeasured,prevTotal,series}`, `suitesGreen{v,total,prev,series}`, `prsAutoMerged{v,prev,series}`, `issuesOpen{v,prev,series}` | `GET /api/v1/signals` → `SignalsView` | ⚠ **extend (key gap)** — `SignalsView` today is `{valueOracle{measured,avgScore,measuredRuns,totalRuns}, reviewer{passRate,runs}, coverage{...}}`. It has **no previous-window value, no sparkline `series`, and none of `suitesGreen`/`prsAutoMerged`/`issuesOpen`**. Extend to a fleet, period-over-period shape with `series[]` + those three counters. |
| **Where the guardrails fire (fleet ErrorClass)** | `fleetErrorClasses: [[class,count]]` | — | ✗ new — fleet-wide rollup. Either aggregate `errorClasses` from each app's `/trends`, or add `GET /api/v1/signals/error-classes`. |
| **Recent activity (5 runs)** | recent runs across **all** apps | `GET /api/v1/runs?limit=5` | ⚠ — the SDK's `listRuns` always passes `?app=`. Confirm `GET /api/v1/runs` (no `app`) returns a **fleet-wide** feed; otherwise the console must fan out per app and merge. |

---

## 2. Runs feed

| Block | Data needed | Endpoint | Status |
|---|---|---|---|
| **Stats strip** | `stats{runs7d,passRate,specsAdded,openIssues,watching}` + 7-day `verdictMix[]` | — | ✗ new — fleet rollup. No fleet stats / fleet verdict-mix endpoint today (verdict mix exists only per-app in `/trends`). Add `GET /api/v1/signals` fields or `GET /api/v1/stats`. |
| **Run list (+ verdict filter)** | runs (fleet): `verdict, app, sha, message, mode, specs(count), time, stages(mini)` | `GET /api/v1/runs?app=&verdict=&mode=&limit=` → `RunRecord[]` | ✓/⚠ — `RunRecord` has `verdict, app, sha, mode, note, specs[], at`. Needs fleet-wide listing (see §1 recent), a `verdict`/`mode` filter, and a `stages` mini-pipeline (derive). `message` = `note`. `time` = relative(`at`). |
| **Running row** | `queue.running` + summary | `GET /api/v1/queue` | ⚠ (as §1). |

---

## 3. Run detail

| Block | Data needed | Endpoint | Status |
|---|---|---|---|
| **Header** | `verdict, sha, app, branch, mode, message, author, time, duration` | `GET /api/v1/runs/{id}` → `RunRecord` | ⚠ — `RunRecord` has `verdict, sha, app, ref, mode, note, at`. Missing **`author`**, **`duration`**. `branch`=`ref`, `message`=`note`. |
| **Pipeline stepper** | `stages: [[name,state]]` for classify→generate→validate→execute→decide | `RunRecord.step / activity` | ⚠ — add a normalized `stages[]` (state per stage) or derive from `step`+`activity`. |
| **Quality signals** | `coverage` label, `oracle` valueScore, `reviewer` verdict | `RunRecord` + run events | ⚠ — `coverage`, `oracle valueScore`, `reviewer` approval are emitted as run **events** (`coverage.computed`, `reviewer.verdict`) but are **not persisted on `RunRecord`**. Persist them on the record for finished-run detail. |
| **Changed files (blast radius)** | `changed: string[]` | — | ✗ new — `RunRecord` has no changed-file list. Add `changed[]` (the diff blast radius). |
| **Generated specs** | `newSpecs: [{file,status,n}]` | `RunRecord.specs[]` (`SpecRecord{name,objective,flow}`) + `cases[]` | ⚠ — derive `file`=`name`; per-spec `status`/test-count come from correlating `cases[]`. |
| **Decision callout** | `decision` text (PR #/Issue #/quarantined) | — | ⚠ extend — add a `decision`/`outcome` string to `RunRecord` (event `run.verdict.outcome` exists; persist it). |
| **Run log** | `log: [[glyph,text]]` | `RunRecord.logs[]` | ✓ — map plain lines to glyphs by level. |
| **Ask Qayaba (chat)** | per-run Q&A | `POST /api/v1/runs/{id}/ask` → `AskResponse{answer}` | ✓ — `js/api.js` already calls it (`ask`, with `history`). |

---

## 4. Live run detail (the executing run)

| Block | Data needed | Endpoint | Status |
|---|---|---|---|
| **Action plan** | `plan: [{t,s}]` (todos with state) | `RunRecord.activity[]` (`AgentActivity{kind:'todo'|'phase',text,status}`) | ✓ — map `todo`/`phase` activities to plan items. |
| **Currently executing spec** | `currentTest{file,phase,code[],cases[]}` | `RunRecord` + events | ⚠ — `cases[]` = `QaCase[]` ✓. `file`/`phase` from `step`. **`code[]`** (the spec source text) is **not** in the contract → add it (or a `GET /api/v1/runs/{id}/specs/{file}`). |
| **Live pipeline + note** | stage states + step note | events `step.changed` | ✓ via SSE. |
| **Streaming feed** | live log + case + stage updates | `GET /api/v1/runs/{id}/events` (SSE) → `RunEvent` | ✓ **fully specified** — see §7 mapping. |
| **Cancel** | abort the run | `DELETE /api/v1/runs/{id}` | ✓ (`api.cancelRun`). |

---

## 5. App detail (App Value)

| Block | Data needed | Endpoint | Status |
|---|---|---|---|
| **Header / config rail** | `stack, status, target, repo, health, baseBranch, devUrl, gate, oracle, onFailure, shadow, coverageMode, coverageMin` | `GET /api/v1/apps/{name}` → `AppView` | ⚠ extend — `AppView` has `repo, baseUrl, code, shadow`. Missing **`stack`, `health`, `baseBranch`, `gate`, `oracle`, `onFailure`, `coverageMode`, `coverageMin`** (the watched-app config). Surface the app's `config/apps/<name>.yaml` here. |
| **Coverage keystone** | `coverage` ratio + `coverageMin` + `coverageSeries` + measured/unknown | `GET /api/v1/apps/{name}/trends` → `TrendsView.coverage{measured,ratio,minRatio,series}` | ✓ |
| **Value-oracle keystone** | `value` + `valueSeries` (+ unknown state) | `TrendsView.valueOracle{measured,avgScore,series}` | ✓ |
| **Verdict mix donut** | `vmix: [{v,n}]` | `TrendsView.verdictMix` | ✓ |
| **Reviewer pass-rate** | `reviewerPass` | `TrendsView.reviewerPassRate` | ✓ |
| **ErrorClass bars** | `errClasses: [[class,count]]` | `TrendsView.errorClasses[]` (`ErrorClassCount`) | ✓ |
| **Health-over-time chart + snapshot compare** | `histories[app]: [{id,sha,time,verdict,health,passRate,specs,coverage,oracle,flaky,issues,durSec}]` (one checkpoint **per run**) | — | ✗ **new (key gap)** — `TrendsView` has aggregate `series[]` but **not** per-run checkpoints with all these fields. Add `GET /api/v1/apps/{name}/history` returning the run-by-run checkpoints the compare view diffs. |
| **Activity tab · runs** | runs for the app | `GET /api/v1/runs?app={name}` → `RunRecord[]` | ✓ |
| **Activity tab · suite** | committed specs for the app `[{file,status,n,coverage}]` | — | ✗ new — no committed-suite endpoint. Add `GET /api/v1/apps/{name}/suite`. |
| **What Qayaba knows (engram)** | per-app episodic memory `[{text}]` | — | ✗ new — add `GET /api/v1/apps/{name}/memory` (episodic notes). Distinct from `intelligence` rules. |

---

## 6. Integrity, Learning, Reports

### Integrity (suite-health / trust)
| Block | Data needed | Endpoint | Status |
|---|---|---|---|
| Trust KPIs | `flakyRate{v,prev,series}`, `infraErrorRate`, `invalidRate`, `timeToGreen`, `determinism` | `TrendsView.flaky{rate,previousRate}` (per-app) | ⚠/✗ — flaky exists per-app; **infra-error rate, invalid rate, time-to-green, determinism, and a fleet rollup** do not. Add `GET /api/v1/integrity`. |
| Phase timing | `phases: [[phase,sec]]` | — | ✗ new. |
| Gate effectiveness | `gates.{enforceHeld,regenRecovered,staticRejected}` | — | ✗ new. |
| 4-layer quality gate | `gates: [{n,label,mode,pass,of,desc}]` | — | ✗ new. |

### Learning (flywheel + ledger + engram)
| Block | Data needed | Endpoint | Status |
|---|---|---|---|
| Flywheel counters | `flywheel: [{id,stat,unit,note}]` (labeler→oracle→reflector→distiller→curriculum) | — | ✗ new — fleet counters. Some derivable from `IntelligenceView.scorecard`. |
| Governed rule inventory | `ledger.rules: [{id,status,trigger,action,errorClass,confidence,usage,outcomes,success}]` | `GET /api/v1/apps/{name}/intelligence` → `IntelligenceView.rules[]` (`LearningRuleView`) | ✓ per-app — fields map (`confidence` `low/medium/high`→`low/med/high`; `status` `candidate/active/deprecated/superseded` ✓; `usageCount/outcomeCount/successRate`). ⚠ needs a **fleet** aggregate + a stable rule **id** (contract rule has no id). |
| Scenario archetypes | `ledger.archetypes: [{name,caughtRealBug,promotions}]` | `IntelligenceView.curriculum` → `CurriculumView.archetypes[]` | ✓ per-app (`archetype,caughtRealBug,promotionCount`); fleet aggregate ⚠. |
| Governance / audit log | `ledger.audit: [{rule,issue,level}]` | — | ✗ new. |
| Engram (all apps) | `engram: [{app,text}]` | — | ✗ new (see §5 memory). |

### Reports
| Block | Data needed | Endpoint | Status |
|---|---|---|---|
| Insight blocks (ranked) | `reports.insights: [{metric,shape,headline,detail,weight}]` | `GET /api/v1/apps/{name}/report` → `ReportView.insights[]` (`ReportInsight`) | ✓ **maps well** — `ReportInsight{id,title,chart,value,unit,delta,multiplier,direction,goodWhen,series,breakdown,score}`. Map `shape`←`chart`, `headline`←`title`, `weight`←`score`. It's **per-app**; the dashboard's Reports is exec/fleet → call for the primary app or add a fleet report. |
| Templates | `reports.templates: [{id,name,desc,blocks,schedule,channel}]` | — | ✗ new (or keep client-side presets). |
| Generate / schedule / export | actions | — | ✗ new (future POST). |

---

## 7. SSE live feed → UI mapping (`GET /api/v1/runs/{id}/events`)

The contract already defines **15 `RunEventBody` variants**. `js/api.js#subscribeRun` already
consumes them and normalizes to the UI's `{onStep,onPlan,onCase,onLog,onVerdict}`:

| `RunEventBody.type` | UI effect |
|---|---|
| `run.started` | (context) |
| `step.changed{step,detail}` | advance pipeline stage + step note |
| `agent.activity{kind,target,status}` | (plan/activity — optional) |
| `plan.updated{todos}` | refresh action plan |
| `spec.written{file}` | (optional) |
| `test.discovered{name,file}` | (optional) |
| `test.started{name}` | case → running |
| `test.passed{name,durationMs}` | case → pass (ms) |
| `test.failed{name,durationMs,detail}` | case → fail |
| `test.flaky{name,attempts}` | case → flaky |
| `reviewer.verdict{approved,reasons}` | quality signal |
| `coverage.computed{changedLines,coveredLines}` | coverage signal |
| `run.verdict{verdict,passed,failed,outcome}` | finalize run |
| `agent.error{detail}` | error log line |
| `log.line{level,text}` | append to terminal |

---

## 8. Actions (writes) — already in the contract

| Action | Endpoint | Status |
|---|---|---|
| Trigger run (dialog) | `POST /api/v1/runs` (`CreateRunInput{app,target,mode,sha}`) → `CreateRunResult` | ✓ (`api.createRun`) |
| Cancel run | `DELETE /api/v1/runs/{id}` | ✓ (`api.cancelRun`) |
| Ask about a run | `POST /api/v1/runs/{id}/ask` → `AskResponse` | ✓ (`api.ask`) |
| Continue/re-run | `POST /api/v1/runs/{id}/continue` | ✓ (available; "Re-run" button is currently a no-op) |

---

## 9. Summary — what to build to go fully live

**Reuse as-is (✓):** `/apps`, `/apps/{name}`, `/apps/{name}/trends`, `/apps/{name}/intelligence`,
`/apps/{name}/report`, `/runs` (+`{id}`, `/events`, `/ask`, `/continue`), `/queue`, `/agent/config`.

**Extend (⚠):**
1. **`/signals`** → fleet, period-over-period, with `series[]` + `suitesGreen`/`prsAutoMerged`/`issuesOpen` (powers the Overview hero).
2. **`RunRecord`** → persist `author`, `duration`, `decision/outcome`, `coverage`, `oracle valueScore`, `reviewer` approval, `changed[]`, normalized `stages[]`, and (for live) spec `code[]`.
3. **`AppView`** → `stack`, `health`, and the watched-app config (`baseBranch`, `gate`, `oracle`, `onFailure`, `coverageMode`, `coverageMin`).
4. **`/runs`** → confirm fleet-wide listing (no `app`) + `verdict`/`mode` filters.
5. **`/queue`** → engine status (health poller, sessions, last mirror-prune, webhook).
6. **`IntelligenceView.rules`** → stable rule `id`.

**New (✗):**
- `GET /api/v1/apps/{name}/history` — per-run health checkpoints (App-detail compare).
- `GET /api/v1/apps/{name}/suite` — committed spec list.
- `GET /api/v1/apps/{name}/memory` — per-app engram notes.
- `GET /api/v1/integrity` — fleet flaky/infra/invalid/time-to-green/determinism, phase timing, gate effectiveness, the 4-layer gate.
- Fleet rollups: recent runs, stats (`runs7d`/`passRate`/`specsAdded`/`openIssues`), 7-day verdict mix, fleet ErrorClass, learning flywheel counters, governance/audit log, (optional) fleet report + report templates.

> Once these land, set `window.QAYABA_CONSOLE_CONFIG = { mode:'live' }` and complete the
> `TODO(server)` markers in `js/api.js#mapModel` (most are 1-line field maps).
