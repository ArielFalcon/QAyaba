// Runs INSIDE the execution sandbox. PASSES when it has started a detached daemon: the harness (scripts/sandbox-smoke-checks.ts)
// then judges whether the launcher ended it. The daemon looks for the canary values in every process environment it can read.
import { test } from "@playwright/test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const DAEMON = `
const fs = require("fs"), path = require("path");
const tmp = process.argv[1];
setInterval(() => {
  try { fs.appendFileSync(path.join(tmp, "alive.log"), "tick\\n"); } catch (e) {}
  let names = [];
  try { names = fs.readdirSync("/proc"); } catch (e) {}
  for (const name of names) {
    if (!/^\\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const env = fs.readFileSync("/proc/" + name + "/environ", "utf8");
      if (env.includes("SMOKE_CANARY_CONTROL_VALUE")) fs.appendFileSync(path.join(tmp, "seen.log"), "CONTROL " + name + "\\n");
      if (env.includes("SMOKE_CANARY_LOGIN_PASS")) fs.appendFileSync(path.join(tmp, "seen.log"), "LOGIN " + name + "\\n");
    } catch (e) {}
  }
}, 100);
`;

test("a detached daemon is started and left running", () => {
  const tmp = process.env.TMPDIR as string;
  const daemon = spawn(process.execPath, ["-e", DAEMON, tmp], { detached: true, stdio: "ignore" });
  daemon.unref();
  writeFileSync(join(tmp, "daemon.pid"), String(daemon.pid));
});
