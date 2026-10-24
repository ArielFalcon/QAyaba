# Lead review loop

Objective: qayaba follows the lead + sidekicks shape the owner described: deterministic grounding, a lead that plans with the code graph, sidekicks that author, run and fix their flow, and a lead that reviews their results before the reviewer.
Branch: `fix/failure-observation-conflict` (single-branch rule). Delivery: ask-on-risk. Runner: `node --import ./test-setup.mjs --import tsx --test` (Node v24).

## Specs

- **S1** (phase 1): in `lead-sidekicks` mode the lead reviews what the sidekicks delivered before the run goes on. The owner asked: "El lead analiza estos resultados para determinar si son correctos, pudiendo interactuar con los sidekicks en la misma sesión o lanzar algun sidekick nuevo. Cuando determine que es correcto se los envia al reviewer que le da feedback o aprueba y entonces se da el veredicto."
  - The lead's planning session stays open for the whole coordinated pass and the review turn is asked in it, read-only like the plan.
  - The review turn shows, per flow: objective and acceptance, what came of it, the sidekick's summary and concerns, the flow's `run_spec` facts (calls, last status, the last failure's facts) and the spec's bytes (bounded, read through the confined reader).
  - The lead answers per flow `accept`, `revise` (an instruction sent to the SAME sidekick session), `replace` (a fresh sidekick on the same flow, on the escalated model) or `drop`.
  - At most 2 review rounds, inside the run's deadline and keeping the run's reserve.
- **S2** (phase 1): the lead's decision is untrusted and the orchestrator's facts decide over it:
  - an `accept` of a flow whose last `run_spec` on its current bytes failed, and is not an app defect, is not admitted: it becomes a `revise` carrying the orchestrator's failure facts while rounds remain;
  - an app defect is never sent back to be made green (`revise`/`replace` refused);
  - a `drop` of a flow that delivered is refused in phase 1 (its spec is already in the working copy; the run's execution and the reviewer judge it);
  - a decline that rests on an empty read the Context Pack contradicts stays refused;
  - an unreadable review, or a flow the review does not name, keeps what the flow came to.
- **S3** (phase 1): sidekick sessions, workspaces and `run_spec` loops stay alive until the review ends, and are disposed however the pass ends. The fixed escalation ladder (an automatic second attempt on the escalated capability) is replaced by the lead's review; the last-resort lead takeover when no flow finished stays.
- **S4** (phase 1): the coordination gate signal and telemetry record the review: rounds, and the decisions admitted and refused.
- **S5** (phase 2): the lead gets read-only codebase-memory tools served by the orchestrator (project bound server-side, no free Cypher); no other role gets them.
- **S6** (phase 3): grounding is deterministic: the diff without the app's own test files (names only), the structural signal, the Context Pack and the e2e suite listing; the explorer is removed in lead-sidekicks mode; each sidekick gets its flow's slice of the Context Pack; the lead loses Playwright MCP. The owner chose: "Grounding determinista (diff filtrado + grafo + Context Pack) y el lead explora con codebase-memory; sin explorador."
- **S7** (phase 4): the reviewer's corrections go to the lead, which routes them to the sidekicks.
- **S8** (phase 5): a campaign compares this mode, `single` and the plain agent on R4/R5/R6 before any default changes.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1, S3 | inline | done (RED→GREEN: executor follow-up in the same session, disposed once; plan hands back the lead session, read-only, timed-out turn reported) | 4e56e3d6 |
| T2 | S1, S2, S3, S4 | inline | done (lead-review.ts 12 tests; lead-sidekicks 39 tests: revise reaches the same session, replace on the escalated model, unverified accept sent back, drop settles, unreadable/timed-out review leaves flows, no room → no review, every session disposed once; full suite 10442 pass, 5 known DeepSeek-config failures) | (this commit) |
| T3 | S5 | inline | pending (phase 2) | |
| T4 | S6 | inline | pending (phase 3) | |
| T5 | S7 | inline | pending (phase 4) | |
| T6 | S8 | inline | pending (phase 5) | |

## Log

- **L1** (2026-10-24) owner's request: "Como deberia quedar es Un agente inicial hace el grounding, que luego se le pase al agente lead. El lead es el orquestador que recibe toda la informacion para decidir que testear, este explora si necesita y analiza lo que haga falta para poder determinar que se debe probar y agrupar los test (o por paginas o por grupos logicos) para hacer fan-out de los sidekicks necesarios. Estos sidekicks reciben ya todo el contexto de que probar y donde, tienen las herramientas tambien para analizar codigo y DOM por si necesitan comprobar algo, se encargan de generar y ejecutar los test, corregirlos si hace falta y al final le dan estos test al lead. El lead analiza estos resultados para determinar si son correctos, pudiendo interactuar con los sidekicks en la misma sesion o lanzar algun sidekick nuevo. Cuando determine que es correcto se los envia al reviewer que le da feedback o aprueba y entonces se da el veredicto."
- **L2** (2026-10-24) owner chose deterministic grounding without the explorer (S6), then: "Sí, crea el documento de seguimiento y empieza la fase 1."
- **L3** evidence: today the plan session is disposed after planning (`generate-tests.use-case.ts` `finally`), each sidekick attempt opens and disposes its own session (`sidekick-executor.ts:208`), and a flow's workspace and `run_spec` ledger are gone before the flows are added up (`lead-sidekicks.ts:269-271`); no live run of the mode was ever recorded.
- **L4** (2026-10-24) T1/T2: the fixed escalation ladder is gone from `LeadSidekicks`; `orchestration-router.ts` is now used only by its own tests, contract test and mutate preset, and goes in phase 3. Decision: the lead's review is asked in its planning session (kept by the plan), not a fresh one, so it judges with what it explored. A `drop` of a delivered flow is refused in phase 1 (its spec is already in the working copy). Engram mirror pending (memory server unavailable this session).
