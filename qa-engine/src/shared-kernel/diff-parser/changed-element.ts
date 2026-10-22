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
  scope?: string[];   /* the containers the changed line sits in, nearest first, named as the DOM capture names them (see RepeatedName) */
  /* For a text-only element: how many unchanged lines of `file`, as it is after the change, already hold `text`. Set by a caller that read the file; absent when it was not read. */
  unchangedLines?: number;
}
