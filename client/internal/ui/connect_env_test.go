package ui

import "testing"

func TestEnvConnectHostPrefersQAHost(t *testing.T) {
	t.Setenv("QA_HOST", " orchestrator:8080 ")
	if got := envConnectHost(); got != "orchestrator:8080" {
		t.Fatalf("envConnectHost() = %q, want %q", got, "orchestrator:8080")
	}
}

func TestEnvConnectHostDefaultsWithoutQAHost(t *testing.T) {
	t.Setenv("QA_HOST", "")
	if got := envConnectHost(); got != defaultConnectHost {
		t.Fatalf("envConnectHost() = %q, want %q", got, defaultConnectHost)
	}
}
