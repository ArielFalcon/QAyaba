/* PublicationPort: injected decide collaborator owns the verdict → PR/Issue/shadow/quarantine/noop mapping; this bridge only dispatches. Duck-typed local interfaces — this file must not import workspace-and-publication (agent is read-only; only the orchestrator does git writes). */

import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { SecretLeakError } from "@kernel/ports/redaction.port.ts";
import type { PublicationPort } from "../../application/ports/index.ts";

/* Local structural mirror of workspace-and-publication's PublishContext/PublishDecision (domain/publish-decision.service.ts) — duck-typed, NOT imported, per the security-boundary note. */
export interface PublishDecisionCollaborator {
  decide(ctx: {
    verdict: RunVerdict;
    reviewerApproved: boolean;
    coverageBlocks: boolean;
    shadow: boolean;
    e2eChanged: boolean;
  }): { outcome: "pr" | "issue" | "shadow" | "quarantine" | "noop"; reason: string };
}
/* Local structural mirrors of GitHubPrPort / GitHubIssuePort / ShadowPublicationPort's own publish surface (workspace-and-publication/application/ports/index.ts) — duck-typed, NOT imported. */
export interface GitHubPrCollaborator {
  openWithAutoMerge(repo: string, branch: string, title: string, body: string): Promise<{ url: string; number: number }>;
}
export interface GitHubIssueCollaborator {
  open(repo: string, title: string, body: string): Promise<{ url: string; number: number }>;
}
export interface ShadowLogCollaborator {
  openPr(repo: string, branch: string, title: string, body: string): Promise<void>;
  /* Shadow previews the underlying side effect: an Issue-shaped suppression logs through openIssue, never openPr. Optional; absent skips the Issue preview. */
  openIssue?(repo: string, title: string, body: string): Promise<void>;
}
/* Git-write step before opening a PR: stage + commit + push generated tests to `branch`. Duck-typed local mirror — this file must not import VcsWritePort. `changed: false` means skip the PR (honor the agent's no-op). */
export interface VcsPublishCollaborator {
  publish(input: { mirrorDir: string; branch: string; sha: string }): Promise<{
    changed: boolean;
    /* Tracked-file denylist revert, forwarded so RunQaUseCase can merge it into gateSignals.confinement. Optional on stubs. */
    revertedDenylisted?: string[];
    revertedDangerous?: string[];
  }>;
}

/* Distilled Issue/PR body renderers. Duck-typed — this file cannot import workspace-and-publication. Required: there is no safe fallback body. Rendered bodies must not embed raw execution logs. */
export interface PublicationRenderCollaborator {
  issue(input: {
    verdict: RunVerdict;
    cases: readonly QaCase[];
    sha?: string;
    tested?: { flow?: string; objective?: string }[];
    adjudication?: { class: string; confidence: string; reason: string };
    reviewerNote?: string;
  }): string;
  prBody(input: {
    sha?: string;
    isCode: boolean;
    tested?: { flow?: string; objective?: string }[];
    parentRunId?: string;
  }): string;
}

export interface PublicationPortCollaborators {
  decide: PublishDecisionCollaborator;
  pr: GitHubPrCollaborator;
  issue: GitHubIssueCollaborator;
  shadowLog: ShadowLogCollaborator;
  render: PublicationRenderCollaborator;
  /* Required. Constructor throws if absent — no identity default (fail-closed on public Issue/PR bodies). Injected; qa-engine never imports src/orchestrator/sanitizer.ts. */
  sanitize: (text: string) => string;
  /* Optional at the type (only the "pr" route uses it). Absent + "pr" route → publish() throws rather than opening a PR against an unpushed branch. */
  vcsWrite?: VcsPublishCollaborator;
  /* Post-redaction fail-loud check, "issue" route only. Optional at the type; production always supplies RedactionPort.containsSecret. Absent → the issue publishes without this extra check. */
  containsSecret?: (text: string) => boolean;
}

export interface PublicationPortStaticContext {
  repo: string;
  branch: string;
  reviewerApproved: boolean;
  coverageBlocks: boolean;
  shadow: boolean;
  e2eChanged: boolean;
}

/* Sanitize the verdict in the title the same way every other rendered field is sanitized. */
function renderTitle(verdict: RunVerdict, sanitize: (text: string) => string): string {
  return `qa-bot: ${sanitize(verdict)} run`;
}

export class PublicationPortAdapter implements PublicationPort {
  constructor(
    private readonly deps: PublicationPortCollaborators,
    private readonly ctx: PublicationPortStaticContext,
  ) {
    /* Fail-closed: a loose object can omit a required TS field — throw rather than identity-pass secrets into a public Issue. */
    if (typeof this.deps.sanitize !== "function") {
      throw new Error(
        "PublicationPortAdapter: 'sanitize' is a REQUIRED collaborator — " +
          "the composition root must inject the real sanitizeText; refusing to default to identity.",
      );
    }
    /* Fail-closed: missing renderers must not fall back to embedding raw logs. */
    if (typeof this.deps.render?.issue !== "function" || typeof this.deps.render?.prBody !== "function") {
      throw new Error(
        "PublicationPortAdapter: 'render' is a REQUIRED collaborator — " +
          "the composition root must inject the real renderIssue/renderPrBody (workspace-and-publication/domain/render-publication.ts); refusing to fall back to a raw-log embed.",
      );
    }
  }

  async publish(decision: {
    verdict: RunVerdict;
    cases: readonly QaCase[];
    logs: string;
    reviewerApproved?: boolean;
    coverageBlocks?: boolean;
    e2eChanged?: boolean;
    issueRepo?: string;
    adjudication?: { class: string; confidence: string; reason: string };
    /* Reviewer-unavailable rationale (fail-closed catch), never a genuine rejection. Absent → no section. */
    reviewerNote?: string;
    /* Per-run mirrorDir + sha for the "pr" git-write. Optional at the type; required in practice on that route. */
    mirrorDir?: string;
    sha?: string;
    tested?: { flow?: string; objective?: string }[];
    isCode?: boolean;
    parentRunId?: string;
  }): Promise<{ outcome: string; revertedDenylisted?: string[]; revertedDangerous?: string[] }> {
    const publishDecision = this.deps.decide.decide({
      verdict: decision.verdict,
      reviewerApproved: decision.reviewerApproved ?? this.ctx.reviewerApproved,
      coverageBlocks: decision.coverageBlocks ?? this.ctx.coverageBlocks,
      shadow: this.ctx.shadow,
      e2eChanged: decision.e2eChanged ?? this.ctx.e2eChanged,
    });

    const sanitize = this.deps.sanitize;
    const title = renderTitle(decision.verdict, sanitize);
    /* Distinct Issue vs PR bodies, built lazily per route. decision.logs is never read — raw logs must not reach a public body. Each composed body is sanitized once as a whole string. */
    const issueBody = (): string =>
      sanitize(
        this.deps.render.issue({
          verdict: decision.verdict,
          cases: decision.cases,
          ...(decision.sha ? { sha: decision.sha } : {}),
          ...(decision.tested?.length ? { tested: decision.tested } : {}),
          ...(decision.adjudication ? { adjudication: decision.adjudication } : {}),
          ...(decision.reviewerNote ? { reviewerNote: decision.reviewerNote } : {}),
        }),
      );
    const prBodyText = (): string =>
      sanitize(
        this.deps.render.prBody({
          ...(decision.sha ? { sha: decision.sha } : {}),
          isCode: decision.isCode ?? false,
          ...(decision.tested?.length ? { tested: decision.tested } : {}),
          ...(decision.parentRunId ? { parentRunId: decision.parentRunId } : {}),
        }),
      );
    /* Issues open in the triggering repo when supplied; PRs always target ctx.repo (primary). */
    const issueRepo = decision.issueRepo ?? this.ctx.repo;

    switch (publishDecision.outcome) {
      case "shadow": {
        const underlying = this.deps.decide.decide({
          verdict: decision.verdict,
          reviewerApproved: decision.reviewerApproved ?? this.ctx.reviewerApproved,
          coverageBlocks: decision.coverageBlocks ?? this.ctx.coverageBlocks,
          shadow: false,
          e2eChanged: decision.e2eChanged ?? this.ctx.e2eChanged,
        });
        if (underlying.outcome === "pr") {
          await this.deps.shadowLog.openPr(this.ctx.repo, this.ctx.branch, title, prBodyText());
        } else if (underlying.outcome === "issue") {
          await this.deps.shadowLog.openIssue?.(issueRepo, title, issueBody());
        }
        /* quarantine/noop suppressed side effects have nothing to preview — the reason says it all. */
        return { outcome: `shadow: ${publishDecision.reason} (would: ${underlying.outcome})` };
      }
      case "pr": {
        /* Stage/commit/push generated tests to this.ctx.branch BEFORE opening the PR. Missing vcsWrite on this route throws — never open a PR against an unpushed branch. */
        if (!this.deps.vcsWrite) {
          throw new Error(
            "PublicationPortAdapter: 'vcsWrite' is a REQUIRED collaborator for the 'pr' route (PROD-BLOCKER fix — " +
              "the agent's generated tests must be staged/committed/pushed before the PR is opened) — " +
              "the composition root must inject the real git-write collaborator; refusing to open a PR against an unpushed branch.",
          );
        }
        /* mirrorDir/sha are optional at the type but required on a real "pr" route — throw rather than push to "". */
        if (!decision.mirrorDir || !decision.sha) {
          throw new Error(
            "PublicationPortAdapter: the 'pr' route requires decision.mirrorDir and decision.sha (the per-run values " +
              "RunQaUseCase threads from WorkspacePort.prepare()/input.sha) — refusing to stage/commit/push with no mirror to operate on.",
          );
        }
        const written = await this.deps.vcsWrite.publish({
          mirrorDir: decision.mirrorDir,
          branch: this.ctx.branch,
          sha: decision.sha,
        });
        if (!written.changed) {
          return { outcome: "noop: vcsWrite reported no changes to publish — the suite already covers the change, no PR opened" };
        }
        const pr = await this.deps.pr.openWithAutoMerge(this.ctx.repo, this.ctx.branch, title, prBodyText());
        /* Forward the tracked-file denylist revert. Never fabricated: absent/empty stays omitted. */
        return {
          outcome: `pr: ${pr.url}`,
          ...(written.revertedDenylisted?.length ? { revertedDenylisted: written.revertedDenylisted } : {}),
          /* Same as revertedDenylisted — never fabricated, absent/empty stays omitted. */
          ...(written.revertedDangerous?.length ? { revertedDangerous: written.revertedDangerous } : {}),
        };
      }
      case "issue": {
        const body = issueBody();
        /* After sanitize: if a secret is still detectable, refuse to open the Issue. This file cannot import src/; the check is injected. */
        if (this.deps.containsSecret?.(body)) {
          console.error("[publication] logs→Issue: a secret survived redaction — refusing to open the Issue");
          throw new SecretLeakError("logs→Issue: a secret survived redaction — refusing to open the Issue");
        }
        const issue = await this.deps.issue.open(issueRepo, title, body);
        return { outcome: `issue: ${issue.url}` };
      }
      case "quarantine":
        return { outcome: `quarantine: ${publishDecision.reason}` };
      case "noop":
      default:
        return { outcome: `noop: ${publishDecision.reason}` };
    }
  }
}
