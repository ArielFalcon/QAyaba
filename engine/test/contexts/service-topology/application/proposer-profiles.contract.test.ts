import { test } from "node:test";
import assert from "node:assert/strict";
import { proposerProfilesContract } from "@contexts/service-topology/application/proposer-profiles.contract.ts";
import { SUBMIT_TOOL } from "@kernel/submission.ts";

const HTTP = {
  transport: "http",
  frontFiles: "**/*.api.ts",
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: "openapi.json",
};

const EVENT = {
  transport: "event",
  files: "**/*.java",
  eventPattern: {
    kind: "class-based-domain-events",
    listenerBaseType: "ListenerMessageDelegate",
    listenerEventCall: "convertMsgToSpecificType",
    subscriberBaseType: "DomainEventSubscriber",
    publishCall: "publishGenericMessage",
  },
};

const HTTP_BACKEND = {
  transport: "http-backend",
  sourceFiles: "**/*.java",
  callPattern: { kind: "rest-template-exchange", receiver: "restTemplate" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: "openapi.yaml",
};

test("the proposer's contract is delivered through the profiles tool", () => {
  assert.equal(proposerProfilesContract.tool, SUBMIT_TOOL.PROFILES);
});

test("a profile of every transport is accepted whole, field for field", () => {
  const checked = proposerProfilesContract.check({ candidates: [HTTP, EVENT, HTTP_BACKEND] });

  assert.deepEqual(checked, { ok: true, value: [HTTP, EVENT, HTTP_BACKEND] });
});

test("an empty list of candidates is an answer: the proposer found no boundary", () => {
  assert.deepEqual(proposerProfilesContract.check({ candidates: [] }), { ok: true, value: [] });
});

test("one unreadable entry refuses the submission and names where, so a readable sibling never hides it", () => {
  const { publishCall: _omitted, ...eventPattern } = EVENT.eventPattern;

  const checked = proposerProfilesContract.check({ candidates: [HTTP, { ...EVENT, eventPattern }] });

  assert.equal(checked.ok, false);
  if (checked.ok) return;
  assert.deepEqual(checked.errors.map((error) => error.path), ["candidates.1.eventPattern.publishCall"]);
});

test("an empty glob is refused at its field: an empty path is never a usable candidate", () => {
  const checked = proposerProfilesContract.check({ candidates: [{ ...HTTP, frontFiles: "" }] });

  assert.equal(checked.ok, false);
  if (checked.ok) return;
  assert.deepEqual(checked.errors.map((error) => error.path), ["candidates.0.frontFiles"]);
});

test("an answer that is not an object with a candidates list is refused at its root or at candidates", () => {
  const notAnObject = proposerProfilesContract.check("not even an object");
  const notAList = proposerProfilesContract.check({ candidates: "not-an-array" });

  assert.equal(notAnObject.ok, false);
  assert.equal(notAList.ok, false);
  if (notAnObject.ok || notAList.ok) return;
  assert.deepEqual(notAnObject.errors.map((error) => error.path), ["(root)"]);
  assert.deepEqual(notAList.errors.map((error) => error.path), ["candidates"]);
});
