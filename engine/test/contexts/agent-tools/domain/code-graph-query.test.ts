import { test } from "node:test";
import assert from "node:assert/strict";
import { admitCodeGraphQuery, CODE_GRAPH_ACTION, MAX_EXPLORE_TERMS, MAX_TERM_CHARS } from "@contexts/agent-tools/domain/code-graph-query.ts";

test("explore names one to N terms and admits nothing but them: the project, the file cap and any extra key are not the caller's", () => {
  assert.deepEqual(admitCodeGraphQuery({ action: "explore", terms: ["formatMoney"] }), { action: CODE_GRAPH_ACTION.EXPLORE, terms: ["formatMoney"] });
  assert.deepEqual(
    admitCodeGraphQuery({ action: "explore", terms: ["OrdersPage", "web/src/app/orders/orders.page.ts"], project: "another-app", max_files: 500, maxFiles: 500, limit: 99 }),
    { action: CODE_GRAPH_ACTION.EXPLORE, terms: ["OrdersPage", "web/src/app/orders/orders.page.ts"] },
  );
  assert.equal(admitCodeGraphQuery({ action: "explore", terms: [] }), undefined, "nothing to explore");
  assert.equal(admitCodeGraphQuery({ action: "explore" }), undefined);
  assert.equal(admitCodeGraphQuery({ action: "explore", terms: Array.from({ length: MAX_EXPLORE_TERMS + 1 }, (_, i) => `term${i}`) }), undefined, "more terms than the ceiling");
  assert.equal(admitCodeGraphQuery({ action: "explore", terms: Array.from({ length: MAX_EXPLORE_TERMS }, (_, i) => `term${i}`) })?.action, "explore");
});

test("a term is an identifier or a path of bounded length and never starts like an option", () => {
  for (const term of ["--help", "-f", "--max-files", "a b", "x;rm", "$(id)", "a`b", "q\nr", "", "  ", "x".repeat(MAX_TERM_CHARS + 1), 42, null, ["a"]]) {
    assert.equal(admitCodeGraphQuery({ action: "explore", terms: [term] }), undefined, JSON.stringify(term));
  }
  for (const term of ["formatMoney", "OrderService.findAll", "GET:/api/orders", "web/src/app/shared/format.ts", "pkg::Type", "$store", "x".repeat(MAX_TERM_CHARS)]) {
    assert.equal(admitCodeGraphQuery({ action: "explore", terms: [term] })?.action, "explore", term);
  }
  assert.equal(admitCodeGraphQuery({ action: "explore", terms: "formatMoney" }), undefined, "terms is a list");
  assert.equal(admitCodeGraphQuery({ action: "explore", terms: ["ok", "--bad"] }), undefined, "one bad term refuses the call");
});

test("no other action is served: the three old queries, free graph queries and anything that indexes, deletes or writes are not code-graph calls", () => {
  for (const action of ["search_graph", "trace_path", "get_code_snippet", "query_graph", "index_repository", "delete_project", "manage_adr", "sync", "init", "serve", undefined]) {
    assert.equal(admitCodeGraphQuery({ action, terms: ["x"], query: "MATCH (n) DETACH DELETE n" }), undefined, String(action));
  }
});
