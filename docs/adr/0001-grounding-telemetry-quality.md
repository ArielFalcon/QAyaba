# ADR-0001: Grounding telemetry and evaluation

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** qayaba maintainers
- **Related:** `docs/observability-design.md` §4.4, §5, §11, §12, §14; `docs/observability-context.md` §3–§8; `docs/efficiency-benchmark.md`; `docs/testing-standards.md`
- **Amended 2026-10-25:** the explorer (and its brief) was removed from the system; lead + sidekicks is the only generation path and the lead grounds deterministically. Every mention of the explorer below is the record of what was decided and measured at the time, kept as written; the explorer variant, source and ground-truth rows no longer exist in the code.

## 1. Context

qayaba's grounding phase pre-computes what the generator receives before it writes a spec. It is fail-open: every source may be absent, empty or broken without ending the run. The phase has never had a measurement that answers the product question:

> Which grounding sources earn their cost, and does the agent actually use what they give it?

Today the telemetry records, per source, bytes and (for most sources) stable item ids. It does not record what survived prompt assembly, what was truncated on the way to the model, how fresh each source was, or whether turning a source on changes the outcome. The existing evaluation catalog declares `context_utilization` and `context_complete` as `pending`; no grader emits them.

This ADR defines the measurement model and the experiment needed to answer that question. It refines the observability design; it does not replace it.

**Decision summary**

1. Measure three layers: **produced** (what a source yielded), **delivered** (what survived prompt assembly) and **referenced** (what the agent used). Only delivered data feeds utilization and completeness.
2. Measure **two utilization scores** with the same pure extractor and different denominators: `context_utilization` over **all delivered** extractable items (the gross baseline, expected to improve as delivery is refined) and `context_utilization_focused` over the **change-relevant** subset, grouping routes by component/page and limiting DOM to the changed element(s). `file` is a separate reread signal; non-extractable sources are `n/a`.
3. `context_complete` is false only for **truncation** of a delivered source. Selection (route cut) and degradation (failed/empty/redirect) are different facts.
4. Add `context_fresh` for **freshness**: effective location, capture timestamp, result count, stale reason and recapture outcome per source.
5. Add per-source **items/truncation metrics** and keep bytes; all labels are closed sets.
6. Run a **paired A/B** over `effectiveConfig.grounding` with request-level grounding levers, isolated engram, verified data state and at least 3 replicates.
7. Extend **ground truth** to score the explorer's routes/links and the stitcher's links, not only the specs' routes and the files read.
8. Add the missing measures the six items do not state: source status/reason, precision/hallucination, changed-element observability, capture consistency, data-state fingerprint, cost/time per source and score versioning.

## 2. What grounding is today

The phase is `qayaba.phase.ground`, entered before generation. Its inputs, in the order the engine assembles them:

| Source | Produced by | What it supplies | Main cuts | Fail-open behavior |
|---|---|---|---|---|
| Context map | `pre-generation-grounding-port.adapter.ts`: SQLite `context_maps` first, `e2e/.qa/context.json` on disk as fallback | Routes, API operations, FE↔BE links, named flows; `builtAtSha` | Prompt render caps: 200 entries per list, 20 KB | Missing/malformed/`contextStale` → no map |
| Explorer brief | `explorer-brief-session.adapter.ts`, role `qa-explorer`, default on when the app declares `services[]` | Objective, blast radius, routes, risks, FE↔BE links, contracts | Whole brief in the prompt; section budget | Turn failure → no brief |
| Route ranking + DOM capture | `rankRoutesByChange` + `dom-snapshot.ts` + `buildContextPack` | Ranked routes, then live DOM of the routes that are pages and the templated pages reached through real links | `MAX_ROUTES = 4`, `MAX_NODES_PER_ROUTE = 60`, DOM budget 30 KB, line cap | Capture failure → no DOM section |
| Context pack | `context-pack.ts` | Live DOM, redirect advisory, relevant API contracts, routes not capturable, changed-element facts | Line cap, route cut, node cap, contract list | Empty pack → section absent |
| Service links / contract drift | `service-links-port.adapter.ts` + service topology profiles | FE↔BE links and drift, resolved from mirrors | `MAX_LINKS = 40`, `MAX_DRIFT = 20` | Empty or resolver error → no section |
| Structural signal | `TracedStructuralSignalPort` over the code graph | Advisory lines about impacted symbols | Graph index freshness; prompt section caps | No graph / no symbols → no section |
| Learned rules | `TracedLearningPort` | Governance-selected rules | Retrieval limit; prompt section | None retrieved → no section |
| Curriculum exemplars | `TracedCurriculumPort` | At most 3 exemplars | `MAX_SELECTED_EXEMPLARS = 3`, section `maxBytes = 1536` | Frozen under campaign; none → no section |
| Existing suite manifest / harness facts | `pre-generation-grounding-port.adapter.ts` | Existing spec paths, flows/objectives, fixture exports, test-id convention | Listing caps | Missing manifest → plain list |
| Prompt assembly | `context-assembler.ts` | Orders, caps and sheds sections | Section `maxBytes`, global role budget | Dropped section is named in a notice |

The prompt sections that carry grounding are `arch-map`, `context-brief`, `static-signal`, `service-links`, `skill-exemplars`, `context-pack`, `learned-rules`, `existing-suite-manifest` and `harness-facts`. The generator's turn already records `section_sizes` and `section_hashes` per section.

Two cross-run learning inputs sit outside this phase's prompt assembly: the accepted suite (suite store restore, then the manifest section) and engram (agent-side MCP memory). The suite restore is already traced by the `qayaba.suite_store.restore` span (attributes such as `qayaba.suite_store.restored`); engram use is visible only as `engram_mem_*` tool calls. They are part of the "learning from previous runs" goal and are treated separately in D8; they are not context spans.

Item ids are defined in `qa-engine/src/contexts/generation/domain/context-item-ids.ts`: `route:`, `dom:`, `op:`, `link:`, `flow:`, `rule:`, `exemplar:`, `brief:`, `fact:`, `signal:`, `svc-link:`, `impact:`. They are deterministic and stable across runs. The design says only `route`, `dom`, `op` and `file` are extractable; the rest are `n/a` for utilization.

## 3. What the current traces show

Four recent runs recorded context spans. The R4 case (`run-ec03222-mvflk6se-063f8199`, sha `ec03222`) is representative:

| Observation | Value |
|---|---|
| Grounding phase | 45.7 s of a 7.0-minute run |
| Context map | 112 items (41 routes, 22 operations, 43 links, 6 flows), 27,546 bytes |
| Explorer brief | 12 items, 2,384 bytes |
| DOM captures | 5 spans: 126/29/90/50/49 ids; the captures reported 104 + 34 + 26 items left out by the node cap (164 total) |
| Route ranking | 4 ids, `truncatedItems = 21` (25 capturable pages → 4 captured) |
| Context pack | 0 item ids, 5,713 bytes |
| Service links | 17 items, 5,810 bytes |
| Learned rules | 0 items |
| Prompt sections | `arch-map` 4,840 B; `context-brief` 2,397 B; `service-links` 4,915 B; `context-pack` 5,713 B; `skill-exemplars` 640 B |
| Map freshness | `builtAtSha = 549e0649`, stored 2026-10-11T16:38Z; run on 2026-10-19 — 8 days old, different SHA |

Four problems are visible in that table.

### 3.1 Produced is not delivered

The context pack's prompt section is 5,713 bytes and contains the live DOM, but the `qayaba.context.context-pack` span has **0 item ids**. The DOM ids live on the capture spans, which include pages the pack cut and nodes the line/node cap removed. A utilization denominator built from those spans counts items the agent never saw.

The context map is the mirror case: the span records 27,546 bytes of JSON and 112 ids, while the prompt renders 4,840 bytes of a filtered view (and may suppress operations or links when the brief/pack already owns them).

### 3.2 Selection, truncation and degradation are conflated

- `route-ranking.truncated_items = 21` is a **selection**: the pack deliberately captures 4 pages and ranks the changed route first.
- `dom-capture.truncated_items` is a **truncation**: the five captures reported 104 + 34 + 26 items left out by the per-route node caps, on pages the agent received.
- `context-pack.truncated_items = 0` despite those 164: the aggregate view does not see the capture-level cuts.
- A capture that fails or redirects is a **degradation**, not a truncation.

Without this distinction, `context_complete` would be false on almost every run (every capture has a large page), and the score would stop meaning anything.

### 3.3 Freshness is not recorded

The map was built from an older commit and never refreshed. The run used it silently. There is no record of the effective location (database vs disk), the capture timestamp, the number of results, or whether a recapture was requested. The structural signal has the same problem: it is only as fresh as the code-graph index, and the run does not record `lastIndexedSha` beside the signal.

### 3.4 R4 end-to-end

R4's change is a label-only Angular input binding (`endActionLabel="Filtrar"` → `"Cambiar filtros"`). The diff parser produced no `ChangedElement` (no test id, no text), so the pack had no `fact:` for the changed element.

The grounding DOM showed `text: 0 resultados` on every restaurant-list route. **The review DOM, captured later in the same run, showed `text: 11 resultados` with restaurants listed.** The generator wrote two tests for the empty state; the reviewer rejected them against the fresh DOM. The correct outcome depends on the data state: with 0 restaurants, a reasoned no-op; with results, a test of the renamed end-of-list button. The run's own grounding was stale relative to its own review, and nothing recorded the discrepancy.

This is both a grounding-to-decision gap and a freshness gap. The measurement must be able to say:

- the map was stale (SHA mismatch, 8 days, 112 results);
- the pack's relevant route was grounded and complete (14 nodes, no node cap), while a later capture of the same route had 39 nodes and the review DOM had 11 results;
- the grounding DOM and the review DOM disagreed on the result count (0 vs 11), so the context was not fresh at the time it mattered;
- the changed element was **unknown**, not absent (no test id, no text signal);
- DOM utilization is therefore `n/a`, not `0`;
- the no-op consistency check is `n/a`, not `false`;
- the reviewer's correction is the outcome signal that caught the false positive.

The review DOM is a second sample of the same page. It should not be used only to judge the spec; it should also be recorded as a consistency check on the grounding capture. If the change-relevant page differs, the run knows its context was stale even when no cache is involved.

## 4. Quality criteria

The measurement must answer these questions, in this order:

1. **Coverage / recall.** Did grounding contain the change's affected routes, files, FE↔BE links and operations? (Ground truth.)
2. **Precision / noise.** How much irrelevant, stale or invented context did the agent receive or reference?
3. **Completeness.** Was what we chose to deliver cut on the way to the model?
4. **Utilization.** Did the agent reference the change-relevant items we delivered?
5. **Freshness.** Where did each source come from, when was it captured, how many results did it return, and was it stale?
6. **Causal effectiveness.** Does turning a source on improve validity, pass rate, reviewer approval, coverage and cost, at a measured cost?
7. **Consistency.** Do the same items get the same ids and the same ranking across runs, and is the extractor versioned?

These map to the product goals: learning from previous runs (suite store, learned rules, curriculum), multi-repo blast radius (map, stitcher, cross-repo impact), and FE↔BE/BE↔BE relationships (links, operations, drift).

| Criterion | Signal or score | Where |
|---|---|---|
| Coverage / recall | Ground-truth recall per source (files, routes, links, operations) | `probe-report --ground-truth` (offline) |
| Precision / noise | Ground-truth precision; `referenced_not_provided` | Probe report; both utilization comments/counter |
| Completeness | `context_complete` with `source:reason:count` | `run_scores`, eval gauge |
| Utilization (gross) | `context_utilization[.<source>]` over all delivered extractable items | `run_scores`, eval gauge |
| Utilization (focused) | `context_utilization_focused[.<source>]` over the change-relevant subset | `run_scores`, eval gauge |
| Freshness | `context_fresh` + provenance attributes/metrics | `run_scores` + spans/metrics |
| Causal effectiveness | Paired A/B deltas: validity, pass, reviewer, coverage, cost | Campaign report |
| Consistency | Stable ids, ranking, extractor version | Tests + `graderVersion` |

## 5. Decisions

### D1. Measure three layers: produced, delivered, referenced

- **Produced** is what a source yielded before prompt assembly. Keep the existing `qayaba.context.<source>` spans for this layer. Add `qayaba.context.stage = produced`, a `status` (`delivered`, `empty`, `skipped`, `failed`) and a `reason`.
- **Delivered** is what survived prompt assembly and reached the model. Add one `qayaba.context.delivered.<source>` span per grounding section, recorded under the generation turn. It carries `bytes.delivered`, `items.delivered`, `item_ids`, `omitted`, `omitted.reason` and `scope`.
- **Referenced** is extracted from the delivered specs and tool calls by a pure function. It is never self-reported by the agent.
- `context_utilization`, `context_utilization_focused` and `context_complete` read **delivered** data only. Produced data stays for diagnosis (why a source yielded nothing, what the capture cost).

Delivered ids must be attached where the section text is rendered, not parsed back from the prompt. Parsing the prompt is brittle: sanitization and by-value redaction can change role names, repo names and labels, so a hash computed from the rendered text would not match the id assigned at production. Each section builder returns `{ text, itemIds, omissions }`; the assembler exposes them and the turn trace records the delivered span.

Where the evidence already lives: produced/delivered spans in the `run_spans` ledger; prompt section sizes/hashes in `agent_turns.section_sizes`/`section_hashes`; delivered spec text in `run_spec_snapshots`; tool calls and file reads in `agent_turns.tool_sequence`; the stored map in `context_maps`; the run's resolved flags in `runs.effective_config`. The evidence adapter in `src/server/evaluation-evidence.ts` already reads the ledger and the snapshots; it is the natural place to assemble the new context evidence.

The context pack is the important case: `buildContextPack` already knows the pages it kept, the nodes within `MAX_NODES_PER_ROUTE`, the lines the cap dropped, the changed-element facts and the relevant contracts. It can return the delivered ids and the omission breakdown directly. The `context-pack` delivered span then replaces the current "0 ids" with exactly what the agent saw.

### D2. `context_utilization`: one extractor, two denominators

The same pure extractor and the same referenced set feed two scores. Only the denominator changes.

- **`context_utilization` (gross).** Denominator: **all delivered extractable items** (`route`, `dom`, `op`) from the delivered spans. No change-relevance filter. This is the baseline the product will improve by refining what is delivered: if the pack sends less noise, the gross ratio rises. It is expected to be low today (R4: ~1.3%), and that is the point.
- **`context_utilization_focused` (optimized).** Denominator: the **change-relevant** delivered subset, grouped for traceability:
  - `route`: the routes the change links to (`implementationFiles`, `source`, or the `spec` of an operation the route joins), **grouped by the map's `component`/page**. A spec that uses any route of the component counts the component as used; the three `RestaurantListPage` routes are one group, not three independent misses. Record `qayaba.context.relevant_ids` (routes) and `qayaba.context.relevant_groups` (component/page) on the route-ranking span and the delivered span.
  - `dom`: the delivered DOM ids of the **changed element(s)** on the relevant pages, grouped by component. If the change identifies no element (R4: a label binding, no test id, no text signal), emit **no** `dom` score. The spec's `getByRole`/`getByTestId` matches the element id; one route of the component is enough.
  - `op`: the delivered contract operations, already filtered to the change.
  - **Overall focused** is the macro-average of the measured source ratios, so a large DOM does not dominate. **Overall gross** is the micro-average over the union of delivered extractable ids, so volume matters.
  - If no route is linked, fall back to all delivered routes and mark `scope=fallback-all` in the comment.
- **Names.** `context_utilization` (gross) keeps the existing family and suffixes `route`, `dom`, `op`, `file` (the `file` suffix stays declared but is not emitted; see the extraction table). `context_utilization_focused` is a new NUMERIC 0..1, higher-better family with suffixes `route`, `dom`, `op`. Both are graded under the same extractor version. The gross score is the refinement target; the focused score is the normalized quality signal used by the A/B.
- **Traceability.** The comment of each score carries the per-source `referenced/provided` and the group list, for example `scope=change-relevant; route 1/1 (RestaurantListPage); dom n/a; op n/a`. The gross comment says `scope=all-delivered; route 1/41; dom 3/263; op n/a`. `referenced_not_provided` is listed in both.

**Extraction.** A pure module (for example `qa-engine/src/contexts/evaluation/domain/context-refs.ts`) extracts references from:

| Source | Extract from | Match |
|---|---|---|
| `route` | `goto` literals, `toHaveURL` literals/regexes, `waitForResponse` URLs, navigation tool targets | Normalize path; exact route id or a template id where each `:param` matches one segment |
| `dom` | `getByTestId` literals and `getByRole(role, { name })` | Exact id; role names use the same `hash8` normalization as `itemId.domRole` |
| `op` | `waitForResponse` URLs and literal operation ids | Exact `op:<operationId>`. Method + path is out of scope for v1 because `op:` ids carry only the operation id; adding it needs a map from operation to method/path on the delivered span. |
| `file` | Read tool targets | Report separately as `prompt_provided_reread`, a waste signal, not as use. The catalog's `file` suffix stays declared for compatibility but no grader emits `context_utilization.file`; a future catalog version may remove it. |
| `link`, `flow`, `rule`, `exemplar`, `brief`, `fact`, `signal`, `svc-link`, `impact` | — | `n/a`, never `0` |

Route matching must map a concrete path to a template id (`/restaurantes/madrid/madrid` → `route:/restaurantes/:province/:city`), because templated pages are captured through real links and the spec navigates to the concrete address.

DOM references are attributed to the most recent preceding `goto` in the same spec. A reference in a helper, a loop or a variable is counted as `unattributed`, never as a miss. The extractor is a lower bound on use; it is a diagnostic, not a verdict.

**Precision.** The same extractor reports `referenced_not_provided` (for example a `getByTestId` the pack never delivered). Put the list in the score comment and emit a counter. If this proves useful, add `context_precision` as its own score in a later phase; do not fold it into utilization.

**Limitations.** Literal-only extraction; dynamic selectors and helpers are unattributed; a low ratio is not proof of waste. The gross score is intentionally noisy — it is a delivery-refinement target, not a quality grade. The focused score is the normalized view and is still comparative, not an absolute pass/fail. Use both only across runs of the same extractor version.

### D3. `context_complete`: truncation only, scoped to what was delivered

`context_complete` is false only when a **delivered** source was truncated. Selection and degradation are different facts.

| Class | Examples | Incomplete? |
|---|---|---|
| Selection | `MAX_ROUTES = 4` route cut, `MAX_LINKS = 40`, `MAX_SELECTED_EXEMPLARS = 3`, rule cap | No. It is a budget decision; measure it with ground-truth recall. |
| Degradation | Capture failed, empty render, redirect, route not capturable, source failed | No. Record `status`/`reason`; the source is absent, not cut. |
| Truncation | Per-route node cap, pack line cap, prompt section `maxBytes` cap, section shed by the global budget, map `MAX_ITEMS`/`MAX_LEN`, brief/link/signal render cap | Yes. |

The DOM item-id cap (`qayaba.context.item_ids.overflow`) is a telemetry cap, not a prompt cut: it must not make `context_complete` false. Likewise, `route-ranking.truncatedItems = 21` is selection, not incompleteness.

`context_complete` is evaluated over the same change-relevant scope as utilization: the relevant pages, their delivered DOM, the relevant contracts, and the prompt sections that carry them. In R4, `/home` lost 34 nodes to the node cap, but `/home` is not change-relevant; the pack's `/restaurantes` had 14 nodes and no cap, so the score is `true`. A later capture of `/restaurantes` had 39 nodes and 11 results; that is a freshness difference, not a truncation, and it is what `context_fresh` records.

The comment lists each loss as `source:reason:count` (capped at 500 characters). The score is omitted when no grounding source was delivered: a vacuously true value is not a measurement.

### D4. Metrics per source, with closed label sets

Prometheus currently has only `qayaba.context.bytes`. Add:

| Instrument | Type | Labels |
|---|---|---|
| `qayaba.context.bytes` | histogram | `qayaba.context.source`, `qayaba.context.stage` (`produced`, `delivered`) |
| `qayaba.context.items` | histogram | `source`, `stage` |
| `qayaba.context.cut` | counter | `source`, `class` (`selection`\|`truncation`), `reason` |
| `qayaba.context.cut_items` | histogram | `source`, `class`, `reason` |
| `qayaba.context.freshness.age` | histogram | `source` |
| `qayaba.context.stale` | counter | `source`, `reason` |
| `qayaba.context.recapture` | counter | `source`, `outcome` |
| `qayaba.context.utilization` | histogram | `source`, `scope` (`gross`\|`focused`) (optional; the eval gauge already carries per-run values) |

`source` is the existing closed set of ten sources. `class` separates the two kinds of loss:

- **selection** (`route-cut`, `link-selection`, `exemplar-selection`, `rule-selection`) is the budget decision D3 says is not incompleteness;
- **truncation** (`node-cap`, `line-cap`, `section-cap`, `section-shed`, `map-cap`, `link-cap`, `brief-cap`, `signal-cap`, `exemplar-cap`, `rule-cap`) is the loss that makes `context_complete` false.

Degradation is not a cut: `empty`, `redirect`, `not-capturable`, `capture-failed` and `fetch-failed` are `status`/`reason` values, never `class`. `stage` and `outcome` are closed sets. No ids, routes, paths or URLs become metric labels.

Add the instruments to `qa-engine/src/shared-kernel/telemetry/instrument-table.ts` and the attributes to `attribute-registry.ts`; `checkInstrumentTable` is the test guard. The existing `qayaba.eval.score` gauge carries `context_utilization.*`, `context_utilization_focused.*`, `context_complete` and `context_fresh` once the graders are active; do not duplicate them as gauges.

### D5. Freshness and provenance

Every source records a provenance block on its produced and delivered spans:

```
qayaba.context.location       db:context_maps | file:e2e/.qa/context.json | live:dev |
                              mirror:stitcher | graph:codebase-memory | db:learning_rules |
                              db:curriculum | agent:explorer-brief
qayaba.context.captured_at    ISO-8601
qayaba.context.captured_sha   the SHA the source was built from, when it has one
qayaba.context.age_ms         now - captured_at
qayaba.context.result_count   routes+operations+links+flows, pages, claims, lines, rules, exemplars
qayaba.context.stale          boolean
qayaba.context.stale_reason   sha-mismatch | inputs-changed | older-than-max-age | marked-stale | empty |
                              capture-failed | fetch-failed | dom-changed | none
qayaba.context.recapture      not-needed | requested | completed | failed | skipped
```

Per source:

| Source | Location | `captured_at` | `captured_sha` | Stale when | Recapture |
|---|---|---|---|---|---|
| Context map | Effective source: DB or disk; record the shadowed one too | DB `updated_at` or file mtime | DB `built_at_sha`; record the blob's declared `builtAtSha` separately | `captured_sha !=` the run's base SHA; age > `QA_CONTEXT_MAP_MAX_AGE_DAYS` (default 14); `context_stale` flag | Extend the existing `context_stale` + `requestContextHeal` path (`rewritten-engine-factory.ts`, `history.ts`): enqueue a `mode: context` run **off the critical path**, deduplicated, at most one per app per `QA_CONTEXT_REBUILD_MIN_INTERVAL` (default 6 h). The current run uses the map and records `requested`/`completed`/`failed`. |
| Explorer brief | Agent session | Turn end | Run SHA (`builtForSha`) | Never per run; `status=failed` if the turn failed | None; fail-open |
| DOM capture | Live DEV | Capture start/end, for **every** capture (ground, pre-exec, review) | Run SHA | Never from a cache per run; `dom-changed` when two captures of the change-relevant route disagree | Recapture the stale page; never reuse silently |
| Service links | Mirrors + boundary profiles | Resolve time | Triggering service mirror HEAD; profile hash | `fetch-failed`; profile hash changed; HEAD != run SHA | Re-resolve on the next run; record the fetch outcome |
| Structural signal | Code graph | Index time | `lastIndexedSha` | `lastIndexedSha !=` run base SHA | The existing index sync; record its outcome |
| Learned rules | `learning_rules` | Rule `updated_at` | — | Campaign freeze; rule quarantined/deprecated | Governance, not recapture |
| Curriculum | `curriculum` | Selection time | — | Campaign freeze (`frozen`) | None |
| Existing suite | Suite store / git | Restore time | Stored SHA / commit | Missing, demoted, or a stored byte mismatch | Restore on the next run |

The map's **effective location** is the location that actually won. The loader currently prefers the DB and silently falls back to disk; record both so a fresh disk map that was shadowed by an older DB row is visible. The DB `built_at_sha` is authoritative; the map's own `builtAtSha` is the agent's declared value and may differ.

The R4 map is the case study: `location=db:context_maps`, `captured_at=2026-10-11T16:38:31Z`, `captured_sha=549e0649`, `result_count=112`, `stale=true`, `stale_reason=sha-mismatch`, `age≈8 days`, `recapture=requested`. The freshness is measurable and the next run benefits from the rebuild.

**Map reuse across shas.** A map built at another sha is reused only when git shows that the files the map names (each route's `source` and `implementationFiles`, each operation's `spec`) are unchanged between the map's commit and the run's, and no file of a route source's kind (same name suffix) was added (`context-map-validity.ts`; a tree comparison, so a map from a later commit is judged the same way). A map that fits is `stale=false`. One that does not fit (`stale_reason=inputs-changed`), or whose commits cannot be compared (`stale_reason=sha-mismatch`), is left out of the run: the run grounds without it, a `qayaba.context.context-map` span with no items still carries the provenance, and a rebuild at the run's sha is requested off-path (`recapture=requested`, `skipped` when deduped within 6 h or under the campaign freeze, never `not-needed`). A service-triggered run, whose sha belongs to another repo, keeps the plain sha comparison and still uses the map. The rule sees only what the map names: a generated client feeding `feBe` is not named, so the 14-day age bound still applies.

**Capture consistency.** A page can be captured more than once in a run: the pre-generation pack, the pre-exec catalog gate and the review DOM. Record `captured_at`, `settled`, `nodes`, `test_ids` and a fingerprint of the change-relevant page's `dom:` ids for each capture. When two captures of the same route exist, record `consistent`, `added` and `removed`. If the change-relevant page differs, set `context_fresh=false` with `stale_reason=dom-changed`. R4 is the case: the grounding capture saw `0 resultados`, the review capture saw `11`, and the generated spec was authored against the stale sample. The review DOM should be used both to judge the spec and to audit the grounding it was judged against.

**`context_fresh`.** Add a BOOLEAN score `context_fresh` (observe-only) that is true when every source the generator used was fresh at the time it was used: the map is not SHA-mismatched or over-age, the graph index is at the run's SHA, the stitcher fetch succeeded, and the change-relevant DOM did not change between captures. The comment lists the stale sources and reasons. It is omitted when no source was used. This is separate from `context_complete`: a complete pack can still be stale.

**Data state is a benchmark input, not engine code.** For R4, whether a spec or a no-op is correct depends on DEV having restaurants. The engine must not hardcode "0 resultados". The campaign case declares the expected data state and verifies it before each arm-run (a small probe spec or a configured selector), and the run records the observed DOM fingerprint (`nodes`, `test_ids`, `runtime_errors`, and an optional generic `list_items` count). The A/B then strata by that state; it does not infer an app-specific result count in `qa-engine`.

### D6. A real A/B with `effectiveConfig.grounding`

The current campaign compares the pipeline against a plain agent. It cannot answer which grounding source helps. Add an experiment path that varies grounding, holding everything else fixed.

**Request levers.** Extend the run request with an optional object:

```json
"grounding": {
  "explorer": true,
  "stitcher": false,
  "structuralSignal": true,
  "curriculum": false
}
```

- Every key is optional; absent means the app's configuration, exactly as today.
- The values are resolved once, when the run starts, and stored in `effectiveConfig.grounding`; a reader never recomputes them.
- `curriculum` cannot be forced to `learning` under a campaign freeze; the freeze wins and the resolved value says `frozen`.
- `stitcher` and `structuralSignal` are booleans in the request (`true` = the app's mode, `false` = off); `effectiveConfig.grounding` keeps the resolved mode (`signal`/`off`) and `null` when the app cannot wire it.
- The lever is for the trusted control plane only. A watched repo cannot set it. The engine never reads a campaign variant label to decide behavior.
- Add the field to the zod contract, `openapi.json`, the SDK and the campaign CLI. This is an additive contract change.

**Matrix.** One-at-a-time first, because 2^4 combinations are too expensive:

| Variant | Explorer | Stitcher | Structural | Curriculum |
|---|---|---|---|---|
| baseline | app | app | app | app |
| no-explorer | off | app | app | app |
| no-stitcher | app | off | app | app |
| no-structural | app | app | off | app |
| no-curriculum | app | app | app | off |

- Cases: R4 and one cross-repo case with a ground truth. Add a no-op case (for example C3) once the pilot is clean.
- Replicates: at least 3; 5 preferred.
- Same app and SHA per case; alternating order by replicate; campaign freeze on; warm suite; cleanup before each arm-run; same capture mode.
- **Isolate engram per arm** (fresh `ENGRAM_DATA_DIR` or a stopped/started agents service with a fresh directory). Today's campaign does not, and the docs call it a known confound. For a grounding A/B it is not acceptable: the explorer and generator learn across replicates.
- Verify the lever took effect from `effectiveConfig.grounding`; a run whose resolved value does not match its variant is marked `not-comparable`, never silently averaged.
- Verify the data state before each arm-run and record the fingerprint; exclude or stratify runs whose state differs.

**Outcome metrics.** The campaign already re-runs delivered specs twice with no retry, which is the validity measure. Compare, per variant:

- validity rate (the campaign's `valid`, not the arm's own verdict);
- pass rate and flaky rate;
- reviewer approval/rejection and the correction classes;
- change-coverage status/ratio;
- cost (USD, tokens) and cost per useful spec;
- grounding phase time and the cost of the source (explorer turn, DOM capture child, stitcher/graph time);
- `context_utilization[.<source>]` (gross), `context_utilization_focused[.<source>]` (optimized), `context_complete`, `context_fresh`, `referenced_not_provided`;
- ground-truth recall/precision (D7);
- error classes (`E-*`) and infra-error rate.

**Analysis.** Pair runs by case + SHA + replicate. Report the mean and a bootstrap 95% CI per variant, and the **paired delta** against baseline with its CI. Never call a difference a lift with fewer than 3 pairs. Report `insufficient-replicates` otherwise. The existing campaign report already does per-variant aggregates; extend it with the grounding key, the paired delta, and a check that `effectiveConfig.grounding` really differed.

**Pilot.** Two cases × four variants (baseline, no-explorer, no-stitcher, no-structural) × 3 replicates = 24 pipeline runs, plus the validity re-runs. Add `no-curriculum` only if the curriculum is actually non-empty in the freeze-off configuration. Stop and fix the measurement before scaling.

### D7. Ground truth for the explorer and the stitcher

`probe-report --ground-truth` already scores the explorer's blast-radius files, the files the agent read, and the routes the specs navigate to. Extend the same offline, case-specific artifact:

```json
{
  "case": "service ... seen from app ...",
  "affectedFiles": ["src/..."],
  "affectedRoutes": ["/restaurantes/:province/:city"],
  "notAffectedFiles": ["src/..."],
  "notAffectedRoutes": ["/home"],
  "affectedLinks": ["org/app/symbol→org/service/symbol"],
  "notAffectedLinks": [],
  "affectedOperations": ["getRestaurants"],
  "notAffectedOperations": [],
  "devDataState": { "note": "0 restaurants on DEV", "resultCount": 0 },
  "changedElements": [{ "testId": "save-btn", "role": "button", "name": "Save" }]
}
```

Score these sources with the existing `SourceScore` shape (named, hits, misses, false positives, precision, recall):

| Source | Scored against |
|---|---|
| Explorer brief blast radius (existing) | `affectedFiles` |
| Explorer brief routes (new) | `affectedRoutes` |
| Explorer brief links/contracts (new) | `affectedLinks`, `affectedOperations` |
| Stitcher delivered `svc-link` ids (new) | `affectedLinks` |
| Route ranking relevant ids (new) | `affectedRoutes` |
| Context map routes (new) | `affectedRoutes` (map completeness) |
| Spec `goto` routes (existing) | `affectedRoutes` |
| Files read (existing) | `affectedFiles` |

Add a ground-truth file for R4 (the `config/benchmarks/ground-truth/` directory currently has files for the cross-repo cases, not R4). Keep `notAffected*` populated: precision is as important as recall for a context source.

Ground truth stays an **offline benchmark artifact**. It is hand-written per case, so it is not a runtime score and never gates a run. The per-run scores are `context_utilization`, `context_utilization_focused`, `context_complete` and `context_fresh`; the ground truth tells you whether the sources found the right targets in the first place.

### D8. What the six items do not define, and this ADR adds

1. **Source status and presence.** A source that was not attempted, returned empty, failed, or was skipped is not the same as one that was delivered. Record `status` and `reason` on the produced span. This is required for the A/B: "no explorer" and "explorer failed" must not be averaged together.
2. **Delivered vs produced.** D1. Without it, utilization counts items the agent never saw.
3. **Precision / hallucination.** `referenced_not_provided` (D2). A context source can mislead as well as help.
4. **Changed-element observability and no-op consistency.** Record `changed_element: present | absent | unknown` per changed element. `noop_consistent` is graded only when the state is known. R4 is `unknown` because the change is a label binding; that is a fact, not a failure.
5. **Freshness as a score, not only an attribute.** `context_fresh` (D5) records whether the sources the generator used were fresh when it used them. R4 is `false` because the grounding DOM saw 0 results and the review DOM saw 11 in the same run. This is separate from `context_complete` and must not be folded into it.
6. **Data-state and environment fingerprint.** For the A/B, record the observed DOM fingerprint and the case's expected data state; verify before each arm-run. Otherwise R4's expected outcome depends on a variable the experiment does not control.
7. **Cross-run learning beyond learned rules.** The accepted suite (suite store + manifest) and engram are the strongest "learning from previous runs" signals. The suite restore is traced, but the manifest's specs are not in the context source list and engram use is only visible as `engram_mem_*` tool calls. Add `spec:<path>` delivered ids for the manifest in a follow-up, and measure engram calls in the A/B isolation check. Do not conflate them with the learned-rule section.
8. **Cost and time per source.** Explorer turn duration/tokens, DOM capture child duration, stitcher/graph time. The A/B cost comparison needs it; the current context spans are point-in-time and show 0 ms.
9. **Versioning.** Bump `GRADER_VERSION` for the new context semantics (the extractor is part of the grader). Old scores are not comparable; a regrade recomputes with the new version. Record the extractor version in the score's `graderVersion`.
10. **No gate.** These scores are observe-only. `context_complete` and `context_fresh` never block a run; neither utilization score changes a verdict. The first use is the A/B, not a quality gate.

## 6. Consequences

**Positive**

- The pipeline can answer "what did we give, what did the agent see, what did it use, how fresh was it, and did it help?" from traces and scores, without a container shell.
- The gross/focused pair separates two questions: how noisy is delivery today (`context_utilization`), and how well did the agent use the change-relevant context (`context_utilization_focused`).
- `context_complete` becomes meaningful because selection, degradation and truncation are separated.
- The A/B can attribute a change in validity/pass rate/coverage/cost to a specific grounding source.
- Ground truth makes the explorer and stitcher scoreable against the same affected files/routes/links as the specs.
- No run-time behavior changes for normal runs: the delivered spans and metrics are observe-only; the only side effect is the off-path map rebuild request, which is deduplicated and never blocks.

**Negative / costs**

- Prompt builders and the assembler gain section metadata (`itemIds`, `omissions`); the context pack returns delivered ids. This is a cross-cutting refactor with tests.
- The evaluation evidence adapter and graders gain a new evidence shape; two utilization families double the score surface; `GRADER_VERSION` moves to 2. The gross score is intentionally noisy and must not be read as a grade.
- More spans and attributes per run; retention is 30/180 days and the ids are capped at 200 per span.
- The A/B is expensive: multiple variants × cases × replicates, plus validity re-runs. The pilot is deliberately small.
- Ground truth is hand-written and per case; it does not scale by itself.

**Risks**

- **Denominator gaming.** A utilization ratio can be made to look good by shrinking the provided set. The comment must show `referenced/provided` and the scope; the A/B must use the same extractor version.
- **Extractor false negatives.** Helpers, variables and dynamic selectors are unattributed. Treat utilization as a lower bound and compare, not as an absolute grade.
- **Route matching.** Concrete paths must map to template ids; a mismatch would undercount route use. Test the R4 concrete-to-template case.
- **DOM role hash drift.** The `hash8` normalization must stay identical between `context-item-ids.ts` and the extractor. A shared helper, not a copy, is the safe choice.
- **Stale-map rebuild queue.** A rebuild request could queue behind runs. Deduplicate, cap the interval, and never block the current run.
- **A/B confounds.** engram leakage, DEV data state, provider quota/latency, host sleep and warm-suite differences can dominate a small sample. Record the environment fingerprint and isolate engram; report the confounds.
- **Sensitive ids.** Ids can contain repo names, route paths and accessible names. They are already in the prompt and pass through the run's secret redaction; keep the `clean`/cap behavior and do not export prompt text.

## 7. Alternatives considered

- **Use produced ids as the utilization denominator.** Rejected: it counts pages the pack cut and nodes the cap removed; the R4 prototype was 1.1% over 263 nodes, which is not actionable.
- **Parse the rendered prompt text to recover delivered ids.** Rejected: sanitization/redaction can change names, so hashes would not match; and it duplicates every renderer's format.
- **Count every cut as incompleteness.** Rejected: `MAX_ROUTES = 4` would make every run incomplete. Selection is a budget decision; ground-truth recall measures whether it chose well.
- **Config-only A/B (restart between arms).** Rejected as the primary path: expensive, non-interleaved and confounded by time. Keep it as a fallback if request levers are not acceptable.
- **An LLM judge for grounding quality now.** Rejected for the first phase: circular, expensive, and it would share the provider quota. Deterministic extraction + ground truth first; a judge can come later, calibrated.
- **Keep everything in `probe-report` only.** Rejected: the A/B and regrades need per-run scores; an offline report cannot be joined to `run_scores` or Prometheus.

## 8. Implementation plan

No code in this ADR. After approval, the work should go through SDD, one phase per PR, with the tests from `docs/testing-standards.md`.

**Phase 1 — Delivered spans and metrics**

- Add `itemIds` and `omissions` to the prompt section metadata; return them from `renderArchitectureContextParts`, `buildContextPack`, the brief renderer, the service-links/structural/learning/curriculum renderers.
- Record `qayaba.context.delivered.<source>` under the generation turn; keep produced spans.
- Add the instruments and registry keys; update the context-trace tests and the id-stability tests.
- Acceptance: for every grounding section, `delivered.ids ⊆ produced.ids`; a section that is shed or capped records `omitted` with a reason; no run verdict changes with telemetry on/off.

**Phase 2 — Context evidence and graders**

- Add context evidence to `RunEvaluationEvidence`: produced/delivered sources, `omitted`, `relevant_ids`, spec snapshots, tool sequences, file reads.
- Add `context-refs.ts` (pure) and three graders: `context_utilization` (gross), `context_utilization_focused` (optimized) and `context_complete`; add a `context_fresh` catalog entry (BOOLEAN, observe-only) and its grader; add `context_utilization_focused` to the catalog with suffixes `route|dom|op`; flip the existing `context_utilization`/`context_complete` entries to `graded`; bump `GRADER_VERSION` to 2.
- Add the R4 fixture test: gross route 1/41, gross dom ~3/263, gross overall ~1.3%; focused route 1/1 (RestaurantListPage), focused dom n/a; complete true; fresh false (map sha-mismatch and DOM 0 vs 11); map stale.
- Acceptance: a regrade of the two R4 runs produces both score families as expected; `n/a` is a missing score, never 0; a run with no grounding omits the scores.

**Phase 3 — Freshness and recapture**

- Add the provenance block to the context map loader, DOM capture, explorer, stitcher, structural signal, learning/curriculum and suite restore.
- Extend the existing `context_stale` + `requestContextHeal` path with the SHA/age policy and the off-path rebuild request; record the outcome. Do not add a second rebuild mechanism.
- Record `captured_at`, `settled`, `nodes`, `test_ids` and the change-relevant `dom:` fingerprint for the ground, pre-exec and review captures; compare them and set `stale_reason=dom-changed` when they differ.
- Add the optional `list_items` count; add the graph `lastIndexedSha` and stitcher fetch status.
- Acceptance: the R4 run records `location=db`, `captured_sha=549e0649`, `result_count=112`, `stale=true`, `stale_reason=sha-mismatch`, `recapture=requested`, and a DOM consistency check that reports `0` grounding results vs `11` review results; a fresh map records `stale=false`, `recapture=not-needed`.

**Phase 4 — Ground truth**

- Extend `GroundTruth` with links, operations, data state and changed elements; extend `scoreGroundTruth` and the probe report table.
- Add the R4 ground-truth file and fill the cross-repo links/operations.
- Acceptance: the probe report shows one row per source with named/hits/misses/false positives/precision/recall; the R4 brief's correct files score as hits, the malformed path as a miss.

**Phase 5 — Grounding A/B**

- Add the request `grounding` levers, the contract/OpenAPI/SDK fields, `effectiveConfig` verification and the campaign CLI.
- Add the grounding variant matrix, paired analysis and the report columns.
- Isolate engram per arm; verify the data state before each arm-run.
- Pilot: R4 + one cross-repo, baseline/no-explorer/no-stitcher/no-structural, 3 replicates. Add a no-op case after the pilot is clean.
- Acceptance: the report shows n, mean ± CI, paired delta vs baseline, and `insufficient-replicates` below 3 pairs; every run's `effectiveConfig.grounding` matches its variant.

**Rollout**

- The scores are observe-only. Do not gate a run on `context_complete`, `context_fresh`, `context_utilization` or `context_utilization_focused`.
- Add Grafana panels for the new context metrics after Phase 1; the eval dashboard already shows the scores once Phase 2 lands.
- Re-measure the "context resource" verdicts in `docs/observability-context.md` §7 after the pilot.

## 9. Resolved decisions

Approved on 2026-10-19. No product questions remain open.

| # | Decision | Resolution |
|---|---|---|
| 1 | Utilization denominator | **Two scores.** `context_utilization` is the gross ratio over **all delivered** extractable items; it is the baseline the product will improve by refining delivery. `context_utilization_focused` is the optimized ratio over the **change-relevant** subset, grouping routes by component/page and limiting DOM to the changed element(s); `n/a` when no element is identifiable. Both share the extractor; gross is the refinement target, focused is the normalized quality signal. |
| 2 | A/B levers | **Request-level `grounding` levers**, additive contract, trusted control plane, verified against `effectiveConfig.grounding`. Config-only arms with restarts remain a fallback. |
| 3 | Map rebuild policy | **14 days** max age, **6 h** minimum interval between off-path rebuilds, **SHA mismatch always stale**; extend the existing `context_stale`/`requestContextHeal` path. |
| 4 | First pilot | **2 cases** (R4 + one cross-repo) × **4 variants** (baseline/no-explorer/no-stitcher/no-structural) × **3 replicates** = 24 pipeline runs, plus validity re-runs. The no-op case comes after the pilot. |
| 5 | Precision score | Keep `referenced_not_provided` as a comment/counter first; add `context_precision` only after the pilot if it is stable. |
| 6 | Freshness score | `context_fresh` is an **observe-only BOOLEAN** score; it is compared in the A/B and never gates. |
| 7 | Changed-element extraction | Keep `changed_element=unknown` for label-only bindings and `noop_consistent=n/a`; extend the diff parser only if the pilot shows this class is common. |

## Appendix A — R4 trace evidence

Run `run-ec03222-mvflk6se-063f8199` (sha `ec03222b621e995f7fabb96006c16ae6bce37fee`, 2026-10-19):

- Verdict `pass`, `errorClass E-FALSE-POSITIVE`, decision `shadow-log`; reviewer rejected two tests as false positives.
- Grounding 45.7 s; generation 50.1 s; review 298.5 s.
- Context map: 41 routes, 22 operations, 43 links, 6 flows (112 items), 27,546 bytes, `builtAtSha 549e0649`, stored 2026-10-11T16:38:31Z.
- Explorer brief: 12 items, 2,384 bytes; it named the correct files and routes, but its `domLandmarks` were marked `GUESS` and `verified: false`.
- Route ranking: 4 ids, 21 selected out; `/restaurantes` first. The pack captured `/restaurantes`, `/home`, `/login`, `/login/callback`, plus `/restaurantes/madrid` and `/restaurantes/madrid/madrid` as template instances.
- The pack's ground capture of `/restaurantes`: 14 nodes, 0 test ids, 7 runtime errors; the pack text shows `text: 0 resultados`, `list: (present)`, no restaurant list items.
- A later capture of `/restaurantes` (the pre-exec or review pass): 39 nodes. The review DOM shows 11 results with restaurants listed. The grounding DOM and the review DOM disagree.
- `/home`: 94 nodes, 34 omitted by the node cap.
- DOM captures total 344 ids across 5 spans; the pack delivered 5,713 bytes.
- The diff changed `endActionLabel="Filtrar"` to `"Cambiar filtros"` on an Angular component; `DiffParserService.changedElements` returned `[]`, so the pack had no `fact:` for the changed element.
- The generated spec used `/restaurantes` and the empty-state CTA; the reviewer rejected the empty-state assertions against the 11-result DOM and the tests could not distinguish the renamed button.
- The correct R4 outcome depends on the data state: with 0 restaurants, a reasoned no-op; with results, a test of the renamed end-of-list button. The agent wrote a spec against the stale 0-result sample. This is both a grounding-to-decision gap and a freshness gap.

What the proposed telemetry would add for this run:

```
context-map: location=db, captured_sha=549e0649, result_count=112,
             stale=true, stale_reason=sha-mismatch, age≈8d, recapture=requested
route-ranking: relevant_ids=[route:/restaurantes, route:/restaurantes/:province,
                             route:/restaurantes/:province/:city]
delivered.context-pack: ids=[dom:/restaurantes#..., ...], omitted={node-cap: 34 on /home},
                        scope=change-relevant
context_complete=true        (the pack's relevant page is complete; /home is not relevant)
context_fresh=false          (map sha-mismatch; DOM 0 results at grounding vs 11 at review)
context_utilization (gross):     route 1/41, dom ~3/263, op n/a, overall ~1.3%
context_utilization_focused:     route 1/1 (RestaurantListPage), dom n/a, op n/a
changed_element=unknown
noop_consistent=n/a
dom_capture_consistent=false (0 vs 11 results on the change-relevant route)
```

The point is not that these values are flattering. The point is that they are **honest**: the gross score records the noisy delivery the product wants to improve, the focused score does not invent a DOM utilization for a label-only change, they record the stale map and the stale DOM sample, and they separate the selection of 4 routes from the node-cap truncation of a non-relevant page.

## Appendix B — Closed sets

- **Sources:** `learning`, `curriculum`, `context-map`, `route-ranking`, `dom-capture`, `context-pack`, `service-links`, `structural-signal`, `cross-repo-impact`, `explorer-brief`.
- **Status:** `delivered`, `empty`, `skipped`, `failed`.
- **Reason (status):** `no-rules`, `no-exemplars`, `no-map`, `no-brief`, `capture-failed`, `empty-render`, `redirect`, `not-capturable`, `resolver-empty`, `graph-empty`, `frozen`, `disabled`.
- **Selection reason:** `route-cut`, `link-selection`, `exemplar-selection`, `rule-selection`.
- **Truncation reason:** `node-cap`, `line-cap`, `section-cap`, `section-shed`, `map-cap`, `link-cap`, `brief-cap`, `signal-cap`, `exemplar-cap`, `rule-cap`.
- **Freshness reason:** `sha-mismatch`, `older-than-max-age`, `marked-stale`, `empty`, `capture-failed`, `fetch-failed`, `dom-changed`, `none`.
- **Recapture outcome:** `not-needed`, `requested`, `completed`, `failed`, `skipped`.
- **Utilization families:** `context_utilization` (gross, all delivered), `context_utilization_focused` (change-relevant, grouped by component/page). Both share the extraction: `extractable` (`route`, `dom`, `op`), `not-extractable` (`link`, `flow`, `rule`, `exemplar`, `brief`, `fact`, `signal`, `svc-link`, `impact`), `reported-separately` (`file` → `prompt_provided_reread`).
