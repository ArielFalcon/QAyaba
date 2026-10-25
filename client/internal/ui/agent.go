package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ArielFalcon/qayaba/internal/api"
	"github.com/ArielFalcon/qayaba/internal/contract"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

type agentScreen int

const (
	agentScreenMenu agentScreen = iota
	agentScreenKey
	agentScreenRole
)

type agentMenuAction string

const (
	agentActionEditPrimary    agentMenuAction = "edit-primary"
	agentActionEditReviewer   agentMenuAction = "edit-reviewer"
	agentActionEditChat       agentMenuAction = "edit-chat"
	agentActionSetOpenKey     agentMenuAction = "set-opencode-key"
	agentActionRestartOpen    agentMenuAction = "restart-opencode"
	agentActionApply          agentMenuAction = "apply"
	agentActionReset          agentMenuAction = "reset"
)

type agentMenuItem struct {
	label  string
	action agentMenuAction
}

type agentRoleOption struct {
	provider string
	model    string
}

type agentModel struct {
	client        *api.Client
	config        *contract.PublicAgentConfig
	draft         *contract.PublicAgentConfig
	loading       bool
	err           string
	status        string
	cursor        int
	screen        agentScreen
	openModels    []contract.AgentModelInfo
	modelErrors   map[string]string
	modelsLoading bool
	keyProvider   string
	keyInput      textinput.Model
	stagedKeys    map[string]string
	editingRole   string
	roleCursor    int
	focusRole     string /* role to jump into editing once the config loads (from the dashboard MODELS row) */
	busyRun       string /* app of the active run, if any — the runtime is locked while it runs */
	width         int    /* terminal width, for the grid (0 → default via contentWidth) */
}

func newAgentModel(client *api.Client) agentModel {
	keyInput := textinput.New()
	keyInput.Placeholder = "paste api key"
	keyInput.Prompt = "" /* the screen draws its own ember caret */
	keyInput.EchoMode = textinput.EchoPassword
	keyInput.CharLimit = 600
	keyInput.Width = 42
	return agentModel{
		client:      client,
		loading:     true,
		modelErrors: map[string]string{},
		stagedKeys:  map[string]string{},
		keyInput:    keyInput,
	}
}

func (m agentModel) Init() tea.Cmd {
	return tea.Batch(fetchAgentConfigCmd(m.client), fetchAgentModelsCmd(m.client, "opencode"), loadQueueCmd(m.client))
}

func (m agentModel) Update(msg tea.Msg) (agentModel, tea.Cmd) {
	switch msg := msg.(type) {
	case agentConfigLoadedMsg:
		m.loading = false
		cfg := msg.config
		draft := cloneAgentConfig(cfg)
		m.config = &cfg
		m.draft = &draft
		m.err = ""
		/* Opened from a specific MODELS row on the dashboard → jump straight into editing that role
		   (the editor needs the now-loaded draft). A one-shot: cleared so a later refresh stays put. */
		if m.focusRole != "" {
			m.openRoleEditor(m.focusRole)
			m.focusRole = ""
		}
		return m, nil
	case queueLoadedMsg:
		if msg.queue.Running != nil {
			m.busyRun = msg.queue.Running.App
		} else {
			m.busyRun = ""
		}
		return m, nil
	case agentModelsLoadedMsg:
		m.modelsLoading = false
		if msg.err != "" {
			m.modelErrors[msg.provider] = msg.err
		} else {
			delete(m.modelErrors, msg.provider)
		}
		if msg.provider == "opencode" {
			m.openModels = msg.models
		}
		return m, nil
	case agentConfigAppliedMsg:
		restarted := make([]string, len(msg.result.Restarted))
		for i, r := range msg.result.Restarted {
			restarted[i] = string(r)
		}
		if len(restarted) > 0 {
			m.status = "applied · restarted " + strings.Join(restarted, ", ")
		} else {
			m.status = "applied · no restart needed"
		}
		cfg := msg.result.Config
		draft := cloneAgentConfig(cfg)
		m.config = &cfg
		m.draft = &draft
		m.stagedKeys = map[string]string{}
		m.screen = agentScreenMenu
		m.cursor = 0
		m.err = ""
		return m, nil
	case agentRestartedMsg:
		m.status = fmt.Sprintf("%s restarted · %s", msg.provider, msg.health.Status)
		if m.config != nil && m.config.Health != nil {
			switch msg.provider {
			case "opencode":
				m.config.Health.Opencode = &msg.health
			}
		}
		if m.draft != nil && m.draft.Health != nil {
			switch msg.provider {
			case "opencode":
				m.draft.Health.Opencode = &msg.health
			}
		}
		return m, nil
	case errMsg:
		m.loading = false
		m.err = msg.err.Error()
		m.status = ""
		return m, nil
	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m agentModel) handleKey(msg tea.KeyMsg) (agentModel, tea.Cmd) {
	switch m.screen {
	case agentScreenKey:
		return m.handleKeyInput(msg)
	case agentScreenRole:
		return m.handleRoleSelect(msg)
	default:
		return m.handleMenuKey(msg)
	}
}

func (m agentModel) handleMenuKey(msg tea.KeyMsg) (agentModel, tea.Cmd) {
	items := m.menuItems()
	switch msg.String() {
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(items)-1 {
			m.cursor++
		}
	case "enter":
		if len(items) == 0 || m.draft == nil {
			return m, nil
		}
		return m.triggerAction(items[m.cursor].action)
	case "esc":
		return m, func() tea.Msg { return backMsg{} }
	}
	return m, nil
}

func (m agentModel) handleKeyInput(msg tea.KeyMsg) (agentModel, tea.Cmd) {
	switch msg.String() {
	case "enter":
		value := strings.TrimSpace(m.keyInput.Value())
		if value != "" {
			m.stagedKeys[m.keyProvider] = value
			m.status = fmt.Sprintf("%s API key staged", m.keyProvider)
		}
		m.keyInput.SetValue("")
		m.keyInput.Blur()
		m.screen = agentScreenMenu
		return m, nil
	case "esc":
		m.keyInput.SetValue("")
		m.keyInput.Blur()
		m.screen = agentScreenMenu
		return m, nil
	}
	var cmd tea.Cmd
	m.keyInput, cmd = m.keyInput.Update(msg)
	return m, cmd
}

func (m agentModel) handleRoleSelect(msg tea.KeyMsg) (agentModel, tea.Cmd) {
	options := m.roleOptions(m.editingRole)
	switch msg.String() {
	case "up", "k":
		if m.roleCursor > 0 {
			m.roleCursor--
		}
	case "down", "j":
		if m.roleCursor < len(options)-1 {
			m.roleCursor++
		}
	case "enter":
		if m.draft != nil && len(options) > 0 {
			opt := options[m.roleCursor]
			setDraftRole(m.draft, m.editingRole, opt.provider, opt.model)
			m.status = fmt.Sprintf("%s staged: %s / %s", m.editingRole, opt.provider, opt.model)
		}
		m.screen = agentScreenMenu
	case "esc":
		m.screen = agentScreenMenu
	}
	return m, nil
}

func (m agentModel) triggerAction(action agentMenuAction) (agentModel, tea.Cmd) {
	if m.draft == nil {
		return m, nil
	}
	switch action {
	case agentActionEditPrimary:
		m.openRoleEditor("primary")
	case agentActionEditReviewer:
		m.openRoleEditor("reviewer")
	case agentActionEditChat:
		m.openRoleEditor("chat")
	case agentActionSetOpenKey:
		return m.openKeyEditor("opencode"), textinput.Blink
	case agentActionRestartOpen:
		return m, restartAgentProviderCmd(m.client, "opencode")
	case agentActionApply:
		if m.busyRun != "" {
			/* The server hard-blocks (409) runtime changes while a run is active, and they
			   must NOT affect the in-flight session anyway. Explain instead of failing late. */
			m.err = "a run is active on '" + m.busyRun + "' — its session keeps its current models; runtime changes are locked until it finishes. Stop the run from the NOW panel to change now."
			return m, nil
		}
		return m, applyAgentConfigCmd(m.client, m.agentConfigUpdate())
	case agentActionReset:
		if m.config != nil {
			draft := cloneAgentConfig(*m.config)
			m.draft = &draft
			m.stagedKeys = map[string]string{}
			m.status = "draft reset"
		}
	}
	m.clampCursor()
	return m, nil
}

func (m *agentModel) openRoleEditor(role string) {
	m.editingRole = role
	m.roleCursor = currentRoleOptionIndex(m.roleOptions(role), roleAssignment(*m.draft, role))
	m.screen = agentScreenRole
}

func (m agentModel) openKeyEditor(provider string) agentModel {
	m.keyProvider = provider
	m.keyInput.SetValue("")
	m.keyInput.Focus()
	m.screen = agentScreenKey
	return m
}

func (m *agentModel) clampCursor() {
	items := m.menuItems()
	if len(items) == 0 {
		m.cursor = 0
		return
	}
	if m.cursor >= len(items) {
		m.cursor = len(items) - 1
	}
}

func (m agentModel) View() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("agent runtime"))

	if m.loading {
		b.WriteString("\n\n" + infoStyle.Render("loading…"))
		return screenStyle.Render(b.String())
	}

	cfg := m.draft
	if cfg == nil {
		cfg = m.config
	}
	if cfg == nil {
		if m.err != "" {
			b.WriteString("\n\n" + errorStyle.Render("✗ "+m.err))
		}
		return screenStyle.Render(b.String())
	}

	switch m.screen {
	case agentScreenKey:
		return m.renderKeyInput()
	case agentScreenRole:
		return m.renderRoleSelect()
	}

	w := contentWidth(m.width)
	/* Reset the builder: the redesigned screen leads with a labelled rule, not the
	   plain title written above (kept only for the loading / error fallbacks). */
	b.Reset()
	b.WriteString(accentRule(w, "agent runtime", "") + "\n")
	if m.busyRun != "" {
		b.WriteString(shadowStyle.Render(fmt.Sprintf("⚠ a run is active on '%s' — its session keeps its current models; runtime changes are locked until it finishes (stop the run from the NOW panel)", m.busyRun)) + "\n")
	}
	b.WriteString("\n")

	b.WriteString(m.renderProviders(w, cfg) + "\n\n")
	b.WriteString(m.renderAssignments(w, cfg) + "\n\n")
	b.WriteString(m.renderActions(w))
	if len(m.stagedKeys) > 0 {
		b.WriteString("\n" + shadowStyle.Render(fmt.Sprintf("%d API key(s) staged", len(m.stagedKeys))))
	}
	for provider, err := range m.modelErrors {
		b.WriteString("\n" + errorStyle.Render(fmt.Sprintf("✗ %s models: %s", provider, err)))
	}
	if m.status != "" {
		b.WriteString("\n" + okStyle.Render(m.status))
	}
	if m.err != "" {
		b.WriteString("\n" + errorStyle.Render("✗ "+m.err))
	}
	b.WriteString("\n\n" + hintStyle.Render("↑↓ move · enter trigger · esc back"))
	return screenStyle.Render(b.String())
}

func (m agentModel) renderKeyInput() string {
	w := contentWidth(m.width)
	var b strings.Builder
	b.WriteString(accentRule(w, "agent runtime", labelStyle.Render(m.keyProvider+" api key")) + "\n\n")
	b.WriteString(renderSegs("", sg("› ", colEmber)) + m.keyInput.View())
	b.WriteString("\n\n" + hintStyle.Render("enter stage · esc cancel"))
	return screenStyle.Render(b.String())
}

func (m agentModel) renderRoleSelect() string {
	w := contentWidth(m.width)
	var b strings.Builder
	b.WriteString(accentRule(w, "agent runtime", labelStyle.Render(m.editingRole+" model")) + "\n\n")
	options := m.roleOptions(m.editingRole)
	if len(options) == 0 {
		b.WriteString(errorStyle.Render("✗ no models available") + "\n")
	}
	for i, opt := range options {
		text := fmt.Sprintf("%s / %s", opt.provider, opt.model)
		if i == m.roleCursor {
			b.WriteString(selectedRow(w, "", text, "") + "\n")
		} else {
			b.WriteString(normalRow(w, "", text, "") + "\n")
		}
	}
	b.WriteString("\n" + hintStyle.Render("↑↓ choose · enter stage · esc back"))
	return screenStyle.Render(b.String())
}

/* renderProviders draws the providers as an aligned table under a labelled rule: a
   faint header row, a hairline, then one row per provider. Status (auth + health) uses
   the verdict ramp, never ad-hoc color, so the column reads at a glance. */
func (m agentModel) renderProviders(w int, cfg *contract.PublicAgentConfig) string {
	var b strings.Builder
	b.WriteString(labelRule(w, "providers", hintStyle.Render("1")) + "\n")
	b.WriteString(hintStyle.Render("  "+padRight("provider", 16)+padRight("auth", 10)+padRight("state", 16)+"health") + "\n")
	b.WriteString(hairline(w) + "\n")
	b.WriteString(providerRow("opencode", cfg, m.stagedKeys["opencode"] != ""))
	return b.String()
}

func providerRow(provider string, cfg *contract.PublicAgentConfig, staged bool) string {
	hasKey := cfg.Keys.Opencode
	authText, authCol := "ok", colPass
	stateText, stateCol := "configured", colDim
	if !hasKey {
		authText, authCol = "—", colFaint
		stateText, stateCol = "not set", colFaint
	}
	if staged {
		authText, authCol = "*", colFlaky
		stateText, stateCol = "staged", colFlaky
	}

	icon, healthText, hcol := "○", "unknown", colFaint
	if cfg.Health != nil {
		if h := cfg.Health.Opencode; h != nil {
			healthText = string(h.Status)
			switch h.Status {
			case "healthy":
				icon, hcol = "●", colPass
			case "degraded":
				icon, hcol = "◐", colFlaky
			case "starting":
				icon, hcol = "◐", colInfra
			default: /* failed | needs_config */
				icon, hcol = "○", colFlaky
			}
		}
	}
	nameCol := colFg
	if icon != "●" {
		nameCol = colDim
	}
	return renderSegs("",
		sg(icon+" ", hcol),
		seg{text: padRight(provider, 14), fg: nameCol, bold: icon == "●"},
		sg(padRight(authText, 10), authCol),
		sg(padRight(stateText, 16), stateCol),
		sg(healthText, hcol),
	)
}

func (m agentModel) renderAssignments(w int, cfg *contract.PublicAgentConfig) string {
	var b strings.Builder
	b.WriteString(labelRule(w, "assignments", "") + "\n")
	for _, role := range agentRoles() {
		a := roleAssignment(*cfg, role)
		b.WriteString(renderSegs("",
			sg(padRight(role, 11), colDim),
			sg(string(a.Provider), colFg),
			sg(" / ", colFaint),
			sg(a.Model, colDim),
		) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m agentModel) renderActions(w int) string {
	var b strings.Builder
	right := ""
	if n := len(m.stagedKeys); n > 0 {
		right = renderSegs("", sg("‹", colFaint), sg(fmt.Sprintf("%d staged", n), colEmber), sg("›", colFaint))
	}
	b.WriteString(labelRule(w, "actions", right) + "\n")
	for i, item := range m.menuItems() {
		if i == m.cursor {
			b.WriteString(selectedRow(w, "", item.label, "") + "\n")
		} else {
			b.WriteString(normalRow(w, "", item.label, "") + "\n")
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m agentModel) menuItems() []agentMenuItem {
	if m.draft == nil {
		return nil
	}
	return []agentMenuItem{
		agentMenuItem{label: fmt.Sprintf("edit primary model (%s)", roleAssignment(*m.draft, "primary").Model), action: agentActionEditPrimary},
		agentMenuItem{label: fmt.Sprintf("edit reviewer model (%s)", roleAssignment(*m.draft, "reviewer").Model), action: agentActionEditReviewer},
		agentMenuItem{label: fmt.Sprintf("edit chat model (%s)", roleAssignment(*m.draft, "chat").Model), action: agentActionEditChat},
		agentMenuItem{label: "set opencode api key", action: agentActionSetOpenKey},
		agentMenuItem{label: "restart opencode", action: agentActionRestartOpen},
		agentMenuItem{label: "apply changes", action: agentActionApply},
		agentMenuItem{label: "reset draft", action: agentActionReset},
	}
}

func (m agentModel) roleOptions(role string) []agentRoleOption {
	if m.draft == nil {
		return nil
	}
	providers := []string{"opencode"}
	current := roleAssignment(*m.draft, role)
	var options []agentRoleOption
	for _, provider := range providers {
		models := m.modelsFor(provider)
		if len(models) == 0 && string(current.Provider) == provider {
			models = []contract.AgentModelInfo{{Id: current.Model}}
		}
		foundCurrent := false
		for _, model := range models {
			if string(current.Provider) == provider && model.Id == current.Model {
				foundCurrent = true
			}
			options = append(options, agentRoleOption{provider: provider, model: model.Id})
		}
		if string(current.Provider) == provider && !foundCurrent && current.Model != "" {
			options = append([]agentRoleOption{{provider: provider, model: current.Model}}, options...)
		}
	}
	return options
}

func (m agentModel) modelsFor(provider string) []contract.AgentModelInfo {
	if provider == "opencode" {
		return m.openModels
	}
	return nil
}

func (m agentModel) agentConfigUpdate() contract.AgentConfigUpdate {
	if m.draft == nil {
		return contract.AgentConfigUpdate{}
	}
	primary := m.draft.Assignments.Primary
	reviewer := m.draft.Assignments.Reviewer
	chat := m.draft.Assignments.Chat
	input := contract.AgentConfigUpdate{
		Assignments: &struct {
			Chat     *contract.RoleAssignment `json:"chat,omitempty"`
			Primary  *contract.RoleAssignment `json:"primary,omitempty"`
			Reviewer *contract.RoleAssignment `json:"reviewer,omitempty"`
		}{
			Primary:  &primary,
			Reviewer: &reviewer,
			Chat:     &chat,
		},
	}
	if len(m.stagedKeys) > 0 {
		keys := struct {
			Opencode *string `json:"opencode,omitempty"`
		}{}
		if v := m.stagedKeys["opencode"]; v != "" {
			keys.Opencode = &v
		}
		input.ApiKeys = &keys
	}
	return input
}

/* ── Messages ───────────────────────────────────────────────────────────────── */

/* agentSelectedMsg opens the agent runtime screen. `role` ("primary"/"reviewer"/"chat") jumps
   straight into editing that model; empty opens the full screen with nothing pre-selected. */
type agentSelectedMsg struct{ role string }

type agentConfigLoadedMsg struct{ config contract.PublicAgentConfig }

type agentModelsLoadedMsg struct {
	provider string
	models   []contract.AgentModelInfo
	err      string
}

type agentConfigAppliedMsg struct {
	result contract.AgentConfigApplyResult
}

type agentRestartedMsg struct {
	provider string
	health   contract.AgentProviderHealth
}

func fetchAgentConfigCmd(c *api.Client) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cfg, err := c.GetAgentConfig(ctx)
		if err != nil {
			return errMsg{err}
		}
		return agentConfigLoadedMsg{config: cfg}
	}
}

func fetchAgentModelsCmd(c *api.Client, provider string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		res, err := c.ListAgentModels(ctx, provider)
		if err != nil {
			return agentModelsLoadedMsg{provider: provider, err: err.Error()}
		}
		return agentModelsLoadedMsg{provider: provider, models: res.Models}
	}
}

func applyAgentConfigCmd(c *api.Client, in contract.AgentConfigUpdate) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		res, err := c.UpdateAgentConfig(ctx, in)
		if err != nil {
			return errMsg{err}
		}
		return agentConfigAppliedMsg{result: res}
	}
}

func restartAgentProviderCmd(c *api.Client, provider string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		res, err := c.RestartAgentProvider(ctx, provider)
		if err != nil {
			return errMsg{err}
		}
		return agentRestartedMsg{provider: provider, health: res.Health}
	}
}

func cloneAgentConfig(cfg contract.PublicAgentConfig) contract.PublicAgentConfig {
	return cfg
}

func agentRoles() []string {
	return []string{"primary", "reviewer", "chat"}
}

func roleAssignment(cfg contract.PublicAgentConfig, role string) contract.RoleAssignment {
	switch role {
	case "reviewer":
		return cfg.Assignments.Reviewer
	case "chat":
		return cfg.Assignments.Chat
	default:
		return cfg.Assignments.Primary
	}
}

func setDraftRole(cfg *contract.PublicAgentConfig, role, provider, model string) {
	assignment := contract.RoleAssignment{Provider: contract.RoleAssignmentProvider(provider), Model: model}
	switch role {
	case "reviewer":
		cfg.Assignments.Reviewer = assignment
	case "chat":
		cfg.Assignments.Chat = assignment
	default:
		cfg.Assignments.Primary = assignment
	}
}

func currentRoleOptionIndex(options []agentRoleOption, assignment contract.RoleAssignment) int {
	for i, opt := range options {
		if opt.provider == string(assignment.Provider) && opt.model == assignment.Model {
			return i
		}
	}
	return 0
}
