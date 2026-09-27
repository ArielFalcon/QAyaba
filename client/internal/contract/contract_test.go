package contract

import (
	"encoding/json"
	"testing"
)

/* Decoding the orchestrator's real GET /api/v1/runs/:id payload (see
   src/server/api.ts → RunRecordSchema) into the codegen'd struct proves the
   published contract artifact (contract/openapi.json) and the Go types agree —
   the no-drift guarantee, enforced on the Go side. */
func TestRunRecordDecodesFromServerJSON(t *testing.T) {
	const payload = `{
		"id":"run_1","app":"portfolio","sha":"abc1234","target":"e2e","mode":"diff",
		"status":"done","verdict":"pass","passed":3,"failed":0,
		"cases":[{"name":"login","status":"pass","durationMs":1200}],
		"logs":["started","done"],"at":"2026-01-01T00:00:00.000Z"
	}`
	var r RunRecord
	if err := json.Unmarshal([]byte(payload), &r); err != nil {
		t.Fatalf("decode RunRecord: %v", err)
	}
	if r.Id != "run_1" || r.Target != "e2e" || r.Mode != "diff" {
		t.Fatalf("unexpected header fields: %+v", r)
	}
	if r.Verdict == nil || *r.Verdict != "pass" {
		t.Fatalf("verdict not decoded: %v", r.Verdict)
	}
	if len(r.Cases) != 1 {
		t.Fatalf("want 1 case, got %d", len(r.Cases))
	}
	if c := r.Cases[0]; c.Name != "login" || c.Status != "pass" || c.DurationMs == nil || *c.DurationMs != 1200 {
		t.Fatalf("case (incl. real durationMs) not decoded: %+v", c)
	}
}

func TestCreateRunResultCarriesTarget(t *testing.T) {
	var res CreateRunResult
	if err := json.Unmarshal([]byte(`{"id":"r","app":"portfolio","sha":"abc","target":"e2e","mode":"diff","status":"enqueued"}`), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if res.Target != "e2e" {
		t.Fatalf("target not decoded: %q", res.Target)
	}
}

/* Decoding the orchestrator's real GET /api/v1/apps/:name/boundaries/propose/status
   payload (see src/server/onboarding/onboarding-job.ts → OnboardingJobStatusSchema)
   into the codegen'd struct — the same no-drift guarantee as RunRecord above, now for
   the boundary-onboarding job's poll DTO. Two shapes: a winner (outcome + resolvedProfile
   set) and a no-profile completion (outcome set, resolvedProfile absent). */
func TestOnboardingJobStatusDecodesWinnerFromServerJSON(t *testing.T) {
	const payload = `{
		"state":"done","app":"shop","round":2,"ceiling":3,"candidatesScored":5,
		"lastResolvedScore":0.92,
		"resolvedProfile":{
			"transport":"http","frontFiles":"src/api/shop.ts",
			"frontCallSite":{"kind":"fetch","receiver":"shopClient"},
			"servicePrefixTemplate":"/api/shop","serviceRepoTemplate":"org/shop-svc",
			"openApiPath":"openapi/shop.yaml"
		},
		"outcome":"winner",
		"startedAt":"2026-07-06T00:00:00.000Z","finishedAt":"2026-07-06T00:02:00.000Z"
	}`
	var s OnboardingJobStatus
	if err := json.Unmarshal([]byte(payload), &s); err != nil {
		t.Fatalf("decode OnboardingJobStatus (winner): %v", err)
	}
	if s.State != OnboardingJobStatusStateDone || s.App == nil || *s.App != "shop" || s.Round != 2 || s.Ceiling != 3 || s.CandidatesScored != 5 {
		t.Fatalf("unexpected header fields: %+v", s)
	}
	if s.Outcome == nil || *s.Outcome != Winner {
		t.Fatalf("outcome not decoded: %v", s.Outcome)
	}
	if s.ResolvedProfile == nil {
		t.Fatalf("resolvedProfile not decoded")
	}
	profile, err := s.ResolvedProfile.AsOnboardingJobStatusResolvedProfile0()
	if err != nil {
		t.Fatalf("resolvedProfile did not decode as the http variant: %v", err)
	}
	if profile.Transport != OnboardingJobStatusResolvedProfile0TransportHttp || profile.FrontFiles != "src/api/shop.ts" || profile.ServiceRepoTemplate != "org/shop-svc" {
		t.Fatalf("http profile fields: %+v", profile)
	}
	if profile.FrontCallSite.Receiver == nil || *profile.FrontCallSite.Receiver != "shopClient" {
		t.Fatalf("frontCallSite.receiver not decoded: %+v", profile.FrontCallSite)
	}
}

/* Decoding the event-variant resolvedProfile — the transport:"event" shape a service-to-service
   (class-based-domain-events) winner carries, as opposed to the http shape covered above. This
   exercises AsOnboardingJobStatusResolvedProfile1(), which the winner-http test above never touches. */
func TestOnboardingJobStatusDecodesEventWinnerFromServerJSON(t *testing.T) {
	const payload = `{
		"state":"done","app":"shop","round":1,"ceiling":3,"candidatesScored":4,
		"lastResolvedScore":0.88,
		"resolvedProfile":{
			"transport":"event","files":"src/events/ShopEventListener.java",
			"eventPattern":{
				"kind":"class-based-domain-events",
				"listenerBaseType":"DomainEventListener",
				"listenerEventCall":"onEvent",
				"subscriberBaseType":"DomainEventSubscriber",
				"publishCall":"eventPublisher.publish"
			}
		},
		"outcome":"winner",
		"startedAt":"2026-07-06T00:00:00.000Z","finishedAt":"2026-07-06T00:01:30.000Z"
	}`
	var s OnboardingJobStatus
	if err := json.Unmarshal([]byte(payload), &s); err != nil {
		t.Fatalf("decode OnboardingJobStatus (event winner): %v", err)
	}
	if s.Outcome == nil || *s.Outcome != Winner {
		t.Fatalf("outcome not decoded: %v", s.Outcome)
	}
	if s.ResolvedProfile == nil {
		t.Fatalf("resolvedProfile not decoded")
	}
	profile, err := s.ResolvedProfile.AsOnboardingJobStatusResolvedProfile1()
	if err != nil {
		t.Fatalf("resolvedProfile did not decode as the event variant: %v", err)
	}
	if profile.Transport != Event || profile.Files != "src/events/ShopEventListener.java" {
		t.Fatalf("event profile fields: %+v", profile)
	}
	if profile.EventPattern.Kind != "class-based-domain-events" ||
		profile.EventPattern.ListenerBaseType != "DomainEventListener" ||
		profile.EventPattern.ListenerEventCall != "onEvent" ||
		profile.EventPattern.SubscriberBaseType != "DomainEventSubscriber" ||
		profile.EventPattern.PublishCall != "eventPublisher.publish" {
		t.Fatalf("eventPattern fields not decoded: %+v", profile.EventPattern)
	}
}

func TestOnboardingJobStatusDecodesNoProfileFromServerJSON(t *testing.T) {
	const payload = `{
		"state":"done","app":"shop","round":3,"ceiling":3,"candidatesScored":6,
		"outcome":"no-profile",
		"startedAt":"2026-07-06T00:00:00.000Z","finishedAt":"2026-07-06T00:02:30.000Z"
	}`
	var s OnboardingJobStatus
	if err := json.Unmarshal([]byte(payload), &s); err != nil {
		t.Fatalf("decode OnboardingJobStatus (no-profile): %v", err)
	}
	if s.State != OnboardingJobStatusStateDone {
		t.Fatalf("state not decoded: %v", s.State)
	}
	if s.Outcome == nil || *s.Outcome != NoProfile {
		t.Fatalf("outcome not decoded: %v", s.Outcome)
	}
	if s.ResolvedProfile != nil {
		t.Fatalf("resolvedProfile should be absent for a no-profile outcome, got %+v", s.ResolvedProfile)
	}
}

/* Decoding a payload in the "indexing" state with a per-repo indexProgress array — the same no-drift guarantee as the winner/no-profile tests, for the post-confirm advisory-index phase. */
func TestOnboardingJobStatusDecodesIndexingStateFromServerJSON(t *testing.T) {
	const payload = `{
		"state":"indexing","app":"shop","round":3,"ceiling":3,"candidatesScored":6,
		"outcome":"winner",
		"resolvedProfile":{
			"transport":"http","frontFiles":"src/api/shop.ts",
			"frontCallSite":{"kind":"fetch"},
			"servicePrefixTemplate":"/api/shop","serviceRepoTemplate":"org/shop-svc",
			"openApiPath":"openapi/shop.yaml"
		},
		"indexProgress":[
			{"repo":"org/shop","status":"ok","nodeCount":120},
			{"repo":"org/shop-svc","status":"failed","error":"indexing org/shop-svc timed out"}
		],
		"startedAt":"2026-07-06T00:00:00.000Z"
	}`
	var s OnboardingJobStatus
	if err := json.Unmarshal([]byte(payload), &s); err != nil {
		t.Fatalf("decode OnboardingJobStatus (indexing): %v", err)
	}
	if s.State != OnboardingJobStatusStateIndexing {
		t.Fatalf("state not decoded: %v", s.State)
	}
	if s.Outcome == nil || *s.Outcome != Winner {
		t.Fatalf("outcome must stay winner during indexing (ADR-3 — indexing is a post-step, not a verdict): %v", s.Outcome)
	}
	if s.IndexProgress == nil || len(*s.IndexProgress) != 2 {
		t.Fatalf("indexProgress not decoded: %+v", s.IndexProgress)
	}
	progress := *s.IndexProgress
	if progress[0].Repo != "org/shop" || progress[0].Status != OnboardingJobStatusIndexProgressStatusOk {
		t.Fatalf("first repo outcome not decoded: %+v", progress[0])
	}
	if progress[0].NodeCount == nil || *progress[0].NodeCount != 120 {
		t.Fatalf("nodeCount not decoded: %+v", progress[0])
	}
	if progress[1].Repo != "org/shop-svc" || progress[1].Status != OnboardingJobStatusIndexProgressStatusFailed {
		t.Fatalf("second repo outcome not decoded: %+v", progress[1])
	}
	if progress[1].Error == nil || *progress[1].Error != "indexing org/shop-svc timed out" {
		t.Fatalf("error not decoded: %+v", progress[1])
	}
}

func TestOnboardingJobStatusDecodesMappingStateFromServerJSON(t *testing.T) {
	const payload = `{
		"state":"mapping","app":"shop","round":3,"ceiling":3,"candidatesScored":6,
		"outcome":"winner",
		"mappingProgress":{"runId":"run_1","step":"generate","verdict":"pass"},
		"startedAt":"2026-09-13T00:00:00.000Z"
	}`
	var s OnboardingJobStatus
	if err := json.Unmarshal([]byte(payload), &s); err != nil {
		t.Fatalf("decode OnboardingJobStatus (mapping): %v", err)
	}
	if s.State != OnboardingJobStatusStateMapping {
		t.Fatalf("state not decoded: %v", s.State)
	}
	if s.Outcome == nil || *s.Outcome != Winner {
		t.Fatalf("outcome must stay winner during mapping: %v", s.Outcome)
	}
	if s.MappingProgress == nil || s.MappingProgress.RunId == nil || *s.MappingProgress.RunId != "run_1" {
		t.Fatalf("mappingProgress.runId not decoded: %+v", s.MappingProgress)
	}
	if s.MappingProgress.Step == nil || *s.MappingProgress.Step != "generate" {
		t.Fatalf("mappingProgress.step not decoded: %+v", s.MappingProgress)
	}
}

/* Decoding a payload whose "resolution" carries the full per-edge summary including `drift`, round-tripped through the generated Go type. Two edges over different transports (http, event) exercise the Transport enum on both members. */
func TestOnboardingJobStatusDecodesResolutionSummaryFromServerJSON(t *testing.T) {
	const payload = `{
		"state":"done","app":"shop","round":2,"ceiling":3,"candidatesScored":5,
		"outcome":"winner",
		"resolution":{
			"edges":[
				{"fromRepo":"org/web","toRepo":"org/svc-a","transport":"http","calls":14},
				{"fromRepo":"org/web","toRepo":"org/svc-b","transport":"event","calls":3}
			],
			"drift":2,
			"unresolved":4,
			"external":1
		},
		"startedAt":"2026-07-08T00:00:00.000Z","finishedAt":"2026-07-08T00:02:00.000Z"
	}`
	var s OnboardingJobStatus
	if err := json.Unmarshal([]byte(payload), &s); err != nil {
		t.Fatalf("decode OnboardingJobStatus (resolution summary): %v", err)
	}
	if s.Resolution == nil {
		t.Fatalf("resolution not decoded")
	}
	res := s.Resolution
	if len(res.Edges) != 2 {
		t.Fatalf("want 2 edges, got %d: %+v", len(res.Edges), res.Edges)
	}
	if e := res.Edges[0]; e.FromRepo != "org/web" || e.ToRepo != "org/svc-a" || e.Transport != OnboardingJobStatusResolutionEdgesTransportHttp || e.Calls != 14 {
		t.Fatalf("first edge fields not decoded: %+v", e)
	}
	if e := res.Edges[1]; e.ToRepo != "org/svc-b" || e.Transport != OnboardingJobStatusResolutionEdgesTransportEvent {
		t.Fatalf("second edge transport not decoded: %+v", e)
	}
	if res.Drift != 2 {
		t.Fatalf("drift not decoded: got %v want 2", res.Drift)
	}
	if res.Unresolved != 4 {
		t.Fatalf("unresolved not decoded: got %v want 4", res.Unresolved)
	}
	if res.External != 1 {
		t.Fatalf("external not decoded: got %v want 1", res.External)
	}
}

/* SignalsView.Coordination is optional (src/server/coordination-events.ts buildCoordinationSignals):
   present once a fleet has adopted multi-agent coordination, absent (nil) for one that hasn't.
   Decoding a real GET /api/v1/signals payload with it present ties the generated pointer-to-anonymous-
   struct shape to the contract — the same no-drift guarantee as the other decode tests in this file. */
func TestSignalsViewDecodesCoordinationFromServerJSON(t *testing.T) {
	const payload = `{
		"valueOracle":{"measured":true,"avgScore":0.8,"measuredRuns":10,"totalRuns":20},
		"reviewer":{"passRate":0.9,"runs":20},
		"coverage":{"measured":true,"avgRatio":0.75,"measuredRuns":10,"totalRuns":20},
		"coordination":{
			"measured":true,"totalRuns":20,"delegateRuns":8,
			"escalationRate":0.25,"contractFailureRate":0.125,"avgDelegationMs":1500
		}
	}`
	var v SignalsView
	if err := json.Unmarshal([]byte(payload), &v); err != nil {
		t.Fatalf("decode SignalsView: %v", err)
	}
	if v.Coordination == nil {
		t.Fatalf("coordination not decoded")
	}
	co := v.Coordination
	if !co.Measured || co.TotalRuns != 20 || co.DelegateRuns != 8 {
		t.Fatalf("coordination header fields: %+v", co)
	}
	if co.EscalationRate == nil || *co.EscalationRate != 0.25 {
		t.Fatalf("escalationRate not decoded: %v", co.EscalationRate)
	}
	if co.ContractFailureRate == nil || *co.ContractFailureRate != 0.125 {
		t.Fatalf("contractFailureRate not decoded: %v", co.ContractFailureRate)
	}
	if co.AvgDelegationMs == nil || *co.AvgDelegationMs != 1500 {
		t.Fatalf("avgDelegationMs not decoded: %v", co.AvgDelegationMs)
	}
}

/* A fleet that hasn't adopted coordination yet gets no "coordination" key at all
   (src/server/coordination-events.ts only adds it when outcomes exist) — Coordination must decode
   as nil, not a zero-valued struct, so the console can tell "unmeasured" from "no coordination". */
func TestSignalsViewCoordinationAbsentWhenNotYetAdopted(t *testing.T) {
	const payload = `{
		"valueOracle":{"measured":false,"avgScore":null,"measuredRuns":0,"totalRuns":0},
		"reviewer":{"passRate":null,"runs":0},
		"coverage":{"measured":false,"avgRatio":null,"measuredRuns":0,"totalRuns":0}
	}`
	var v SignalsView
	if err := json.Unmarshal([]byte(payload), &v); err != nil {
		t.Fatalf("decode SignalsView: %v", err)
	}
	if v.Coordination != nil {
		t.Fatalf("coordination should be absent, got %+v", v.Coordination)
	}
}

/* CoordinationEventsView (GET /api/v1/coordination-events) — the ledger tail the console's
   coordination panel reads. Exercises the CoordinationEventKind enum plus the wide set of
   optional fields a "delegation" event carries. */
func TestCoordinationEventsViewDecodesFromServerJSON(t *testing.T) {
	const payload = `{
		"events":[
			{
				"runId":"run_1","kind":"delegation","action":"navigate","capability":"browser",
				"reason":"frontend flow needs a live DOM","durationMs":1500,"delegationId":"d1",
				"attempt":1,"valueScore":0.82,"coverageRatio":0.6,"at":1731000000000
			}
		],
		"truncated":false
	}`
	var v CoordinationEventsView
	if err := json.Unmarshal([]byte(payload), &v); err != nil {
		t.Fatalf("decode CoordinationEventsView: %v", err)
	}
	if v.Truncated {
		t.Fatalf("truncated should be false")
	}
	if len(v.Events) != 1 {
		t.Fatalf("want 1 event, got %d", len(v.Events))
	}
	e := v.Events[0]
	if e.RunId != "run_1" || e.Kind != Delegation || e.Reason != "frontend flow needs a live DOM" {
		t.Fatalf("event header fields: %+v", e)
	}
	if e.Action == nil || *e.Action != "navigate" || e.Capability == nil || *e.Capability != "browser" {
		t.Fatalf("action/capability not decoded: %+v", e)
	}
	if e.DelegationId == nil || *e.DelegationId != "d1" || e.Attempt == nil || *e.Attempt != 1 {
		t.Fatalf("delegationId/attempt not decoded: %+v", e)
	}
	if e.ValueScore == nil || *e.ValueScore != 0.82 || e.CoverageRatio == nil || *e.CoverageRatio != 0.6 {
		t.Fatalf("valueScore/coverageRatio not decoded: %+v", e)
	}
	if e.At != 1731000000000 {
		t.Fatalf("at not decoded: got %v", e.At)
	}
}
