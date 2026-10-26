# Integration fixtures

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
