/*
 * Read + human-override CLI for the learning ledger. Read-only by default; veto/restore
 * are the one human-initiated write path into learning_rules (the agent never writes rules).
 *
 *   node --import tsx src/qa/learning/ledger-cli.ts show <app> [limit]
 *   node --import tsx src/qa/learning/ledger-cli.ts veto <ruleId>
 *   node --import tsx src/qa/learning/ledger-cli.ts restore <ruleId>
 *   node --import tsx src/qa/learning/ledger-cli.ts release <ruleId>   lifts a quarantine (npm run learning:quarantine)
 */
import { renderLedgerReport } from "./ledger-report";
import { getHistory } from "../../server/persistence/index";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const [cmd, arg, arg2] = process.argv.slice(2);

switch (cmd) {
  case "show": {
    if (!arg) fail("usage: ledger-cli show <app> [limit]");
    const limit = Number(arg2); /* NaN when absent/invalid → falls back below */
    const rules = getHistory().learning.listAllLearningRules(arg, Number.isFinite(limit) && limit > 0 ? limit : 500);
    process.stdout.write(renderLedgerReport(rules, { app: arg }));
    break;
  }
  case "veto":
  case "restore": {
    if (!arg) fail(`usage: ledger-cli ${cmd} <ruleId>`);
    const status = cmd === "veto" ? "deprecated" : "active";
    if (!getHistory().learning.setRuleStatusByHuman(arg, status)) fail(`no rule with id "${arg}"`);
    console.log(`rule ${arg} → ${status}`);
    break;
  }
  case "release": {
    if (!arg) fail("usage: ledger-cli release <ruleId>");
    if (!getHistory().learning.releaseLearningRuleQuarantine(arg)) fail(`no quarantined rule with id "${arg}"`);
    console.log(`rule ${arg} released from quarantine`);
    break;
  }
  default:
    fail("usage: ledger-cli <show <app> [limit] | veto <ruleId> | restore <ruleId> | release <ruleId>>");
}
