# Integration fixtures

## `opencode-agent-list.json`

Recorded-output fixture for `listAgentCaps`: the body of `GET /agent?directory=<dir>` as an OpenCode
server returns it (the SDK's `app.agents`, whose element type is the v2 `Agent`).

Captured 2026-10-07 from a local `opencode serve` 1.16.2 bound to 127.0.0.1. The pinned build in
`agents/Dockerfile` is 1.17.7; its SDK declares the same `steps` field, but no 1.17.7 server was
available on the capture host, so re-record this file against the pinned build before it is used as
evidence of that build's behavior. The server ran with an isolated HOME and XDG directories and an empty
environment, with no credentials, no provider and no repository. Its config declared `qa-generator`
(`maxSteps: 50`), `qa-reviewer` (`maxSteps: 25`), `qa-explorer` (`maxSteps: 25`), `probe-steps`
(`steps: 40`), `probe-both` (`steps: 33` and `maxSteps: 22`) and `probe-none` (no cap).

Edits to the recorded body, and nothing else:

- every agent's `prompt` is removed;
- the isolated server's data directory, which appears in a tool-output allow rule, reads `<data>`;
- the unused native agents (`plan`, `explore`, `compaction`, `summary`, `title`) are dropped;
- each permission rule is laid out on one line.

What the capture shows, and what the parser tests pin:

- `steps` is the only cap field the server returns. A `maxSteps` in the config comes back as `steps`,
  and the response never carries `maxSteps`. With both configured, `steps` wins.
- A configured agent with no cap carries `"steps": null`, not an absent key. A native agent has no
  `steps` key at all. The SDK type says `steps?: number`, so a `null` is the wire's, not the type's.
- The directory is honoured. With a project-level `opencode.json` in the requested directory setting
  `qa-generator` to `maxSteps: 12`, `GET /agent?directory=<that directory>` returned `steps: 12` for it,
  while another directory returned 50. That second response is not part of this fixture.
- A request with no `directory`, and one naming a directory that does not exist, both answer 200 with the
  default agent list.
