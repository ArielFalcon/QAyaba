import { test } from "node:test";
import assert from "node:assert/strict";
import { admitCodeGraphQuery, cliCallOf } from "@contexts/qa-run-orchestration/domain/code-graph-query.ts";

test("a search names a pattern or a query, and its label and limit are kept only inside their bounds", () => {
  assert.deepEqual(admitCodeGraphQuery({ action: "search_graph", name_pattern: ".*Store.*" }), { action: "search_graph", namePattern: ".*Store.*", limit: 10 });
  assert.deepEqual(admitCodeGraphQuery({ action: "search_graph", query: "restaurant list", label: "Function", limit: 3 }), { action: "search_graph", query: "restaurant list", label: "Function", limit: 3 });
  assert.equal(admitCodeGraphQuery({ action: "search_graph" }), undefined, "nothing to search for");
  assert.equal(admitCodeGraphQuery({ action: "search_graph", query: "x", limit: 500 })?.action, "search_graph");
  const capped = admitCodeGraphQuery({ action: "search_graph", query: "x", limit: 500 });
  assert.equal(capped && "limit" in capped ? capped.limit : 0, 25);
  assert.equal(admitCodeGraphQuery({ action: "search_graph", query: "x", label: "Function; DROP" }), undefined, "a label is a word");
});

test("a trace names a symbol, a direction and a depth within bounds", () => {
  assert.deepEqual(admitCodeGraphQuery({ action: "trace_path", function_name: "loadNear" }), { action: "trace_path", functionName: "loadNear", direction: "both", depth: 2 });
  assert.deepEqual(admitCodeGraphQuery({ action: "trace_path", function_name: "loadNear", direction: "inbound", depth: 9 }), { action: "trace_path", functionName: "loadNear", direction: "inbound", depth: 3 });
  assert.equal(admitCodeGraphQuery({ action: "trace_path", function_name: "x", direction: "sideways" }), undefined);
  assert.equal(admitCodeGraphQuery({ action: "trace_path" }), undefined);
});

test("a snippet names one qualified symbol", () => {
  assert.deepEqual(admitCodeGraphQuery({ action: "get_code_snippet", qualified_name: "src.app.store.GeoRestaurantStore" }), { action: "get_code_snippet", qualifiedName: "src.app.store.GeoRestaurantStore" });
  assert.equal(admitCodeGraphQuery({ action: "get_code_snippet", qualified_name: "" }), undefined);
});

test("no other action is served: free graph queries and anything that indexes, deletes or writes are not code-graph calls", () => {
  for (const action of ["query_graph", "index_repository", "delete_project", "manage_adr", "ingest_traces", "list_projects", undefined]) {
    assert.equal(admitCodeGraphQuery({ action, query: "MATCH (n) DETACH DELETE n" }), undefined, String(action));
  }
});

test("over-long or ill-typed arguments are refused rather than cut", () => {
  assert.equal(admitCodeGraphQuery({ action: "search_graph", query: "x".repeat(201) }), undefined);
  assert.equal(admitCodeGraphQuery({ action: "trace_path", function_name: 42 }), undefined);
  assert.equal(admitCodeGraphQuery({ action: "get_code_snippet", qualified_name: "x".repeat(401) }), undefined);
});

test("the call carries the run's project, whatever the caller asked for, and only the admitted arguments", () => {
  const query = admitCodeGraphQuery({ action: "search_graph", name_pattern: ".*Store.*", project: "another-app" })!;
  const call = cliCallOf(query, "app-webapp");
  assert.equal(call.tool, "search_graph");
  assert.deepEqual(JSON.parse(call.json), { project: "app-webapp", name_pattern: ".*Store.*", limit: 10 });
  assert.deepEqual(JSON.parse(cliCallOf(admitCodeGraphQuery({ action: "trace_path", function_name: "f" })!, "p").json), { project: "p", function_name: "f", direction: "both", depth: 2 });
  assert.deepEqual(JSON.parse(cliCallOf(admitCodeGraphQuery({ action: "get_code_snippet", qualified_name: "a.b" })!, "p").json), { project: "p", qualified_name: "a.b" });
});
