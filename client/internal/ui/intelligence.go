package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ArielFalcon/qayaba/internal/api"
	"github.com/ArielFalcon/qayaba/internal/contract"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type intelligenceSelectedMsg struct{ app string }

type intelligenceLoadedMsg struct{ view contract.IntelligenceView }

/* intelligenceModel renders what the system has actually learned about an app: the
   rule ledger, the value-oracle scorecard, and the curriculum. Every signal carries its
   provenance — ◆ ground-truth (a real oracle measurement), ◇ proxy (LLM-only), or
   ⚠ not measured — so an inert layer reads as inert, never dressed up as success. */
type intelligenceModel struct {
	client  *api.Client
	app     string
	view    *contract.IntelligenceView
	loading bool
	err     string
	width   int
	height  int
	vp      viewport.Model
	ready   bool
}

func newIntelligenceModel(client *api.Client, app string) intelligenceModel {
	return intelligenceModel{client: client, app: app, loading: true}
}

func (m intelligenceModel) Init() tea.Cmd { return fetchIntelligenceCmd(m.client, m.app) }

func fetchIntelligenceCmd(c *api.Client, app string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		v, err := c.GetIntelligence(ctx, app)
		if err != nil {
			return errMsg{err}
		}
		return intelligenceLoadedMsg{view: v}
	}
}

func (m intelligenceModel) Update(msg tea.Msg) (intelligenceModel, tea.Cmd) {
	switch msg := msg.(type) {
	case intelligenceLoadedMsg:
		v := msg.view
		m.view = &v
		m.loading = false
		m.err = ""
		m.refresh()
		return m, nil
	case errMsg:
		m.loading = false
		m.err = msg.err.Error()
		return m, nil
	case tea.WindowSizeMsg:
		m.resize(msg.Width, msg.Height)
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return m, func() tea.Msg { return backMsg{} }
		case "r":
			if !m.loading {
				m.loading = true
				m.err = ""
				return m, fetchIntelligenceCmd(m.client, m.app)
			}
		case "up", "k", "down", "j", "pgup", "pgdown":
			if m.ready {
				var cmd tea.Cmd
				m.vp, cmd = m.vp.Update(msg)
				return m, cmd
			}
		}
	}
	return m, nil
}

func (m *intelligenceModel) resize(w, h int) {
	m.width, m.height = w, h
	/* header (rule + legend + blank) + footer (blank + line) + screen padding. */
	vpH := h - 7
	if vpH < 3 {
		vpH = 3
	}
	if !m.ready {
		m.vp = viewport.New(contentWidth(w), vpH)
		m.ready = true
	} else {
		m.vp.Width, m.vp.Height = contentWidth(w), vpH
	}
	m.refresh()
}

func (m *intelligenceModel) refresh() {
	if m.ready {
		m.vp.SetContent(m.body())
	}
}

func (m intelligenceModel) View() string {
	w := contentWidth(m.width)
	header := accentRule(w, "intelligence", labelStyle.Render(m.app))
	legend := hintStyle.Render("provenance: ") +
		renderSegs("", sg("◆ ground-truth", colPass), sg("  ·  ", colFaint), sg("◇ proxy", colFlaky), sg("  ·  ", colFaint), sg("⚠ not measured", colFaint))
	var body string
	switch {
	case m.loading:
		body = infoStyle.Render("loading…")
	case m.err != "":
		body = errorStyle.Render("✗ " + m.err)
	case m.ready:
		body = m.vp.View()
	default:
		body = m.body()
	}
	footer := hintStyle.Render("↑↓ scroll · r refresh · esc back")
	return screenStyle.Render(header + "\n" + legend + "\n\n" + body + "\n\n" + footer)
}

func (m intelligenceModel) body() string {
	w := contentWidth(m.width)
	if m.view == nil {
		return hintStyle.Render("no intelligence available")
	}
	v := *m.view
	var b strings.Builder

	/* ── RULES: the learning ledger ─────────────────────────────────────────── */
	b.WriteString(labelRule(w, "rules", hintStyle.Render(pluralize(len(v.Rules), "rule", "rules"))) + "\n")
	if len(v.Rules) == 0 {
		b.WriteString("  " + hintStyle.Render("no rules learned yet — the ledger fills as runs are reflected on") + "\n")
	} else {
		for i, r := range v.Rules {
			if i > 0 {
				b.WriteString("\n")
			}
			b.WriteString(renderLearningRule(r, w))
		}
	}
	b.WriteString("\n")

	/* ── ORACLE / GROUND TRUTH: the value-oracle scorecard ───────────────────── */
	b.WriteString(labelRule(w, "oracle / ground truth", "") + "\n")
	if v.Scorecard == nil || v.Scorecard.MeasuredRuns == 0 {
		b.WriteString("  " + shadowStyle.Render("⚠ not measured") + "  " +
			hintStyle.Render("no value-oracle signal for this app — coverage/mutation off or inapplicable") + "\n")
	} else {
		sc := *v.Scorecard
		b.WriteString("  " + renderSegs("",
			sg("◆ ground-truth   ", colPass), sg("avg ", colFaint), sgb(fmtScore(sc.AvgValueScore), colFg),
			sg("   last ", colFaint), sgb(fmtScore(sc.LastValueScore), colFg)) + "  " +
			hintStyle.Render(fmt.Sprintf("%d/%d runs measured", sc.MeasuredRuns, sc.TotalRuns)) + "\n")
		start := 0
		if len(sc.Entries) > 5 {
			start = len(sc.Entries) - 5
		}
		for _, e := range sc.Entries[start:] {
			b.WriteString("    " + hintStyle.Render(fmt.Sprintf("%s  %-4s  killed %d/%d  %s",
				fmtScore(e.ValueScore), e.Target, e.KilledCount, e.MutantCount, relativeTime(e.At))) + "\n")
		}
	}
	b.WriteString("\n")

	/* ── CURRICULUM: which scenario archetypes have proven their worth ───────── */
	if v.Curriculum != nil && len(v.Curriculum.Archetypes) > 0 {
		proven := 0
		for _, a := range v.Curriculum.Archetypes {
			if a.CaughtRealBug {
				proven++
			}
		}
		b.WriteString(labelRule(w, "curriculum", hintStyle.Render(fmt.Sprintf("%d/%d proven", proven, len(v.Curriculum.Archetypes)))) + "\n")
		var parts []string
		for _, a := range v.Curriculum.Archetypes {
			/* Each chip carries the archetype's credited/evaluated hit rate — the tier below
			   caughtRealBug that actually moves. Evaluated == 0 means it was never offered or never
			   produced a determinable signal, so it takes the same "—" no-data mark fmtScore uses
			   rather than the fabricated rate "0/0", which would read as a demonstrated failure. */
			chip := a.Archetype + " " + fmtArchetypeRate(a.Credited, a.Evaluated)
			if a.CaughtRealBug {
				parts = append(parts, okStyle.Render("✓ "+chip))
			} else {
				parts = append(parts, hintStyle.Render("· "+chip))
			}
		}
		b.WriteString("  " + wrapJoin(parts, hintStyle.Render("   "), w-2))
	}
	return strings.TrimRight(b.String(), "\n")
}

/* fmtArchetypeRate renders an archetype's change-coverage credit as credited/evaluated, and an
   unevaluated archetype as "—" — never as a rate, because 0/0 states a measured failure that never
   happened. */
func fmtArchetypeRate(credited, evaluated int) string {
	if evaluated <= 0 {
		return "—"
	}
	return fmt.Sprintf("%d/%d", credited, evaluated)
}

/* renderLearningRule paints one ledger entry as a block the operator can read: status,
   class, evidence, the full trigger (when it applies), and the action (what to do). Trigger
   and action wrap; they are never ellipsis-truncated — a truncated trigger is not a trigger. */
func renderLearningRule(r contract.LearningRuleView, width int) string {
	glyph, gc := ruleStatusGlyph(string(r.Status))
	rate := "—"
	if r.SuccessRate != nil {
		rate = fmt.Sprintf("%.0f%%", float64(*r.SuccessRate)*100)
	}
	left := renderSegs("", sg(glyph+" ", gc)) +
		labelStyle.Render(r.ErrorClass) + "  " +
		hintStyle.Render(string(r.Status))
	right := confidenceMeter(string(r.Confidence)) + "  " +
		hintStyle.Render(fmt.Sprintf("used %d · %s · %s", r.UsageCount, rate, pluralize(r.OutcomeCount, "outcome", "outcomes")))

	var b strings.Builder
	if lipgloss.Width(left)+1+lipgloss.Width(right) > width {
		b.WriteString(left + "\n")
		b.WriteString(right + "\n")
	} else {
		b.WriteString(spread(width, left, right) + "\n")
	}
	appendWrapped(&b, "  ", "  ", r.Trigger, width, hintStyle)
	if strings.TrimSpace(r.Action) != "" {
		appendWrapped(&b, "  → ", "    ", r.Action, width, labelStyle)
	}
	return b.String()
}

func appendWrapped(b *strings.Builder, firstIndent, restIndent, text string, width int, style lipgloss.Style) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	wrapW := width - lipgloss.Width(firstIndent)
	if wrapW < 8 {
		wrapW = 8
	}
	for i, line := range wrapText(text, wrapW) {
		indent := firstIndent
		if i > 0 {
			indent = restIndent
		}
		b.WriteString(indent + style.Render(line) + "\n")
	}
}

func fmtScore(s *float32) string {
	if s == nil {
		return "—"
	}
	return fmt.Sprintf("%.2f", *s)
}

func confidenceMeter(conf string) string {
	switch conf {
	case "high":
		return lipgloss.NewStyle().Foreground(colPass).Render("▰▰▰")
	case "medium":
		return lipgloss.NewStyle().Foreground(colFlaky).Render("▰▰▱")
	default: /* low */
		return lipgloss.NewStyle().Foreground(colFaint).Render("▰▱▱")
	}
}

func ruleStatusGlyph(status string) (string, lipgloss.Color) {
	switch status {
	case "active":
		return "●", colPass
	case "candidate":
		return "○", colFlaky
	case "deprecated":
		return "✗", colFaint
	default: /* superseded */
		return "·", colFaint
	}
}
