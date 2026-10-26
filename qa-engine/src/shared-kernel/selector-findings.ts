/* What the selector check finds in a spec against the accessibility trees a run captured: shared by the grounding that runs the check and the fix loop that reads its findings. */

export interface SpecSelectorFindings {
  contradictions: string[];
  absentKeys: Set<string>;
  anyVerifiedPresent: boolean;
  /* Locator family Lever-2 cannot extract — uniqueness is then indeterminate. */
  anyNonExtractable: boolean;
  /* Extracted selector neither present nor verifiable-absent — uniqueness cannot be trusted. */
  anyUnverifiable: boolean;
}

export interface ContradictionOrigin {
  contradiction: string;
  specIndex: number;
}
