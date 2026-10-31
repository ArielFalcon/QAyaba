# codegraph fixtures

Recorded with the pinned engine (`codegraph` 1.6.2, the version `Dockerfile` installs) inside the orchestrator image, as the
sandbox uid, with egress blocked: the same constraints a run has.

- `repo.json` — a synthetic two-stack repo: `web/` (Angular, with a `package.json`; its API URL is composed, not literal)
  and `api/` (Spring, with a `pom.xml`). Each key is a repo-relative path, each value the file's content.
- `store.db` — the store `codegraph init -y .` built from that repo (schema 11, extraction 27). The store reader is pinned
  to those versions; `codegraph-store-reader.test.ts` and `codegraph-code-graph.adapter.test.ts` read it.
- `status.json` — `codegraph status -j .` on that store.
- `explore.txt` — `codegraph explore --max-files 12 -- formatMoney OrdersPage` on that store.

## Re-recording (when the engine pin moves)

1. Build the orchestrator image with the new pin (`docker compose build orchestrator`).
2. In the running container, as root: write `repo.json`'s files into an empty directory owned by the sandbox uid, then run
   `codegraph init -y .`, `codegraph status -j .` and the `explore` command above in it as the sandbox uid
   (`setpriv --reuid=<sandbox uid> --regid=<sandbox gid> --init-groups`).
3. Copy `.codegraph/codegraph.db` to `store.db` (run `codegraph status` first so no write-ahead log is left), set its
   journal to `DELETE` (`PRAGMA journal_mode=DELETE`, so a read-only open leaves no `-wal`/`-shm` beside it), and copy
   the two outputs to `status.json` and `explore.txt`. `*.db` is gitignored: add it with `git add -f`.
4. If the store's schema or extraction version changed, update the pins in `codegraph-store-reader.mjs` after checking its
   queries against the new tables, then run the tests above.
