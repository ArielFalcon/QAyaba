/* What a selected exemplar looks like where the curriculum, the run flow and the generation prompt meet. */

export interface SelectedExemplar {
  id: string;
  name: string;
  template: string;
  /** Wide string, not ScenarioArchetype: the narrow union adds nothing a caller can act on here. */
  archetype: string;
  /** Caught a real bug for this app — drives the prompt's PROVEN marker. */
  proven: boolean;
  promotionCount: number;
}
