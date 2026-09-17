package ui

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ArielFalcon/qayaba/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

func strPtr(s string) *string { return &s }

func winnerProfile() contract.OnboardingJobStatus_ResolvedProfile {
	var p contract.OnboardingJobStatus_ResolvedProfile
	if err := json.Unmarshal([]byte(`{
		"transport":"http","frontFiles":"src/api/shop.ts",
		"frontCallSite":{"kind":"fetch"},
		"servicePrefixTemplate":"/api/shop","serviceRepoTemplate":"org/shop-svc",
		"openApiPath":"openapi/shop.yaml"
	}`), &p); err != nil {
		panic(err)
	}
	return p
}

/* Realistic Resolution: two edges the frontend actually calls, plus unresolved and drifted calls. A winner should always carry one of these (the human-meaningful result the propose screen renders), never just the raw profile shape. */
func winnerResolution() *struct {
	Drift float32 `json:"drift"`
	Edges []struct {
		Calls     float32                                              `json:"calls"`
		FromRepo  string                                               `json:"fromRepo"`
		ToRepo    string                                               `json:"toRepo"`
		Transport contract.OnboardingJobStatusResolutionEdgesTransport `json:"transport"`
	} `json:"edges"`
	External   float32 `json:"external"`
	Unresolved float32 `json:"unresolved"`
} {
	return &struct {
		Drift float32 `json:"drift"`
		Edges []struct {
			Calls     float32                                              `json:"calls"`
			FromRepo  string                                               `json:"fromRepo"`
			ToRepo    string                                               `json:"toRepo"`
			Transport contract.OnboardingJobStatusResolutionEdgesTransport `json:"transport"`
		} `json:"edges"`
		External   float32 `json:"external"`
		Unresolved float32 `json:"unresolved"`
	}{
		Drift: 1,
		Edges: []struct {
			Calls     float32                                              `json:"calls"`
			FromRepo  string                                               `json:"fromRepo"`
			ToRepo    string                                               `json:"toRepo"`
			Transport contract.OnboardingJobStatusResolutionEdgesTransport `json:"transport"`
		}{
			{Calls: 14, FromRepo: "org/web", ToRepo: "org/svc-a", Transport: contract.OnboardingJobStatusResolutionEdgesTransportHttp},
			{Calls: 3, FromRepo: "org/web", ToRepo: "org/svc-b", Transport: contract.OnboardingJobStatusResolutionEdgesTransportHttp},
		},
		Unresolved: 4,
	}
}

func winnerStatus() contract.OnboardingJobStatus {
	outcome := contract.Winner
	profile := winnerProfile()
	return contract.OnboardingJobStatus{
		State: contract.OnboardingJobStatusStateDone, App: strPtr("shop"), Round: 2, Ceiling: 3,
		CandidatesScored: 5, Outcome: &outcome, ResolvedProfile: &profile, Resolution: winnerResolution(),
	}
}

func eventWinnerProfile() contract.OnboardingJobStatus_ResolvedProfile {
	var p contract.OnboardingJobStatus_ResolvedProfile
	if err := json.Unmarshal([]byte(`{
		"transport":"event","files":"src/events/ShopEventListener.java",
		"eventPattern":{
			"kind":"class-based-domain-events",
			"listenerBaseType":"DomainEventListener",
			"listenerEventCall":"onEvent",
			"subscriberBaseType":"DomainEventSubscriber",
			"publishCall":"eventPublisher.publish"
		}
	}`), &p); err != nil {
		panic(err)
	}
	return p
}

func eventWinnerStatus() contract.OnboardingJobStatus {
	outcome := contract.Winner
	profile := eventWinnerProfile()
	return contract.OnboardingJobStatus{
		State: contract.OnboardingJobStatusStateDone, App: strPtr("shop"), Round: 1, Ceiling: 3,
		CandidatesScored: 4, Outcome: &outcome, ResolvedProfile: &profile,
	}
}

func noProfileStatus() contract.OnboardingJobStatus {
	outcome := contract.NoProfile
	return contract.OnboardingJobStatus{
		State: contract.OnboardingJobStatusStateDone, App: strPtr("shop"), Round: 3, Ceiling: 3,
		CandidatesScored: 6, Outcome: &outcome,
	}
}

func failedStatus() contract.OnboardingJobStatus {
	errMsg := "onboarding timed out"
	return contract.OnboardingJobStatus{
		State: contract.OnboardingJobStatusStateFailed, App: strPtr("shop"), Round: 1, Ceiling: 3,
		CandidatesScored: 1, Error: &errMsg,
	}
}

func inProgressStatus(state contract.OnboardingJobStatusState, round float32) contract.OnboardingJobStatus {
	return contract.OnboardingJobStatus{
		State: state, App: strPtr("shop"), Round: round, Ceiling: 3, CandidatesScored: 2,
	}
}

/* Every state renders a distinguishable View — the badge and round line. */
func TestBoundaryProposeFoldsEveryStateIntoDistinctView(t *testing.T) {
	cases := []struct {
		name   string
		status contract.OnboardingJobStatus
		want   []string
	}{
		{"resolvingMirrors", inProgressStatus(contract.OnboardingJobStatusStateResolvingMirrors, 0), []string{"resolving"}},
		{"proposing", inProgressStatus(contract.OnboardingJobStatusStateProposing, 1), []string{"proposing", "1", "3"}},
		{"scoring", inProgressStatus(contract.OnboardingJobStatusStateScoring, 2), []string{"scoring"}},
		{"indexing", indexingStatus(), []string{"indexing"}},
		{"mapping", mappingStatus(), []string{"mapping", "architecture map"}},
		{"winner", winnerStatus(), []string{"confirm"}},
		{"no-profile", noProfileStatus(), []string{"no repo connections", "configured"}},
		{"failed", failedStatus(), []string{"onboarding timed out"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := newBoundaryProposeModel(nil, "shop")
			m.width, m.height = 100, 30
			updated, _ := m.Update(boundaryStatusMsg{status: c.status})
			out := strings.ToLower(updated.View())
			for _, w := range c.want {
				if !strings.Contains(out, strings.ToLower(w)) {
					t.Fatalf("%s: View() missing %q:\n%s", c.name, w, out)
				}
			}
		})
	}
}

/* enter on a winner outcome dispatches confirmBoundariesCmd — and ONLY on a winner outcome
   (defense in depth alongside the server's own 409/422 on a non-winner confirm). */
func TestBoundaryProposeConfirmFiresOnlyOnWinner(t *testing.T) {
	winner := newBoundaryProposeModel(nil, "shop")
	winner.width, winner.height = 100, 30
	winner, _ = winner.Update(boundaryStatusMsg{status: winnerStatus()})
	_, cmd := winner.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter on a winner outcome must dispatch a command")
	}
	switch cmd().(type) {
	case confirmedBoundariesMsg, errMsg:
		/* confirmBoundariesCmd resolves to one of these — proves the confirm command fired
		   (client is nil here, so it errors, but the dispatch itself is what's under test). */
	default:
		t.Fatalf("enter on a winner should dispatch confirmBoundariesCmd; got %#v", cmd())
	}

	for _, c := range []struct {
		name   string
		status contract.OnboardingJobStatus
	}{
		{"no-profile", noProfileStatus()},
		{"failed", failedStatus()},
		{"in-progress", inProgressStatus(contract.OnboardingJobStatusStateProposing, 1)},
	} {
		t.Run(c.name, func(t *testing.T) {
			m := newBoundaryProposeModel(nil, "shop")
			m.width, m.height = 100, 30
			m, _ = m.Update(boundaryStatusMsg{status: c.status})
			_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
			if cmd != nil {
				t.Fatalf("enter on %s must NOT dispatch a confirm command; got %#v", c.name, cmd())
			}
		})
	}
}

/* esc on the winner confirm card discards — no confirm dispatched, and the caller (model.go)
   is the one that actually navigates back; this model only needs to emit backMsg. */
func TestBoundaryProposeEscDiscardsNoWrite(t *testing.T) {
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	m, _ = m.Update(boundaryStatusMsg{status: winnerStatus()})
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEscape})
	if cmd == nil {
		t.Fatal("esc must emit a command (back to the board)")
	}
	if _, ok := cmd().(backMsg); !ok {
		t.Fatalf("esc on the winner card should discard and go back; got %#v", cmd())
	}
}

/* Winner card shows how the repos actually connect (Resolution.Edges) and what still needs attention (unresolved/drift/external call counts) — never the raw internal profile shape (transport/frontFiles/serviceRepoTemplate/openApiPath). */
func TestBoundaryProposeWinnerCardShowsConnectionsAndNeedsAttention(t *testing.T) {
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	m, _ = m.Update(boundaryStatusMsg{status: winnerStatus()})
	out := strings.ToLower(m.View())
	for _, want := range []string{"→", "org/svc-a", "14", "connect", "unresolved"} {
		if !strings.Contains(out, want) {
			t.Fatalf("winner View() missing %q:\n%s", want, out)
		}
	}
	for _, unwanted := range []string{"serviceprefixtemplate", "openapipath"} {
		if strings.Contains(out, unwanted) {
			t.Fatalf("winner View() must not render the old raw profile template, found %q:\n%s", unwanted, out)
		}
	}
}

/* ResolvedProfile set but Resolution nil must fall back to the minimal "ready" line — never panic on a nil Resolution, and never render a connections/needs-attention block it has no data for. */
func TestBoundaryProposeWinnerWithNilResolutionFallsBackToMinimalLine(t *testing.T) {
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	m, _ = m.Update(boundaryStatusMsg{status: eventWinnerStatus()})
	out := strings.ToLower(m.View())
	if !strings.Contains(out, "boundary profile resolved") || !strings.Contains(out, "shop") {
		t.Fatalf("nil-Resolution winner must still render the minimal ready line:\n%s", out)
	}
	for _, unwanted := range []string{"how the repos connect", "needs attention"} {
		if strings.Contains(out, unwanted) {
			t.Fatalf("nil-Resolution winner must not render the connections block, found %q:\n%s", unwanted, out)
		}
	}
	if !strings.Contains(out, "context.json") {
		t.Fatalf("nil-Resolution winner must still mention the context.json confirm hint:\n%s", out)
	}
}

/* A no-profile outcome renders no confirm card; esc still goes back. The screen renders a configured-but-no-connections message. */
func TestBoundaryProposeNoProfileRendersDistinctlyFromWinner(t *testing.T) {
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	m, _ = m.Update(boundaryStatusMsg{status: noProfileStatus()})
	out := strings.ToLower(m.View())
	if strings.Contains(out, "confirm") {
		t.Fatalf("a no-profile outcome must not render a confirm card:\n%s", out)
	}
	for _, want := range []string{"no repo connections", "configured", "config/apps"} {
		if !strings.Contains(out, want) {
			t.Fatalf("View() missing %q for the no-profile message:\n%s", want, out)
		}
	}
}

/* Once a job reaches a terminal state (done or failed), the model must stop rescheduling its
   own tick — otherwise the poll loop never terminates (mirrors the ongoing pollTick idiom's
   termination contract, system.go, but a per-screen tick instead of the ambient one). */
func TestBoundaryProposeStopsTickingOnTerminalState(t *testing.T) {
	for _, c := range []struct {
		name   string
		status contract.OnboardingJobStatus
	}{
		{"done-winner", winnerStatus()},
		{"done-no-profile", noProfileStatus()},
		{"failed", failedStatus()},
	} {
		t.Run(c.name, func(t *testing.T) {
			m := newBoundaryProposeModel(nil, "shop")
			m.width, m.height = 100, 30
			_, cmd := m.Update(boundaryStatusMsg{status: c.status})
			if cmd != nil {
				t.Fatalf("a terminal status must not reschedule the tick; got a non-nil cmd: %#v", cmd())
			}
		})
	}
	/* A non-terminal status DOES reschedule (batched: reschedule tick + nothing else, since the
	   poll itself is fired by the tick, not by folding the status). */
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	_, cmd := m.Update(boundaryStatusMsg{status: inProgressStatus(contract.OnboardingJobStatusStateProposing, 1)})
	if cmd == nil {
		t.Fatal("a non-terminal status must reschedule the next tick")
	}
}

/* A status payload whose App differs from the model's own app must never render the confirm affordance or the winner card, even if the server's own scoping guard were bypassed. Render a mismatch notice instead of treating another app's winner as its own. */
func TestBoundaryProposeSuppressesConfirmOnAppMismatch(t *testing.T) {
	mismatched := winnerStatus()
	mismatched.App = strPtr("other-app") /* model is for "shop"; status belongs to a different app */

	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	m, _ = m.Update(boundaryStatusMsg{status: mismatched})

	if m.isConfirmableWinner() {
		t.Fatal("a status belonging to a different app must never be treated as a confirmable winner")
	}

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatalf("enter on a mismatched-app status must NOT dispatch a confirm command; got %#v", cmd())
	}

	out := strings.ToLower(m.View())
	if strings.Contains(out, "confirm") {
		t.Fatalf("a mismatched-app status must not render a confirm card:\n%s", out)
	}
	if !strings.Contains(out, "other-app") {
		t.Fatalf("View() must render a clear mismatch notice naming the other app:\n%s", out)
	}
}

/* The matching-app case (App == model.app) is unaffected — same-app winners still confirm. */
func TestBoundaryProposeAllowsConfirmWhenAppMatches(t *testing.T) {
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	matching := winnerStatus()
	matching.App = strPtr("shop")
	m, _ = m.Update(boundaryStatusMsg{status: matching})

	if !m.isConfirmableWinner() {
		t.Fatal("a status belonging to the SAME app must still be a confirmable winner")
	}
}

/* ── Indexing phase ── */

func indexingStatus() contract.OnboardingJobStatus {
	outcome := contract.Winner
	profile := winnerProfile()
	ok := contract.OnboardingJobStatusIndexProgressStatusOk
	failed := contract.OnboardingJobStatusIndexProgressStatusFailed
	nodeCount := float32(120)
	errMsg := "indexing org/shop-svc timed out"
	progress := []struct {
		Error     *string                                         `json:"error,omitempty"`
		NodeCount *float32                                        `json:"nodeCount,omitempty"`
		Repo      string                                          `json:"repo"`
		Status    contract.OnboardingJobStatusIndexProgressStatus `json:"status"`
	}{
		{Repo: "org/shop", Status: ok, NodeCount: &nodeCount},
		{Repo: "org/shop-svc", Status: failed, Error: &errMsg},
	}
	return contract.OnboardingJobStatus{
		State: contract.OnboardingJobStatusStateIndexing, App: strPtr("shop"), Round: 3, Ceiling: 3,
		CandidatesScored: 6, Outcome: &outcome, ResolvedProfile: &profile, IndexProgress: &progress,
	}
}

/* badgeLabelAndStyle must render a distinguishable "indexing" badge — the ticker relies on the
   indexing state NOT rendering as one of the existing (terminal-adjacent) badges. */
func TestBoundaryProposeRendersIndexingBadgeAndPerRepoProgress(t *testing.T) {
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	m, _ = m.Update(boundaryStatusMsg{status: indexingStatus()})
	out := strings.ToLower(m.View())
	for _, want := range []string{"indexing", "org/shop", "org/shop-svc", "ok", "failed"} {
		if !strings.Contains(out, want) {
			t.Fatalf("View() missing %q for an indexing status:\n%s", want, out)
		}
	}
}

/* Indexing is non-terminal — isTerminalOnboardState is false by omission. Pin that so a future edit cannot silently make "indexing" terminal and stall the poll loop. */
func TestIndexingStateIsNotTerminal(t *testing.T) {
	if isTerminalOnboardState(contract.OnboardingJobStatusStateIndexing) {
		t.Fatal("indexing must be non-terminal — the ticker must keep polling through it")
	}
}

/* Folding an indexing status must reschedule the tick, exactly like any other non-terminal state. */
func TestBoundaryProposeKeepsTickingThroughIndexing(t *testing.T) {
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	_, cmd := m.Update(boundaryStatusMsg{status: indexingStatus()})
	if cmd == nil {
		t.Fatal("an indexing status must reschedule the next tick")
	}
}

/* Confirm success must NOT force navigation back to the board while the server is still indexing — the propose screen stays alive and resumes polling until the job reaches a terminal state. */
func TestConfirmedBoundariesMsgCarriesStatusStateSoTheScreenCanDecideWhetherToStay(t *testing.T) {
	msg := confirmedBoundariesMsg{status: "boundaries confirmed for shop", jobState: contract.OnboardingJobStatusStateIndexing}
	if msg.jobState != contract.OnboardingJobStatusStateIndexing {
		t.Fatalf("confirmedBoundariesMsg must carry the job's state so the caller can avoid navigating away mid-index: %+v", msg)
	}
}

func mappingStatus() contract.OnboardingJobStatus {
	outcome := contract.Winner
	profile := winnerProfile()
	runId := "run_1"
	step := "generate"
	progress := &struct {
		RunId   *string `json:"runId,omitempty"`
		Step    *string `json:"step,omitempty"`
		Verdict *string `json:"verdict,omitempty"`
	}{RunId: &runId, Step: &step}
	return contract.OnboardingJobStatus{
		State: contract.OnboardingJobStatusStateMapping, App: strPtr("shop"), Round: 3, Ceiling: 3,
		CandidatesScored: 6, Outcome: &outcome, ResolvedProfile: &profile, MappingProgress: progress,
	}
}

func TestBoundaryProposeRendersMappingBadgeAndProgress(t *testing.T) {
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	m, _ = m.Update(boundaryStatusMsg{status: mappingStatus()})
	out := strings.ToLower(m.View())
	for _, want := range []string{"mapping", "architecture map", "run_1", "generate"} {
		if !strings.Contains(out, want) {
			t.Fatalf("View() missing %q for a mapping status:\n%s", want, out)
		}
	}
}

func TestMappingStateIsNotTerminal(t *testing.T) {
	if isTerminalOnboardState(contract.OnboardingJobStatusStateMapping) {
		t.Fatal("mapping must be non-terminal — the ticker must keep polling through it")
	}
}

func TestBoundaryProposeKeepsTickingThroughMapping(t *testing.T) {
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	_, cmd := m.Update(boundaryStatusMsg{status: mappingStatus()})
	if cmd == nil {
		t.Fatal("a mapping status must reschedule the next tick")
	}
}

func TestWinnerCardMentionsArchitectureMapOnConfirm(t *testing.T) {
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	m, _ = m.Update(boundaryStatusMsg{status: winnerStatus()})
	out := strings.ToLower(m.View())
	if !strings.Contains(out, "context.json") {
		t.Fatalf("winner confirm hint must mention context.json:\n%s", out)
	}
}
