/* Reads the accessibility tree a capture dumped (Playwright's aria snapshot YAML) into the "role: name" lines the agent is shown and the selector check compares against. Pure. */

export function parseAriaSnapshot(yaml: string): string[] {
  const out: string[] = [];

  const keep = new Set([
    "link", "button", "heading", "textbox", "combobox", "checkbox", "radio", "tab", "menuitem", "option",
    "columnheader", "rowheader", "cell", "gridcell", "listitem", "row", "table", "grid", "list",
    "text",
    /* These were absent from grounding, making the reviewer blind to modal presence, form context, and navigation structure. alert/status/progressbar are live-regions (name = the message); switch is a valued toggle widget (name = its label). All kept; structural designation is per-role below. */
    "dialog", "alertdialog", "alert", "status", "form", "navigation", "banner", "main", "switch", "progressbar",
  ]);
  /* Roles whose mere PRESENCE is informative even WITHOUT an accessible name, so we emit a bare "(present)" marker instead of dropping them: • landmarks (table/grid/list/row) — lets the author see "there is a table here" and reason about which roles it actually exposes (e.g. cells but no columnheader) vs assuming HTML-implied roles. • form inputs (textbox/combobox/checkbox/radio) — a form whose <label> is NOT associated (no for/id, common in apps like PetClinic) leaves the input UNNAMED; without this it is DROPPED and the whole form goes INVISIBLE to grounding, so the reviewer can't confirm the author's selectors and falsely REJECTS them. */
  const structural = new Set(["table", "grid", "list", "row", "textbox", "combobox", "checkbox", "radio",
    "dialog", "alertdialog", "form", "navigation", "banner", "main", "switch"]);

  for (const rawLine of yaml.split("\n")) {
    const trimmed = rawLine.trimStart();
    if (!trimmed.startsWith("- ")) continue;
    const rest = trimmed.slice(2).trim();

    if (rest.startsWith("/")) continue;

    const roleMatch = /^([a-z][a-z0-9-]*)/.exec(rest);
    if (!roleMatch) continue;
    const role = roleMatch[1]!;
    if (!keep.has(role)) continue;

    const afterRole = rest.slice(role.length);

    const quotedMatch = /"((?:\\.|[^"\\])*)"/.exec(afterRole);
    if (quotedMatch) {
      const name = quotedMatch[1]!.replace(/\\(["\\])/g, "$1").trim();
      out.push(name ? `${role}: ${name}` : structural.has(role) ? `${role}: (present)` : "");
      if (out[out.length - 1] === "") out.pop();
      continue;
    }

    const colonIdx = afterRole.indexOf(":");
    if (colonIdx !== -1) {
      const afterColon = afterRole.slice(colonIdx + 1).trim();
      if (afterColon) {
        const name = afterColon.replace(/\s*\[[^\]]*\]\s*$/g, "").trim();
        out.push(name ? `${role}: ${name}` : structural.has(role) ? `${role}: (present)` : "");
        if (out[out.length - 1] === "") out.pop();
      } else if (structural.has(role)) {
        out.push(`${role}: (present)`);
      }
      continue;
    }

    const strippedStates = afterRole.replace(/\s*\[[^\]]*\]/g, "").trim();
    if (!strippedStates && structural.has(role)) {
      out.push(`${role}: (present)`);
    }
  }

  return out;
}

export function parseAriaSnapshotWithState(yaml: string): { nodes: string[]; states: Map<string, string[]> } {
  const nodes = parseAriaSnapshot(yaml);
  const states = new Map<string, string[]>();
  const STATE_RE = /\[(disabled|expanded|checked|required|selected)\]/g;
  for (const rawLine of yaml.split("\n")) {
    const trimmed = rawLine.trimStart();
    if (!trimmed.startsWith("- ")) continue;
    const rest = trimmed.slice(2).trim();
    if (rest.startsWith("/")) continue;
    const roleMatch = /^([a-z][a-z0-9-]*)/.exec(rest);
    if (!roleMatch) continue;
    const role = roleMatch[1]!;
    const afterRole = rest.slice(role.length);
    let bareName: string | null = null;
    const quotedMatch = /"((?:\\.|[^"\\])*)"/.exec(afterRole);
    if (quotedMatch) {
      const name = quotedMatch[1]!.replace(/\\(["\\])/g, "$1").trim();
      if (name) bareName = name;
    } else {
      const colonIdx = afterRole.indexOf(":");
      if (colonIdx !== -1) {
        const afterColon = afterRole.slice(colonIdx + 1).trim();
        if (afterColon) {
          const name = afterColon.replace(/\s*\[[^\]]*\]\s*$/g, "").trim();
          if (name) bareName = name;
        }
      }
    }
    if (!bareName) continue;
    const bareKey = `${role}: ${bareName}`;
    if (!nodes.includes(bareKey)) continue;
    STATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const tokens: string[] = [];
    while ((m = STATE_RE.exec(afterRole)) !== null) {
      tokens.push(m[1]!);
    }
    if (tokens.length > 0) states.set(bareKey, tokens);
  }
  return { nodes, states };
}
