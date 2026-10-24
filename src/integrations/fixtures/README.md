# Integration fixtures

## `opencode-agent-list.json`

Recorded-output fixture for `listAgentCaps`: the body of `GET /agent?directory=<dir>` as an OpenCode
server returns it (the SDK's `app.agents`, whose element type is the v2 `Agent`).

Captured 2026-10-12, and again on 2026-10-24 after the `codegraph_*` switches were added, from an `opencode serve` 1.17.7, the build `agents/Dockerfile` pins, run inside the
`agents` container (so the Linux/Node build the stack ships) and bound to 127.0.0.1. The server ran with an
isolated HOME and XDG directories and an empty environment (`env -i`), with no credentials, no provider and
no repository, and its config sat at `$XDG_CONFIG_HOME/opencode/opencode.json`: the `OPENCODE_CONFIG`
variable loads a file but does not turn an agent's `tools` map into permission rules, so it records a
different resolution than the real one. The config was `agents/opencode.json` with its `prompt`, `instructions`,
`server` and `mcp` keys removed, plus `probe-steps` (`steps: 40`), `probe-both` (`steps: 33` and `maxSteps: 22`)
and `probe-none` (no cap). Every `qa-` agent therefore carries the `tools` map and the `permission` block it
has in `agents/opencode.json`, and the config carries that file's top-level `permission` block, so the
recorded rules are the ones the real roles resolve to (`GET /agent` on the real container shows the same
rules). Re-record it whenever either block, or a role, changes.

Edits to the recorded body, and nothing else:

- every agent's `prompt` is removed;
- the isolated server's data directory, which appears in a tool-output allow rule, reads `<data>`, and
  its home directory, which appears in the skills allow rule, reads `<home>`;
- every `qa-` agent's `description` is `null` and its `temperature` is `null` and its `model` is removed (a recording
  names no model);
- the unused native agents (`plan`, `explore`, `compaction`, `summary`, `title`) are dropped;
- each permission rule is laid out on one line.

The recording is a fresh capture, not a hand edit: the global `tools` map's `run_spec` and `authbrowser_*` switches resolve into
deny rules on every agent (and an allow rule on the two authoring roles), and its `codegraph_*` switches into a deny
rule on every agent and an allow rule on `qa-generator`, which the earlier hand-edited body lacked.

What the capture shows, and what the parser tests pin (the first two points are as the 1.17.7 recording shows
them; the two about the directory were observed on the 1.16.2 capture of 2026-10-07 and were not repeated):

- `steps` is the only cap field the server returns. A `maxSteps` in the config comes back as `steps`,
  and the response never carries `maxSteps`. With both configured, `steps` wins.
- A configured agent with no cap carries `"steps": null`, not an absent key. A native agent has no
  `steps` key at all. The SDK type says `steps?: number`, so a `null` is the wire's, not the type's.
- The directory is honoured. With a project-level `opencode.json` in the requested directory setting
  `qa-generator` to `maxSteps: 12`, `GET /agent?directory=<that directory>` returned `steps: 12` for it,
  while another directory returned 50. That second response is not part of this fixture. The production server no longer reads a directory's own
  configuration (`OPENCODE_DISABLE_PROJECT_CONFIG`, set by the supervisor), so there the directory only selects
  which instance answers; the observation holds for a server started without it, as this recording's was.
- A request with no `directory`, and one naming a directory that does not exist, both answer 200 with the
  default agent list.
