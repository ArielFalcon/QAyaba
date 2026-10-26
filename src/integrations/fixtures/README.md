# Integration fixtures

## `opencode-agent-list.json`

Recorded-output fixture for `listAgentCaps`: the body of `GET /agent?directory=<dir>` as an OpenCode
server returns it (the SDK's `app.agents`, whose element type is the v2 `Agent`).

Captured 2026-10-12, again on 2026-10-24 after the memory server was removed from every role, and once more that day after the `codegraph_*` switches were added, and on 2026-10-25 after they became the single `codegraph_explore` (which also picked up the generator's and sidekick's raised step caps), from an `opencode serve` 1.17.7, the build `agents/Dockerfile` pins, run inside the
`agents` container (so the Linux/Node build the stack ships) and bound to 127.0.0.1. The server ran with an
isolated HOME and XDG directories and an empty environment (`env -i`), with no credentials, no provider and
no repository, and its config sat at `$XDG_CONFIG_HOME/opencode/opencode.json`: the `OPENCODE_CONFIG`
variable loads a file but does not turn an agent's `tools` map into permission rules, so it records a
different resolution than the real one. The config was `agents/opencode.json` with its `prompt`, `instructions`,
`server` and `mcp` keys removed, plus `probe-steps` (`steps: 40`), `probe-both` (`steps: 33` and `maxSteps: 22`)
and `probe-none` (no cap), each with `mode: primary`. Every `qa-` agent therefore carries the `tools` map and the `permission` block it
has in `agents/opencode.json`, and the config carries that file's top-level `permission` block, so the
recorded rules are the ones the real roles resolve to (`GET /agent` on the real container shows the same
rules). Re-record it whenever either block, or a role, changes.

On 2026-10-26 the `qa-lead` entry was added and `qa-author`'s `codegraph_explore` rule flipped from allow to deny when the
code-graph tool moved to the lead. Both are derived from `agents/opencode.json`, not captured: the merge order (the global tools map,
the global permission, then the agent's `tools` and `permission` merged by key, then the runtime's tool-output rule) was proven
first by reproducing every other `qa-` entry of this body rule for rule. A live capture on the pinned build has not been taken since;
the next one replaces the derived entries.

On 2026-10-26 the author roster landed: the generator's entry is deleted and the sidekick's is renamed `qa-author`, which also carries the generator's `permission.bash: deny`. The `qa-author` entry is derived from `agents/opencode.json` the same way as the `qa-lead` and `qa-explore` entries, and the other `qa-` entries were checked rule for rule against the same derivation; it is replaced by the next live capture.

Edits to the recorded body, and nothing else:

- every agent's `prompt` is removed;
- the isolated server's data directory, which appears in a tool-output allow rule, reads `<data>`, and
  its home directory, which appears in the skills allow rule, reads `<home>`;
- every `qa-` agent's `description` is `null`, its `temperature` is `null`, its `options` is `{}` and its `model` is
  removed (a recording names no model and no model tuning);
- the unused native agents (`plan`, `explore`, `compaction`, `summary`, `title`) are dropped;
- the entry of the retired explorer role is removed: the role left `agents/opencode.json` after this recording, and this body was edited to match, not re-recorded (the next recording simply will not contain it);
- each permission rule is laid out on one line, and the agents and their fields keep the order of the previous recording.

The recording is a fresh capture, not a hand edit: the global `tools` map's `run_spec` and `authbrowser_*` switches resolve into
deny rules on every agent (and an allow rule on the two authoring roles), and its `codegraph_*` switches into a deny
rule on every agent and an allow rule on `qa-lead`, which the earlier hand-edited body lacked.

What the capture shows, and what the parser tests pin (the first two points are as the 1.17.7 recording shows
them; the two about the directory were observed on the 1.16.2 capture of 2026-10-07 and were not repeated):

- `steps` is the only cap field the server returns. A `maxSteps` in the config comes back as `steps`,
  and the response never carries `maxSteps`. With both configured, `steps` wins.
- A configured agent with no cap carries `"steps": null`, not an absent key. A native agent has no
  `steps` key at all. The SDK type says `steps?: number`, so a `null` is the wire's, not the type's.
- The directory is honoured. With a project-level `opencode.json` in the requested directory setting
  `qa-author` to `maxSteps: 12`, `GET /agent?directory=<that directory>` returned `steps: 12` for it,
  while another directory returned 50. That second response is not part of this fixture. The production server no longer reads a directory's own
  configuration (`OPENCODE_DISABLE_PROJECT_CONFIG`, set by the supervisor), so there the directory only selects
  which instance answers; the observation holds for a server started without it, as this recording's was.
- A request with no `directory`, and one naming a directory that does not exist, both answer 200 with the
  default agent list.

## `opencode-roster.json`

Hand-written, not recorded. It stands in for `agents/opencode.json` wherever a test needs the roster only as an input
(role names, models, step caps, the window a role's model gets): `{ "agent": { "<role>": { "model", "maxSteps" } } }` for
exactly the roles the deployable file declares. `opencode-roster.ts` exports `rosterFixturePath()` (for every API that takes
the path of an agents config) and `loadRoster()`.

- The models are placeholders and differ per role, so logic that depends on distinct models is testable. The three roles whose
  prompt budget the window catalog resolves (`qa-author`, `qa-reviewer`, `qa-assistant`) name cataloged ids, chosen once here, so
  a window assertion has a known answer; the others name uncataloged placeholders. The ids are not the deployable's.
- `opencode-roster-fixture.test.ts` keeps it in step: same role names, and a model and a step cap on a role exactly when the
  deployable role has them. It never compares model ids or caps, so changing a model in `agents/opencode.json` breaks no test.
- A test that lints the deployable file itself (tool and permission denials, the MCP allowlist, the supervisor's mirror of it,
  the catalog covering every assigned model, the defaults of `config.ts`) keeps reading the real file and never uses this one.
