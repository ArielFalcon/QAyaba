/* Whether a spec takes its `test` from the suite's fixtures file, judged on the parsed module. */
export interface SpecFixturesCheckPort {
  importsTestFromFixtures(source: string): boolean;
}
