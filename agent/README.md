# Provider-neutral agent assets

This directory is the provider-neutral home for Qayaba agent prompts and skills.

Current migration state:
- `agent/AGENTS.md`, `agent/roles/`, and `agent/skills/` mirror the current OpenCode assets.
- `agents/` (OpenCode's own tree, with `agents/opencode.json`) remains mounted for compatibility.
- New Codex/app-server wiring should read from this neutral directory instead of hard-coding `agents/`.

Keep verdict contracts provider-neutral: the blocking final response is authoritative;
live events are observability only.
