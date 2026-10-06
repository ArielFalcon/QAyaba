package ui

import (
	"strings"
	"testing"

	"github.com/ArielFalcon/qayaba/internal/api"
	"github.com/ArielFalcon/qayaba/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

/* visibleText strips ANSI and collapses whitespace so wrap-aware renders can be
   asserted as the operator-visible sentence, not as a particular line break. */
func visibleText(s string) string {
	return strings.Join(strings.Fields(ansi.Strip(s)), " ")
}

/* A rule's action is the learned advice. Truncating the trigger onto one line and dropping
   the action made the Intelligence screen a status strip, not a ledger the operator can read. */
func TestIntelligenceBodyRendersRuleTriggerActionAndOutcomes(t *testing.T) {
	sr := float32(0.6)
	m := newIntelligenceModel(api.New("http://x", ""), "jhipster-store")
	m.loading = false
	m.width = 72
	m.view = &contract.IntelligenceView{
		App: "jhipster-store",
		Rules: []contract.LearningRuleView{
			{
				Trigger:      "Applies when the spec locates a submit button by its visible English label",
				Action:       "prefer getByTestId or data-cy over getByText so i18n cannot break the locator",
				ErrorClass:   "E-FRAGILE-SELECTOR",
				Confidence:   "low",
				UsageCount:   4,
				OutcomeCount: 2,
				SuccessRate:  &sr,
				Status:       "candidate",
			},
		},
	}
	out := m.body()
	got := visibleText(out)
	for _, want := range []string{
		"E-FRAGILE-SELECTOR",
		"Applies when the spec locates a submit button by its visible English label",
		"prefer getByTestId or data-cy over getByText so i18n cannot break the locator",
		"used 4",
		"2 outcomes",
		"candidate",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("rule ledger missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(got, "visible English…") || strings.Contains(got, "visible English label…") {
		t.Fatalf("trigger must not be ellipsis-truncated; wrap instead:\n%s", out)
	}
}

func TestIntelligenceBodyRendersRulesAndProvenance(t *testing.T) {
	sr := float32(0.86)
	m := newIntelligenceModel(api.New("http://x", ""), "portfolio")
	m.loading = false
	m.width = 96
	m.view = &contract.IntelligenceView{
		App: "portfolio",
		Rules: []contract.LearningRuleView{
			{Trigger: "fragile selector", Action: "scope to a test id", ErrorClass: "E-SELECTOR-FRAGILE", Confidence: "high", UsageCount: 22, OutcomeCount: 3, SuccessRate: &sr, Status: "active"},
		},
		Scorecard: nil, /* an e2e app with no oracle signal → must read "not measured" */
		Curriculum: &contract.CurriculumView{
			Archetypes: []struct {
				Archetype      string `json:"archetype"`
				CaughtRealBug  bool   `json:"caughtRealBug"`
				Credited       int    `json:"credited"`
				Evaluated      int    `json:"evaluated"`
				PromotionCount int    `json:"promotionCount"`
			}{
				{Archetype: "happy-path", CaughtRealBug: true, PromotionCount: 2, Evaluated: 4, Credited: 3},
				{Archetype: "network-error", CaughtRealBug: false, PromotionCount: 0, Evaluated: 0, Credited: 0},
			},
		},
	}
	out := m.body()
	for _, want := range []string{"RULES", "E-SELECTOR-FRAGILE", "fragile selector", "scope to a test id", "used 22", "3 outcomes", "ORACLE", "not measured", "CURRICULUM", "happy-path", "1/2 proven"} {
		if !strings.Contains(out, want) {
			t.Fatalf("intelligence body missing %q:\n%s", want, out)
		}
	}
}

/* An evaluated archetype shows its real hit rate; a never-evaluated one must read as absent
   evidence, never as the fabricated zero rate "0/0" — the difference between an operator learning
   "this archetype is useless" and "this archetype has never been tried". */
func TestIntelligenceCurriculumDistinguishesNoEvidenceFromZeroRate(t *testing.T) {
	m := newIntelligenceModel(api.New("http://x", ""), "portfolio")
	m.loading = false
	m.width = 96
	m.view = &contract.IntelligenceView{
		App: "portfolio",
		Curriculum: &contract.CurriculumView{
			Archetypes: []struct {
				Archetype      string `json:"archetype"`
				CaughtRealBug  bool   `json:"caughtRealBug"`
				Credited       int    `json:"credited"`
				Evaluated      int    `json:"evaluated"`
				PromotionCount int    `json:"promotionCount"`
			}{
				{Archetype: "happy-path", CaughtRealBug: true, PromotionCount: 2, Evaluated: 4, Credited: 3},
				{Archetype: "boundary-value", CaughtRealBug: false, PromotionCount: 0, Evaluated: 5, Credited: 0},
				{Archetype: "network-error", CaughtRealBug: false, PromotionCount: 0, Evaluated: 0, Credited: 0},
			},
		},
	}
	out := m.body()
	/* The proven/unproven glyph is asserted together with the rate: a chip that carried the right
	   rate under the wrong glyph would tell the operator the opposite of the truth about whether the
	   archetype ever caught a real defect. */
	for _, want := range []string{"✓ happy-path 3/4", "· boundary-value 0/5", "· network-error —"} {
		if !strings.Contains(out, want) {
			t.Fatalf("curriculum chip missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "0/0") {
		t.Fatalf("a never-evaluated archetype must not render as the fabricated rate 0/0:\n%s", out)
	}
}

func TestIntelligenceGroundTruthScorecard(t *testing.T) {
	avg := float32(0.82)
	m := newIntelligenceModel(api.New("http://x", ""), "qayaba")
	m.loading = false
	m.width = 96
	m.view = &contract.IntelligenceView{
		App:       "qayaba",
		Scorecard: &contract.ScorecardView{AvgValueScore: &avg, LastValueScore: &avg, MeasuredRuns: 1, TotalRuns: 1},
	}
	out := m.body()
	if !strings.Contains(out, "ground-truth") || !strings.Contains(out, "0.82") {
		t.Fatalf("scorecard ground-truth line missing:\n%s", out)
	}
}

// O3: mutantCount/killedCount are now *int (nullable — "not measured" vs a genuine measured
// zero). A real value must render as its actual digits, and a nil (never measured) must render
// as a placeholder, never as a raw pointer address or a fabricated "0".
func TestIntelligenceScorecardEntryRendersRealAndUnmeasuredCounts(t *testing.T) {
	avg := float32(0.82)
	killed, mutants := 17, 20
	m := newIntelligenceModel(api.New("http://x", ""), "qayaba")
	m.loading = false
	m.width = 96
	m.view = &contract.IntelligenceView{
		App: "qayaba",
		Scorecard: &contract.ScorecardView{
			AvgValueScore: &avg, LastValueScore: &avg, MeasuredRuns: 2, TotalRuns: 2,
			Entries: []struct {
				At          string   `json:"at"`
				KilledCount *int     `json:"killedCount"`
				MutantCount *int     `json:"mutantCount"`
				Target      string   `json:"target"`
				ValueScore  *float32 `json:"valueScore"`
			}{
				{At: "2026-09-01T00:00:00Z", KilledCount: &killed, MutantCount: &mutants, Target: "code", ValueScore: &avg},
				{At: "2026-09-02T00:00:00Z", KilledCount: nil, MutantCount: nil, Target: "e2e", ValueScore: nil},
			},
		},
	}
	out := m.body()
	if !strings.Contains(out, "killed 17/20") {
		t.Fatalf("expected the real measured counts 'killed 17/20' to render:\n%s", out)
	}
	if strings.Contains(out, "killed 0/0") {
		t.Fatalf("an unmeasured entry must never render as the fabricated rate 'killed 0/0':\n%s", out)
	}
	if !strings.Contains(out, "killed —/—") {
		t.Fatalf("an unmeasured entry must render a placeholder, not a raw pointer or garbage value:\n%s", out)
	}
}

func TestDashboardIntelKeyOpensIntelligence(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("i")})
	if cmd == nil {
		t.Fatal("i must emit a command")
	}
	if msg, ok := cmd().(intelligenceSelectedMsg); !ok || msg.app != "portfolio" {
		t.Fatalf("i should open intelligence for the selected app, got %#v", cmd())
	}
}

/* A corrupt stored curriculum is a fault the operator must see, not the "no curriculum yet" of an
   app that simply has none. */
func TestIntelligenceShowsACorruptCurriculumAsCorrupt(t *testing.T) {
	cases := []struct {
		name    string
		view    contract.IntelligenceView
		corrupt bool
	}{
		{"a corrupt stored curriculum", contract.IntelligenceView{App: "shop", CurriculumCorrupt: true}, true},
		{"no curriculum yet", contract.IntelligenceView{App: "shop"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := newIntelligenceModel(api.New("http://x", ""), "shop")
			m, _ = m.Update(intelligenceLoadedMsg{view: tc.view})
			got := strings.ToLower(visibleText(m.View()))
			if strings.Contains(got, "corrupt") != tc.corrupt {
				t.Fatalf("corrupt shown = %v, want %v:\n%s", !tc.corrupt, tc.corrupt, got)
			}
		})
	}
}
