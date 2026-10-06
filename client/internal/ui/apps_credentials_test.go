package ui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/ArielFalcon/qayaba/internal/api"
	"github.com/ArielFalcon/qayaba/internal/contract"
)

/* What the form sent to the control API when it saved an app. */
type savedApp struct {
	method    string
	env       map[string]string
	clearAuth bool
}

/* A control API that records every app create/update the form sends. */
func appsAPI(t *testing.T) (*api.Client, *[]savedApp) {
	t.Helper()
	var saved []savedApp
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte("[]"))
			return
		}
		var body struct {
			Env       map[string]string `json:"env"`
			ClearAuth bool              `json:"clearAuth"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		saved = append(saved, savedApp{method: r.Method, env: body.Env, clearAuth: body.ClearAuth})
		_, _ = w.Write([]byte(`{"ok":true,"name":"shop","path":"config/apps/shop.yaml"}`))
	}))
	t.Cleanup(srv.Close)
	return api.New(srv.URL, "token"), &saved
}

/* Presses enter on the form's save row and runs the command it returns (the API call). */
func pressSave(m appAdminModel) appAdminModel {
	m.formCursor = fSave
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		_ = cmd()
	}
	return next
}

func editFormApp() contract.AppView {
	form := contract.AppViewAuthKindForm
	return contract.AppView{Name: "shop", Repo: "org/shop", BaseUrl: "https://dev.shop.test", AuthKind: &form}
}

func TestEditingAppCredentialsKeepsEveryStoredSecretLeftBlank(t *testing.T) {
	cases := []struct {
		name    string
		fill    func(m *appAdminModel)
		sent    map[string]string
		notSent []string
	}{
		{
			name:    "a username-only edit keeps the stored app password",
			fill:    func(m *appAdminModel) { m.userInput.SetValue("new-admin") },
			sent:    map[string]string{"QA_SHOP_TEST_USER": "new-admin"},
			notSent: []string{"QA_SHOP_TEST_PASS"},
		},
		{
			name:    "a password-only edit updates the app password and keeps the stored user",
			fill:    func(m *appAdminModel) { m.passInput.SetValue("rotated") },
			sent:    map[string]string{"QA_SHOP_TEST_PASS": "rotated"},
			notSent: []string{"QA_SHOP_TEST_USER"},
		},
		{
			name: "a user-only edit of the environment gate keeps its stored password",
			fill: func(m *appAdminModel) {
				m.envBasic = true
				m.envUserInput.SetValue("gate-user")
			},
			sent:    map[string]string{"DEV_ENV_USER": "gate-user"},
			notSent: []string{"DEV_ENV_PASS"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client, saved := appsAPI(t)
			m := newEditAppModel(client, editFormApp())
			tc.fill(&m)

			pressSave(m)

			if len(*saved) != 1 || (*saved)[0].method != http.MethodPut {
				t.Fatalf("expected one app update; got %+v", *saved)
			}
			env := (*saved)[0].env
			for key, want := range tc.sent {
				if env[key] != want {
					t.Fatalf("%s = %q, want %q (env %+v)", key, env[key], want, env)
				}
			}
			for _, key := range tc.notSent {
				if _, ok := env[key]; ok {
					t.Fatalf("%s must not be sent when left blank — it would overwrite the stored secret (env %+v)", key, env)
				}
			}
		})
	}
}

func TestEditingAppLoginOffClearsItWithoutSendingSecrets(t *testing.T) {
	client, saved := appsAPI(t)
	m := newEditAppModel(client, editFormApp())
	m.authMode = "disabled"

	pressSave(m)

	if len(*saved) != 1 || !(*saved)[0].clearAuth {
		t.Fatalf("turning app login off must ask the server to clear it; got %+v", *saved)
	}
	for key := range (*saved)[0].env {
		if strings.HasPrefix(key, "QA_SHOP_") {
			t.Fatalf("no app login secret may be sent while clearing it; got %s", key)
		}
	}
}

func onboardFormWithLogin(client *api.Client, user, pass string) appAdminModel {
	m := newOnboardModel(client)
	m.step = appStepForm
	m.repo = "org/shop"
	m.nameInput.SetValue("shop")
	m.baseInput.SetValue("https://dev.shop.test")
	m.authMode = "form"
	m.userInput.SetValue(user)
	m.passInput.SetValue(pass)
	return m
}

func TestOnboardingWithAppLoginRequiresAPassword(t *testing.T) {
	client, saved := appsAPI(t)

	next := pressSave(onboardFormWithLogin(client, "admin", ""))

	if len(*saved) != 0 {
		t.Fatalf("an app login without a password must not be created; sent %+v", *saved)
	}
	if !strings.Contains(strings.ToLower(next.View()), "password is required") {
		t.Fatalf("the form must say the password is missing:\n%s", next.View())
	}
}

func TestOnboardingWithAppLoginSendsUserAndPassword(t *testing.T) {
	client, saved := appsAPI(t)

	pressSave(onboardFormWithLogin(client, "admin", "s3cret"))

	if len(*saved) != 1 || (*saved)[0].method != http.MethodPost {
		t.Fatalf("expected one app create; got %+v", *saved)
	}
	env := (*saved)[0].env
	if env["QA_SHOP_TEST_USER"] != "admin" || env["QA_SHOP_TEST_PASS"] != "s3cret" {
		t.Fatalf("the app login must be stored; env %+v", env)
	}
}
