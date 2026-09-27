package ui

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ArielFalcon/qayaba/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

func TestOnboardModelStartsWithNoSelectedReposAndAManualInput(t *testing.T) {
	m := newOnboardModel(nil)
	if len(m.selected) != 0 {
		t.Fatalf("expected no repos selected initially, got %d", len(m.selected))
	}
	if m.manualInput.Placeholder == "" {
		t.Fatal("expected a manual-entry input to be initialized")
	}
}

func TestRepoStepTogglesSelectionAndCyclesRole(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepRepo
	m.repos = []contract.RepoListItem{{FullName: "org/web"}, {FullName: "org/svc"}}

	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeySpace})
	if len(m.selected) != 1 || m.selected[0].fullName != "org/web" {
		t.Fatalf("space should select the cursor repo; got %+v", m.selected)
	}
	if m.selected[0].role != "frontend" { /* first selection defaults to frontend */
		t.Fatalf("first selected repo should default to frontend; got %q", m.selected[0].role)
	}
	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'r'}})
	if m.selected[0].role != "service" {
		t.Fatalf("r should cycle role to service; got %q", m.selected[0].role)
	}
}

func TestRepoStepRequiresExactlyOneFrontend(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepRepo
	m.repos = []contract.RepoListItem{{FullName: "org/web"}, {FullName: "org/svc"}}
	m.selected = []repoRole{{"org/web", "service"}, {"org/svc", "service"}} /* zero frontends */
	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeyEnter})
	if m.step == appStepForm {
		t.Fatal("enter must NOT advance with zero frontends")
	}
	if m.err == "" {
		t.Fatal("expected a validation error for zero frontends")
	}
}

func TestRepoStepViewShowsCheckboxesRolesAndHints(t *testing.T) {
	m := newOnboardModel(nil)
	m.step, m.width = appStepRepo, 100
	m.repos = []contract.RepoListItem{{FullName: "org/web"}, {FullName: "org/svc"}}
	m.selected = []repoRole{{"org/web", "frontend"}}
	out := strings.ToLower(m.View())
	for _, w := range []string{"org/web", "org/svc", "frontend", "space", "role"} {
		if !strings.Contains(out, w) {
			t.Fatalf("repo-step View missing %q:\n%s", w, out)
		}
	}
}

/* The manual "/" typed-slug entry must actually surface in the View while active — otherwise
   the user has no visual feedback that their keystrokes are going into the input. */
func TestRepoStepViewShowsManualInputWhenActive(t *testing.T) {
	m := newOnboardModel(nil)
	m.step, m.width = appStepRepo, 100
	m.repos = []contract.RepoListItem{{FullName: "org/web"}}
	m.manualActive = true
	m.manualInput.SetValue("org/typed")
	out := m.View()
	if !strings.Contains(out, "org/typed") {
		t.Fatalf("repo-step View should show the manual input value when active:\n%s", out)
	}
}

/* Each selected repo's OWN row must carry its own role — the wizard's core invariant
   (exactly one frontend) has to be legible at a glance, per row, not just present somewhere
   in the overall View (which TestRepoStepViewShowsCheckboxesRolesAndHints already allows). */
func TestRepoStepViewMarksFrontendRepoDistinctly(t *testing.T) {
	m := newOnboardModel(nil)
	m.step, m.width = appStepRepo, 100
	m.repos = []contract.RepoListItem{{FullName: "org/web"}, {FullName: "org/svc"}}
	m.selected = []repoRole{{"org/web", "frontend"}, {"org/svc", "service"}}
	out := strings.ToLower(m.View())
	lines := strings.Split(out, "\n")
	var webLine, svcLine string
	for _, l := range lines {
		switch {
		case strings.Contains(l, "org/web"):
			webLine = l
		case strings.Contains(l, "org/svc"):
			svcLine = l
		}
	}
	if webLine == "" || svcLine == "" {
		t.Fatalf("expected both repos to render a row:\n%s", out)
	}
	if !strings.Contains(webLine, "frontend") {
		t.Fatalf("the frontend repo's own row must show its role:\n%s", webLine)
	}
	if strings.Contains(svcLine, "frontend") {
		t.Fatalf("the service repo's row must not be marked as frontend:\n%s", svcLine)
	}
}

func TestCreateInputSplitsFrontendAndServices(t *testing.T) {
	sel := []repoRole{{"org/web", "frontend"}, {"org/svc-a", "service"}, {"org/svc-b", "service"}}
	in := buildCreateInput(sel, "shop", "https://dev", "", "e2e", "qa", true, true, nil)
	if in.Repo != "org/web" {
		t.Fatalf("frontend must be the primary Repo; got %q", in.Repo)
	}
	if in.Services == nil || len(*in.Services) != 2 {
		t.Fatalf("expected 2 services; got %+v", in.Services)
	}
	if (*in.Services)[0].Repo != "org/svc-a" || (*in.Services)[1].Repo != "org/svc-b" {
		t.Fatalf("services must be in list order; got %+v", *in.Services)
	}
	if in.Name == nil || *in.Name != "shop" {
		t.Fatalf("name must be set; got %+v", in.Name)
	}
}

func TestCreateInputNoServicesWhenSingleFrontend(t *testing.T) {
	in := buildCreateInput([]repoRole{{"org/only", "frontend"}}, "solo", "https://dev", "", "e2e", "qa", false, false, nil)
	if in.Repo != "org/only" {
		t.Fatalf("Repo=%q", in.Repo)
	}
	if in.Services != nil {
		t.Fatalf("no services expected; got %+v", in.Services)
	}
}

func TestFormEscInCreateModeGoesBackToRepoStepPreservingState(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepForm
	m.selected = []repoRole{{"org/web", "frontend"}, {"org/svc", "service"}}
	m.nameInput.SetValue("shop")
	m, cmd := m.updateForm(tea.KeyMsg{Type: tea.KeyEsc})
	if m.step != appStepRepo {
		t.Fatalf("create-mode form esc must go back to the repo step; got step %v", m.step)
	}
	if len(m.selected) != 2 || m.selected[0].fullName != "org/web" {
		t.Fatalf("selection must survive back-nav; got %+v", m.selected)
	}
	if m.nameInput.Value() != "shop" {
		t.Fatalf("form values must survive back-nav; name=%q", m.nameInput.Value())
	}
	if cmd != nil {
		/* must NOT emit backMsg (which would exit the wizard) */
		if _, isBack := cmd().(backMsg); isBack {
			t.Fatal("create-mode form esc must NOT emit backMsg (that exits the wizard)")
		}
	}
}

func TestFormEscInEditModeExits(t *testing.T) {
	/* Edit mode opens directly on the form with no repo step, so esc must still exit. */
	m := newEditAppModel(nil, contract.AppView{Name: "shop", Repo: "org/web"})
	m.step = appStepForm
	_, cmd := m.updateForm(tea.KeyMsg{Type: tea.KeyEsc})
	if cmd == nil {
		t.Fatal("edit-mode form esc must emit a command (backMsg to exit)")
	}
	if _, isBack := cmd().(backMsg); !isBack {
		t.Fatalf("edit-mode form esc must emit backMsg; got %#v", cmd())
	}
}

/* The repo step's enter prefill must be idempotent: a form -> (esc) -> repo -> (enter) -> form
   round-trip (B5) must NOT clobber a manually edited name or a typed base URL. */
func TestFormValuesSurviveRepoRoundTrip(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepRepo
	m.repos = []contract.RepoListItem{{FullName: "org/web"}}
	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeySpace}) /* select org/web (frontend) */
	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeyEnter})
	m.nameInput.SetValue("my-shop")
	m.baseInput.SetValue("https://dev.shop.com")
	m, _ = m.updateForm(tea.KeyMsg{Type: tea.KeyEsc}) /* back to repo (B5) */
	if m.step != appStepRepo {
		t.Fatalf("expected repo step; got %v", m.step)
	}
	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeyEnter}) /* forward to form again */
	if m.nameInput.Value() != "my-shop" {
		t.Fatalf("name wiped on round-trip: %q", m.nameInput.Value())
	}
	if m.baseInput.Value() != "https://dev.shop.com" {
		t.Fatalf("base URL wiped on round-trip: %q", m.baseInput.Value())
	}
}

/* "/" must work even when the repo list came back empty — otherwise the manual-entry
   input is focused but never rendered, so the user gets no feedback for their keystrokes. */
func TestManualInputRendersWhenRepoListEmpty(t *testing.T) {
	m := newOnboardModel(nil)
	m.step, m.width = appStepRepo, 100
	m.repos = nil
	m.manualActive = true
	m.manualInput.SetValue("org/typed")
	out := strings.ToLower(m.View())
	if !strings.Contains(out, "org/typed") {
		t.Fatalf("manual input must render even with an empty repo list:\n%s", out)
	}
}

/* The manual "/" entry's affordance is "add repo" — it must never remove an already-selected
   repo, unlike the space-key toggle. */
func TestManualAddIsAddOnlyNeverRemoves(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepRepo
	m.repos = []contract.RepoListItem{{FullName: "org/web"}}
	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeySpace}) /* select org/web via space */
	if len(m.selected) != 1 {
		t.Fatalf("expected 1 selected after space; got %d", len(m.selected))
	}
	m.manualActive = true
	m.manualInput.SetValue("org/web")
	m, _ = m.updateManualRepo(tea.KeyMsg{Type: tea.KeyEnter}) /* manual-add the same slug again */
	if len(m.selected) != 1 {
		t.Fatalf("manual add of an already-selected repo must be add-only, not a removal; got %+v", m.selected)
	}
	if m.selected[0].fullName != "org/web" || m.selected[0].role != "frontend" {
		t.Fatalf("expected org/web to remain selected as frontend; got %+v", m.selected)
	}
}

/* reposLoadedMsg keeps m.selected across owner switches, but the checkbox list only marks
   repos present in the CURRENT m.repos page — so a cross-owner or otherwise off-list pick
   becomes invisible (and undoable only by memory) unless a summary surfaces it. */
func TestSelectionSummaryShowsOffListRepos(t *testing.T) {
	m := newOnboardModel(nil)
	m.step, m.width = appStepRepo, 100
	m.repos = []contract.RepoListItem{{FullName: "org/web"}}
	m.selected = []repoRole{{"org/web", "frontend"}, {"org/other-owner-repo", "service"}}
	out := m.View()
	if !strings.Contains(out, "org/other-owner-repo") {
		t.Fatalf("selection summary must show off-list repos:\n%s", out)
	}
}

/* buildCreateInput must agree with frontendRepo() (used for display + the repo-step
   prefill) on which frontend wins when more than one is present: the FIRST. This is
   defensive — the UI's one-frontend invariant makes this unreachable in practice — but it
   locks the contract so the two never silently diverge. */
func TestCreateInputTakesFirstFrontendWhenMultiplePresent(t *testing.T) {
	sel := []repoRole{{"org/first", "frontend"}, {"org/second", "frontend"}}
	in := buildCreateInput(sel, "shop", "https://dev", "", "e2e", "qa", true, true, nil)
	if in.Repo != "org/first" {
		t.Fatalf("expected the first frontend to win; got %q", in.Repo)
	}
}

/* Environment Basic and app login are separate rows. Both default off. */
func TestAuthDefaultsDisabledAndTogglesToBasic(t *testing.T) {
	m := newOnboardModel(nil)
	if m.authMode != "disabled" || m.envBasic {
		t.Fatalf("auth must default off; mode=%q basic=%v", m.authMode, m.envBasic)
	}
	m.step = appStepForm
	m.formCursor = fEnvAuth
	m.toggleFormValue()
	if !m.envBasic {
		t.Fatal("space on env auth should turn HTTP Basic on")
	}
	m.formCursor = fAuth
	m.toggleFormValue()
	if m.authMode != "form" {
		t.Fatalf("space on app login should switch to form; got %q", m.authMode)
	}
}

/* Credential rows exist only while their layer is on. Toggles themselves stay reachable. */
func TestMoveFormFocusSkipsHiddenAuthFieldsWhenDisabled(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepForm
	m.authMode = "disabled"

	m.formCursor = fPrefix
	m.moveFormFocus(1)
	if m.formCursor != fEnvAuth {
		t.Fatalf("expected fEnvAuth after one tab from fPrefix; got %d", m.formCursor)
	}
	m.moveFormFocus(1)
	if m.formCursor != fAuth {
		t.Fatalf("expected fAuth, skipping hidden env credentials; got %d", m.formCursor)
	}
	m.moveFormFocus(1)
	if m.formCursor != fSave {
		t.Fatalf("expected fSave, skipping hidden app credentials; got %d", m.formCursor)
	}

	m.formCursor = fSave
	m.moveFormFocus(-1)
	if m.formCursor != fAuth {
		t.Fatalf("expected fAuth when tabbing back from fSave; got %d", m.formCursor)
	}

	m.envBasic = true
	m.formCursor = fEnvAuth
	m.moveFormFocus(1)
	if m.formCursor != fEnvUser {
		t.Fatalf("expected fEnvUser when environment auth is on; got %d", m.formCursor)
	}
	m.authMode = "form"
	m.formCursor = fAuth
	m.moveFormFocus(1)
	if m.formCursor != fAuthUser {
		t.Fatalf("expected fAuthUser when app login is on; got %d", m.formCursor)
	}
}

func TestFormViewShowsAuthAndRevealsCredsWhenBasic(t *testing.T) {
	m := newOnboardModel(nil)
	m.step, m.width = appStepForm, 100
	m.repo = "org/web"
	out := strings.ToLower(m.View())
	if !strings.Contains(out, "env auth") || !strings.Contains(out, "app login") {
		t.Fatalf("form must show both auth layers:\n%s", out)
	}
	if strings.Contains(out, "env password") {
		t.Fatal("password row must be hidden while auth is disabled")
	}
	m.envBasic = true
	out = strings.ToLower(m.View())
	if !strings.Contains(out, "env user") || !strings.Contains(out, "env password") {
		t.Fatalf("environment auth must reveal user+password:\n%s", out)
	}
}

func TestFormAuthEnvKeysAreAppScoped(t *testing.T) {
	m := newOnboardModel(nil)
	m.nameInput.SetValue("jhipster-store")
	m.authMode = "form"
	m.userInput.SetValue("admin")
	m.passInput.SetValue("admin")
	env := m.envVars()
	if env["QA_JHIPSTER_STORE_TEST_USER"] != "admin" || env["QA_JHIPSTER_STORE_TEST_PASS"] != "admin" {
		t.Fatalf("form auth must persist app-scoped DEV test creds; got %+v", env)
	}
	if _, ok := env["DEV_ENV_USER"]; ok {
		t.Fatal("form auth must not write the environment Basic Auth keys")
	}
	decl := m.authDeclaration()
	if decl == nil || decl.Kind != "form" || decl.UsernameEnv == nil || *decl.UsernameEnv != "QA_JHIPSTER_STORE_TEST_USER" {
		t.Fatalf("form auth must declare usernameEnv; got %+v", decl)
	}
}

func TestMtlsAuthReadsP12AsBase64(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "client.p12")
	if err := os.WriteFile(certPath, []byte("p12-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := newOnboardModel(nil)
	m.nameInput.SetValue("jhipster-store")
	m.authMode = "mtls"
	m.userInput.SetValue(certPath)
	m.passInput.SetValue("secret")
	env, err := m.collectedEnv()
	if err != nil {
		t.Fatal(err)
	}
	if env["QA_JHIPSTER_STORE_CLIENT_CERT"] != base64.StdEncoding.EncodeToString([]byte("p12-bytes")) {
		t.Fatalf("certificate must be base64; got %q", env["QA_JHIPSTER_STORE_CLIENT_CERT"])
	}
	if env["QA_JHIPSTER_STORE_CLIENT_CERT_PASS"] != "secret" {
		t.Fatalf("passphrase not stored; got %+v", env)
	}
	missing := m
	missing.userInput.SetValue(filepath.Join(dir, "nope.p12"))
	if _, err := missing.collectedEnv(); err == nil {
		t.Fatal("a missing certificate file must fail save")
	}
}

/* AppView.AuthKind is a generated enum pointer (contract.AppViewAuthKind), not a plain
   *string — newEditAppModel must convert it into the model's plain-string authMode/storedAuth
   and seed the placeholder text, exactly as it did before the type was named by codegen. */
func TestNewEditAppModelReadsStoredAuthKindFromAppView(t *testing.T) {
	form := contract.AppViewAuthKindForm
	app := contract.AppView{Name: "shop", Repo: "org/shop", AuthKind: &form}
	m := newEditAppModel(nil, app)
	if m.authMode != "form" {
		t.Fatalf("authMode=%q, want form", m.authMode)
	}
	if m.storedAuth != "form" {
		t.Fatalf("storedAuth=%q, want form (so an edit that clears it can detect the change)", m.storedAuth)
	}
	if m.userInput.Placeholder != "app user" {
		t.Fatalf("form placeholders not applied: %q", m.userInput.Placeholder)
	}

	mtls := contract.AppViewAuthKindMtls
	app.AuthKind = &mtls
	m = newEditAppModel(nil, app)
	if m.authMode != "mtls" {
		t.Fatalf("authMode=%q, want mtls", m.authMode)
	}
	if m.userInput.Placeholder != "path to .p12" {
		t.Fatalf("mtls placeholder not applied: %q", m.userInput.Placeholder)
	}
}

func TestAuthModeCyclesThroughFormAndCertificate(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepForm
	m.formCursor = fAuth
	m.toggleFormValue()
	if m.authMode != "form" {
		t.Fatalf("one space should reach form; got %q", m.authMode)
	}
	m.toggleFormValue()
	if m.authMode != "mtls" {
		t.Fatalf("two spaces should reach certificate; got %q", m.authMode)
	}
	m.toggleFormValue()
	if m.authMode != "disabled" {
		t.Fatalf("three spaces should return to none; got %q", m.authMode)
	}
}

func TestEnvVarsFromBasicAuth(t *testing.T) {
	m := newOnboardModel(nil)
	m.envBasic = true
	m.envUserInput.SetValue("envuser")
	m.envPassInput.SetValue("envpass")
	env := m.envVars()
	if env["DEV_ENV_USER"] != "envuser" || env["DEV_ENV_PASS"] != "envpass" {
		t.Fatalf("basic auth must yield DEV_ENV_USER/PASS; got %+v", env)
	}
	m.envBasic = false
	if len(m.envVars()) != 0 {
		t.Fatal("disabled auth must yield no env vars")
	}
}

func TestEnvBasicAndFormCanBeCollectedTogether(t *testing.T) {
	m := newOnboardModel(nil)
	m.nameInput.SetValue("shop")
	m.envBasic = true
	m.envUserInput.SetValue("gate")
	m.envPassInput.SetValue("gate-pass")
	m.authMode = "form"
	m.userInput.SetValue("admin")
	m.passInput.SetValue("admin-pass")
	env := m.envVars()
	if env["DEV_ENV_USER"] != "gate" || env["QA_SHOP_TEST_USER"] != "admin" {
		t.Fatalf("both layers must be collected in one save; got %+v", env)
	}
}

/* The edit form reuses the create form, so it shows the DEV Basic Auth fields. buildUpdateInput must thread env exactly like buildCreateInput: non-nil only when the caller passes a non-empty map (m.envVars()'s contract — basic auth on with a non-empty user), so an edit with auth left disabled sends no Env and never wipes creds already stored server-side. */
func TestBuildUpdateInputCarriesEnvWhenBasicAuth(t *testing.T) {
	in := buildUpdateInput("org/web", "https://dev", "", "e2e", "qa", true, true, map[string]string{"DEV_ENV_USER": "u", "DEV_ENV_PASS": "p"})
	if in.Env == nil {
		t.Fatal("edit input must carry env when basic auth is set")
	}
	if (*in.Env)["DEV_ENV_USER"] != "u" || (*in.Env)["DEV_ENV_PASS"] != "p" {
		t.Fatalf("env creds not threaded; got %+v", *in.Env)
	}
}

func TestBuildUpdateInputOmitsEnvWhenNone(t *testing.T) {
	in := buildUpdateInput("org/web", "https://dev", "", "e2e", "qa", true, true, nil)
	if in.Env != nil {
		t.Fatalf("no env expected (must not wipe existing creds); got %+v", *in.Env)
	}
}

/* Regression: on a text field, j/k must be typed, not treated as motion — otherwise words
   containing them (e.g. "joomeco", "webapp") can't be entered. Navigation is tab/arrows only. */
func TestFormTextFieldAcceptsJAndKAsInput(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepForm
	m.formCursor = fURL
	m.baseInput.Focus()
	m, _ = m.updateForm(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	m, _ = m.updateForm(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	if m.formCursor != fURL {
		t.Fatalf("j/k must not move focus on a text field; cursor=%v", m.formCursor)
	}
	if m.baseInput.Value() != "jk" {
		t.Fatalf("j/k must type into the focused input; got %q", m.baseInput.Value())
	}
}
