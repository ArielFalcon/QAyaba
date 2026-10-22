/* The data a run carries from one phase to the next. Each section is written by the phase that owns it and read by the later ones; it holds no live object, so it can be recorded as it stands. */

import type { CommitIntent } from "../ports/index.ts";

/* What the classifier said about the change. Only a diff run classifies: every other run generates and has no diff. */
export interface Classification {
  diff?: string;
  intent?: CommitIntent;
  reason?: string;
  contradiction?: boolean;
  /** False for a "regression" change, which runs the existing suite without generating. */
  generating: boolean;
}

export interface RunState {
  classification: Classification;
}

export function initialRunState(): RunState {
  return { classification: { generating: true } };
}
