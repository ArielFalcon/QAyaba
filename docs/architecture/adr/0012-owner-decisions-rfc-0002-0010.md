# ADR-0012: Owner decisions on RFC-0002 to RFC-0010

- **Status:** Accepted, 2026-10-28, owner
- **Decision source:** the owner's answer of 2026-10-28, "I approve all the decisions with your recommendation" (translated), to the question whether the recommended answers to the 60 open questions of RFC-0002 to RFC-0010 (Correction 2026-10-29: this record said 56; the RFCs' own lists hold 60: RFC-0002 15, RFC-0003 5, RFC-0004 5, RFC-0005 5, RFC-0006 5, RFC-0007 6, RFC-0008 5, RFC-0009 6, RFC-0010 8) were approved as written, six of them named.
- **Code references at:** 4105c582
- **Related:** [RFC-0002](../rfc/0002-platform-steps-0-1.md), [RFC-0003](../rfc/0003-coverage-dump-harvest.md), [RFC-0004](../rfc/0004-log-level-from-outcome.md), [RFC-0005](../rfc/0005-suite-store-single-writer.md), [RFC-0006](../rfc/0006-review-answer-crosses-whole.md), [RFC-0007](../rfc/0007-dev-write-attribution.md), [RFC-0008](../rfc/0008-acceptance-records-what-it-ran.md), [RFC-0009](../rfc/0009-pack-record-matches-prompt.md), [RFC-0010](../rfc/0010-tool-call-record-outcome.md), [ADR-0011](0011-root-cause-fix-policy.md)

## Context

RFC-0002 (platform steps 0-1) and RFC-0003 to RFC-0010 (the eight root causes confirmed and alive on main: H06, H11, H20, N02, N04, N06, N09, N12) left 60 questions (Correction 2026-10-29: 56 before) under "Owner decisions needed", each with a recommended answer. To save time, the owner was asked to answer them at once ("speed the process up a bit, the quota limit is close", translated), with six named because they reopen an earlier decision, read a rule of the investigation, change a guard, or touch stored data.

## Decision

1. Every recommended answer under "Owner decisions needed" in RFC-0002 to RFC-0010 is accepted as written. Each RFC's table is the record of its answers, and each RFC is Accepted.
2. The six named answers:
   - RFC-0003, question 1: the decision of `48f26eaa` (no worker thread) is reopened for CPU work: one worker per call, no pool; the caps stay as the bound on one dump.
   - RFC-0006, F1: the rule "only confirmed causes are fixed" ([ADR-0011](0011-root-cause-fix-policy.md)) covers every site of a confirmed mechanism that a deterministic probe reproduces on main, even with no run: option O3.
   - RFC-0007: a write the spec caused is one a no-action control load does not send; the protocol-shape exemption is deleted; the change ships alone, in its own commit.
   - RFC-0002, Q1: the previous-forms gate skips path and citation checks under `docs/architecture/` and keeps the banned-term rules.
   - RFC-0002, Q8: the D2 reset runs only with the exact statement the owner authorizes at that time, after a copy of the history file.
   - RFC-0002, Q4: the stub learning repository and its port are deleted with the rule loop, against the audit's "keep with a corrected header".
3. Not decided here: the open questions of [RFC-0001](../rfc/0001-dormant-features.md) (OD-1 to OD-20), [ADR-0001](0001-design-pillars.md), [ADR-0002](0002-architecture-direction.md) and the [README](../README.md). They block neither steps 0-1 nor the slices.

## Consequences

- Implementation follows the approved order: platform steps 0-1 (RFC-0002), then one slice per confirmed family (RFC-0003 to RFC-0010), then platform steps 4-6.
- Each RFC's test plan is the RED test of the commit that lands it; each measurement follows ADR-0011 (one replicate: a direction, not proof).
- Two actions still need the owner at the time they run: the D2 statement (RFC-0002, Q8) and the GitHub part of D11 ([ADR-0010](0010-maintainer-removal.md)).

## Enforcement

The RED tests named in each RFC's test plan, added with the commit that lands it. The gate change of RFC-0002, Q1 lands in its own commit before the first deletion.

## Alternatives considered

Deciding the 60 questions one at a time: set aside by the owner to save time.
