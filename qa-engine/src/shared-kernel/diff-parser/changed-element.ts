/** Stable HTML selector signal extracted from a diff's added lines (or from manual guidance). */
export interface ChangedElement {
  file: string;       /* repo-relative; "" for guidance-derived entries */
  line: number;       /* 1-based new-side line; 0 for guidance-derived entries */
  testId?: string;    /* data-cy / data-testid / data-test */
  id?: string;
  name?: string;      /* name="" / formControlName */
  text?: string;      /* visible inner text */
  href?: string;      /* resolved path, / or # only */
  role?: string;      /* best-effort tag → ARIA role */
  raw: string;        /* trimmed added line */
}
