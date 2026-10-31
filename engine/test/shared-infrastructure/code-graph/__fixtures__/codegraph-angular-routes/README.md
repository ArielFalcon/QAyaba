# codegraph Angular route fixture

What the pinned engine (`codegraph` 1.6.2, schema 11, extraction 27) extracts from Angular route declarations.
`codegraph-store-reader.angular-routes.test.ts` reads it through the store reader.

- `repo.json` — a synthetic Angular repo, never an app's code: a `Routes` array with a path from a constant, a multi-line
  declaration, `canMatch` / `canActivate` / `canActivateChild` guards, `redirectTo`, `loadChildren` and `loadComponent`;
  a lazily loaded child array; and the same component route in an array typed by a local alias of `Route[]` and in an
  untyped array.
- `store.db` — the store `codegraph init -y .` built from that repo, journal set to `DELETE`. `*.db` is gitignored: add it
  with `git add -f`. This copy was built by the 1.6.2 npm release outside the orchestrator image (its metadata names 1.6.2
  and extraction 27, the versions the reader is pinned to).

## Re-recording (when the engine pin moves)

Write `repo.json`'s files into an empty directory under the system temp dir, run `codegraph init -y .` then
`codegraph status -j .` in it with the pinned engine (the orchestrator image's, as the sandbox uid, per the `codegraph`
fixture README; the recorded store's metadata must name the pinned version and extraction), copy `.codegraph/codegraph.db`
to `store.db`, set `PRAGMA journal_mode=DELETE` on the copy, and run the test. A failing assertion is a change in what the
engine extracts: read it before updating the test, since the route-availability evidence depends on it.
