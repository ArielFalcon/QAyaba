import { test } from "node:test";
import assert from "node:assert/strict";
import { guardRequestHandler } from "./guarded-handler";

function res(headersSent = false) {
  return { headersSent, status: 0, headers: {} as Record<string, string>, body: "", ended: false,
    writeHead(s: number, h?: Record<string, string>) { this.status = s; this.headers = h ?? {}; this.headersSent = true; },
    end(b?: string) { this.body = b ?? ""; this.ended = true; } };
}

test("a handler that throws before answering gets a 500 with the schemaVersion error shape, and the fault is logged", async () => {
  const logged: string[] = [];
  const r = res();
  await guardRequestHandler(async () => { throw new Error("boom"); }, (m) => logged.push(m))({} as never, r as never);
  assert.equal(r.status, 500);
  assert.deepEqual(JSON.parse(r.body), { schemaVersion: 1, error: "internal error" });
  assert.equal(r.body.includes("boom"), false);
  assert.ok(logged[0]!.includes("boom"));
});

test("a throw after the response started only ends it", async () => {
  const r = res(true);
  await guardRequestHandler(async () => { throw new Error("late"); }, () => undefined)({} as never, r as never);
  assert.equal(r.status, 0);
  assert.equal(r.ended, true);
});

test("a handler that answers is left alone", async () => {
  const r = res();
  await guardRequestHandler(async (_q, s) => { s.writeHead(200); s.end("ok"); }, () => undefined)({} as never, r as never);
  assert.equal(r.status, 200);
  assert.equal(r.body, "ok");
});
