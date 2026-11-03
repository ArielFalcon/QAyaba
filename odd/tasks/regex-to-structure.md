# Regex to structure

Objective: replace, where a defined structure already exists, text-scanning regular
expressions with a read of that structure. Branch: `main`. Delivery: work-unit commits.
Runner: `npm test -- <file>`.

## Specs

S1. A navigation of the orchestrator's own authenticated browser is classified from the
answer's own fields (`ok`, `code`, `page.url`, the document status, the count of blocked
requests), never from a text scan of that answer. The Playwright MCP's answer keeps the
text classifier. A call refused before a page loaded (`busy`, `revoked`, `expired`,
`no-calls`, `wrong-agent`, `unknown-session`, `failed`, `invalid-request`) is `unknown`,
not `ok`. A page that answered 401 or 403 is `auth_challenge`; any other 4xx or 5xx is
`http_error`.

S2. `/proc/<pid>/status` is read by field: the line is split at its first `:`, and the
field name selects it. The Prometheus exposition line is split at its first whitespace
that is outside braces and quotes, so a label value holding `}` or a space parses.

S3. One definition of a commit id lives in the kernel. A module that judges a commit id
uses `isCommitSha` / `isObjectName` and `MIN_COMMIT_SHA_CHARS`; it declares no pattern of
its own.

S4. A fixtures module's runtime exports and their declared signatures are read from the
TypeScript syntax tree, never from a text scan that has to blank comments and strings.
A name that is not an export of the module is never reported as one.

S5. (deferred, see Log L3) The Context Pack's route blocks and its claims are carried as
structure from the capture to the reviewer pre-check and the prompt context, instead of
being re-parsed from the rendered text.

S6. (deferred, see Log L3) One spec-navigation extractor is shared by the four modules
that each declare their own `goto(...)` pattern.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S3 | inline | done: kernel owns `MIN_COMMIT_SHA_CHARS`; `use-case-reference` and `version` use it | `f07c9359` |
| T2 | S2 | inline | done: `/proc` fields and Prometheus samples read structurally | `aa760b30` |
| T3 | S1 | inline | done: the browser's own answer is read by field; document status exposed | `71a2fbb1` |
| T4 | S4 | inline | deferred, see L4 | |

## Log

L1. User request (verbatim): "revisa en todos los sitios donde se usa regex en la app y
determina si es la forma mas robusta de resolver ese problema, para evitar tener codigo
flaky" / "el objetivo es identificar donde se puede sutituir el regex por logica mas
robusta, teniendo estructuras definidas para seleccionar sin 'pescar' con regex" /
"revisa que las soluciones respeten la arquitectura del proyecto (hexagonal con DDD) y
que se adhiera bien a la estructura actual, para no introducir codigo de baja calidad.
Aplica la implementacion de las soluciones, analiza bien antes de cambiar todo el codigo
necesario y la logica que es compleja, para que no tomes decisiones a la ligera sin tener
evidencia y haber razonado primero el por que es lo mejor".

L2. Architectural review of the proposed solutions, before implementing. Placement rule
(`docs/architecture.md`): a decision goes to the engine's domain/application; a type two
or more contexts share goes to the kernel; an adapter the process owns once goes to the
platform.

- S1: clean. The domain declares the facts it needs (`AgentBrowserAnswerFacts`), the
  transport adapter that already owns the tool event does the `JSON.parse` at the
  boundary, and the domain classifier stays pure. The facts type goes to the kernel
  because two contexts share it (test-execution serves the answer, generation reads it)
  and the kernel already declares `AGENT_BROWSER_TOOLS` and the browser limits.
- S2: clean. Both are platform adapters over a text resource; the parser is a read of a
  documented line format, with no policy and no engine concern.
- S3: clean, and it answers row 1 of the placement table ("a copy of something the engine
  already has: delete it, import the engine's copy"). `platform/` importing `@kernel/*`
  is already the established direction.
- S4: clean. The compiler is already the repo's parser for a spec
  (`test-execution/domain/intercepted-tests.ts`) and for an app's route table
  (`generation/infrastructure/route-table/angular-router.extractor.ts`), so a domain
  module reading TypeScript with `ts` is precedent, not a new dependency direction.
- S5: NOT a mechanical swap, deferred. The claims are derived from `contextPackContent`
  *after* `withoutPackSection` removes the live DOM, and the pre-check receives a
  `string` field of `RunState` produced by a grounding port. Carrying structure means
  changing a port contract between two contexts and a persisted run field; done quickly
  it would be worse than the defect. It needs its own slice with its own tests.
- S6: deferred, with a reason. The four `goto(...)` patterns are not copies: they differ
  in quote handling (a backreference versus a bracket class) and in what each returns,
  and the ones in `evaluation` feed coverage metrics. Unifying them changes measured
  coverage, so it is a behaviour change that needs a before/after comparison, not a
  refactor.
- Reversed recommendation: `shared-kernel/egress-policy.ts` keeps its hand-written
  grammar. It is a security boundary with a strict accepted set (wildcards, IP literals,
  public suffixes) and `new URL()` would widen what it accepts (userinfo, odd hosts) and
  normalise values the policy compares by identity. Here the regex is the safer tool.

L3. S5 and S6 deferred as above; the rest implemented in this feature.

L4. S4 deferred after reading its tests. `harness-facts.test.ts` pins a *tolerant* contract
on purpose: an unclosed comment or literal hides the rest of the source, and a malformed
export entry exposes nothing while its neighbours are read. The TypeScript parser
recovers differently (it ends an unterminated string at the newline and reports
diagnostics), and the repo's precedent for a source that does not parse
(`test-execution/domain/intercepted-tests.ts`) is to contribute nothing at all. Moving to
the AST therefore changes what the prompt states for malformed fixtures, which is a
behaviour change with its own tests to rewrite, not a refactor. The current failure mode
is under-reporting a fact, which is the safe direction, so the change waits for its own
slice.

L5. Evidence for each task is observed, not asserted: `npm run typecheck` clean,
`npm run arch:check` clean (1275 modules), and the focused suites green
(`agent-browser`, `git-revision`, `nav-outcome`, `call-efficiency-tracker`,
`agent-browser-capability`, `use-case`, `tools-endpoint`, `host-health`,
`backend-health`, `version`). The label-value fix is break-proven: the previous pattern
answers `null` on the fixture line that the new test reads.

L6. Full-suite evidence and its limits. `npm run test:isolated` passes the whole suite
(12535 pass, 0 fail, 2 skipped). The shared-process run reports two failures that pass in
isolation and exercise code this feature does not touch:
`git-hardening.test.ts` ("a gitfile that redirects git…", a filesystem-permission fixture)
and `agent-browser-port.adapter.test.ts` ("an ended session closes its page…", which races
`setImmediate` against the lease chain). Both are recorded here as pre-existing
shared-process flakes, not regressions. `npm run previous-forms:check` reports 8
violations, all in `AGENTS.md`, `docs/engine-platform-architecture.md` and RFC-0016, i.e.
the working tree's pre-existing documentation split, no file of this feature.

L7. Committed on `main` as three work units (T1, T2, T3) plus this document, each staged by
explicit path. Two other change sets were in the working tree and were left untouched: the
pre-existing documentation split (`AGENTS.md` into `docs/architecture.md` and
`docs/risk.md`, and a model-effort setting), and an in-flight fragile-locator feature
(`selector-check.ts`, `pre-flight-grounding`, its tests). Mixing either into these commits
would have made both unreadable.
