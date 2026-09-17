export class AppDefect {
  private constructor(
    readonly isDefect: boolean,
    readonly httpStatus: number | null,
    readonly evidence: string,
  ) {}

  static none(): AppDefect {
    return new AppDefect(false, null, "");
  }

  static fromHttpStatus(status: number): AppDefect {
    const defect = status >= 500 && status <= 599;
    return new AppDefect(defect, status, defect ? `DEV returned HTTP ${status}` : "");
  }

  static fromRunnerInfra(detail: string): AppDefect {
    return new AppDefect(true, null, `runner-infra: ${detail}`);
  }
}
