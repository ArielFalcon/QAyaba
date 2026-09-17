/* One planned generation objective: named user flow, acceptance criterion, and the symbols/routes it exercises. */

export class Flow {
  private constructor(readonly name: string) {}
  static of(name: string): Flow {
    const n = name.trim();
    if (n.length === 0) throw new Error("Flow: name must be non-empty");
    return new Flow(n);
  }
}

export class Objective {
  private constructor(
    readonly flow: Flow,
    readonly objective: string,
    readonly targets: readonly string[],
  ) {}

  static of(input: { flow: string; objective: string; targets: readonly string[] }): Objective {
    const obj = input.objective.trim();
    if (obj.length === 0) throw new Error("Objective: acceptance criterion must be non-empty");
    return new Objective(Flow.of(input.flow), obj, Object.freeze([...input.targets]));
  }
}
