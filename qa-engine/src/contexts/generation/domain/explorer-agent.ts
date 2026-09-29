/* The explorer's agent name: its key in agents/opencode.json, the stem of its role prompt, and the role its turns are recorded under (agent_turns.role). One definition, because the engine tags the explorer's session with it, the shell's role table maps the explorer role to it, and the telemetry excludes it from the run-level figures by it. */
export const EXPLORER_AGENT_NAME = "qa-explorer";
