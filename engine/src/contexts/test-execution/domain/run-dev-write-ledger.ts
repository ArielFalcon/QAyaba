/*
 * The run's one count of the requests its run_spec calls sent to DEV, against the run's DEV-write cap. Every loop of the run (its
 * own and each flow's) checks and charges this one ledger, so the cap holds across the flows together whatever the plan's size; a
 * flow's own share stays a limit of its own beside it. Pure: no clock, no file. The check that admits a call and the charge of
 * what it wrote are made while the call holds the test account's lease, which every run_spec call of the run shares, so no two
 * calls can both be admitted against the same last write.
 */
export class RunDevWriteLedger {
  private used_ = 0;
  private refused_ = 0;

  constructor(readonly cap: number) {}

  /* Requests that write to DEV the run's executed specs sent. */
  get used(): number {
    return this.used_;
  }

  /* Calls refused for writes: the run's total was spent, or the calling loop's own share was. */
  get refused(): number {
    return this.refused_;
  }

  left(): number {
    return Math.max(0, this.cap - this.used_);
  }

  charge(writes: number): void {
    this.used_ += Math.max(0, writes);
  }

  noteRefused(): void {
    this.refused_ += 1;
  }
}
