import { scoreProfile, selectBestProfile, type ProfileScore } from "./profile-scorer.ts";
import type { ProfileProposerPort, ProposerFeedback } from "./ports/index.ts";
import type { BoundaryProfile, RepoRef } from "../domain/index.ts";

/** Round-ceiling counter for the onboarding loop. Local to this context — not qa-run-orchestration's CycleBudget. */
export class OnboardingBudget {
  private count = 0;

  constructor(private readonly ceiling: number) {}

  exhausted(): boolean {
    return this.count >= this.ceiling;
  }

  tick(): void {
    this.count += 1;
  }
}

/** One scored candidate in the onboarding audit trail. */
export interface ScoredCandidate {
  profile: BoundaryProfile;
  score: ProfileScore;
}

export interface OnboardingResult {
  /** The winning profile, or null if none resolved anything within the round budget. */
  profile: BoundaryProfile | null;
  /** Every candidate scored across every round — the full audit trail, in round order. */
  candidates: ReadonlyArray<ScoredCandidate>;
  /** How many rounds actually ran (<= the constructor's ceiling). */
  rounds: number;
}

/** Local to this context: no transport concerns leak in. */
export interface OnboardingRoundProgress {
  round: number;
  proposed: number;
  scored: number;
  bestResolvedScore: number;
}

/** Drives the deterministic onboarding loop. Fail-open by construction: a proposer that returns an empty array OR throws costs the loop one round, never a crash (mirrors ProfileProposerPort's own fail-open contract). */
export class OnboardingService {
  constructor(
    private readonly proposer: ProfileProposerPort,
    private readonly ceiling = 3,
    private readonly onRound?: (p: OnboardingRoundProgress) => void,
  ) {}

  async onboard(system: RepoRef[], front: RepoRef): Promise<OnboardingResult> {
    const budget = new OnboardingBudget(this.ceiling);
    const candidates: ScoredCandidate[] = [];
    let rounds = 0;

    while (!budget.exhausted()) {
      rounds += 1;
      budget.tick();

      const feedback: ProposerFeedback = { priorCandidates: candidates.slice() };
      const proposed = await this.proposeSafely(system, front, feedback);

      for (const profile of proposed) {
        const score = await scoreProfile(profile, system, front);
        candidates.push({ profile, score });
      }

      const best = selectBestProfile(candidates);
      try {
        this.onRound?.({
          round: rounds,
          proposed: proposed.length,
          scored: candidates.length,
          bestResolvedScore: best?.score.resolvedScore ?? 0,
        });
      } catch {
      }

      if (best !== null && best.score.resolvedScore > 0) {
        return { profile: best.profile, candidates, rounds };
      }
    }

    return { profile: null, candidates, rounds };
  }

  /** Fail-open wrapper: a throwing proposer is treated as "no candidates this round". */
  private async proposeSafely(system: RepoRef[], front: RepoRef, feedback: ProposerFeedback): Promise<BoundaryProfile[]> {
    try {
      return await this.proposer.propose(system, front, feedback);
    } catch {
      /* Structural safety net only: the production LLM adapter honors the port's own fail-open contract and never throws here, so this fires only if a FUTURE proposer breaks that contract — it is NOT the diagnostic point (that lives in the adapter's catch, the sole site where the real error object and app/model context are still in scope). */
      return [];
    }
  }
}
