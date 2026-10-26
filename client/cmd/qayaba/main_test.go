package main

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/ArielFalcon/qayaba/internal/api"
)

func TestUsageOffersNoRuntimeSelection(t *testing.T) {
	var out bytes.Buffer
	printInfo([]string{"--help"}, &out)
	for _, gone := range []string{"--codex", "--dual", "--opencode", "agent set", "codex"} {
		if strings.Contains(out.String(), gone) {
			t.Fatalf("usage still mentions %q:\n%s", gone, out.String())
		}
	}
}

func TestDefaultHostURLAddsScheme(t *testing.T) {
	t.Setenv("QA_HOST", "localhost:9090")
	if got := defaultHostURL(); got != "http://localhost:9090" {
		t.Fatalf("host url = %q", got)
	}

	t.Setenv("QA_HOST", "https://qa.example.test/")
	if got := defaultHostURL(); got != "https://qa.example.test" {
		t.Fatalf("host url = %q", got)
	}
}

func TestDefaultHostURLFallsBackToTheServerDefaultWhenQAHostIsUnset(t *testing.T) {
	t.Setenv("QA_HOST", "")
	if got := defaultHostURL(); got != "http://"+api.DefaultHost {
		t.Fatalf("host url = %q, want the server's default host", got)
	}
}

func TestHelpNamesTheCommandsAndTheDefaultHost(t *testing.T) {
	for _, flag := range []string{"--help", "-h"} {
		var out bytes.Buffer
		if !printInfo([]string{flag}, &out) {
			t.Fatalf("%s was not handled", flag)
		}
		for _, want := range []string{"agent", "QA_HOST", api.DefaultHost, "--version"} {
			if !strings.Contains(out.String(), want) {
				t.Fatalf("%s output does not mention %q:\n%s", flag, want, out.String())
			}
		}
	}
}

func TestHelpIsHandledAfterASubcommandToo(t *testing.T) {
	var out bytes.Buffer
	if !printInfo([]string{"agent", "models", "--help"}, &out) || out.Len() == 0 {
		t.Fatal("a --help after a subcommand must print the usage instead of running it")
	}
}

func TestVersionPrintsOneLine(t *testing.T) {
	var out bytes.Buffer
	if !printInfo([]string{"--version"}, &out) {
		t.Fatal("--version was not handled")
	}
	line := strings.TrimSpace(out.String())
	if line == "" || strings.Contains(line, "\n") || !strings.HasPrefix(line, "qayaba ") {
		t.Fatalf("version output = %q", out.String())
	}
}

func TestOtherArgumentsAreNotInfoFlags(t *testing.T) {
	var out bytes.Buffer
	if printInfo([]string{"agent", "status"}, &out) || printInfo(nil, &out) || out.Len() != 0 {
		t.Fatalf("no info flag must print nothing: %q", out.String())
	}
}

// The binary itself, with no terminal attached: --help and --version must print and exit 0 instead
// of starting the full-screen UI (which needs a TTY).
func TestInfoFlagsExitZeroWithoutATerminal(t *testing.T) {
	for _, flag := range []string{"--help", "--version"} {
		cmd := exec.Command(os.Args[0], "-test.run=^TestRunMainAsHelperProcess$")
		cmd.Env = append(os.Environ(), "QAYABA_HELPER_ARGS="+flag)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("%s: %v (stdout %q)", flag, err, out)
		}
		if len(bytes.TrimSpace(out)) == 0 {
			t.Fatalf("%s printed nothing", flag)
		}
	}
}

// A flag or command the client does not know (a removed runtime selector among them) fails with
// exit 2 and the usage, instead of opening the UI as if it had been understood.
func TestUnknownArgumentExitsTwoWithoutATerminal(t *testing.T) {
	for _, arg := range []string{"--dual", "status"} {
		cmd := exec.Command(os.Args[0], "-test.run=^TestRunMainAsHelperProcess$")
		cmd.Env = append(os.Environ(), "QAYABA_HELPER_ARGS="+arg)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		err := cmd.Run()
		exit, ok := err.(*exec.ExitError)
		if !ok || exit.ExitCode() != 2 {
			t.Fatalf("%s: want exit 2, got %v", arg, err)
		}
		if !strings.Contains(stderr.String(), arg) || !strings.Contains(stderr.String(), "Usage:") {
			t.Fatalf("%s: stderr must name the argument and print the usage: %q", arg, stderr.String())
		}
	}
}

func TestRunMainAsHelperProcess(t *testing.T) {
	args := os.Getenv("QAYABA_HELPER_ARGS")
	if args == "" {
		t.Skip("runs only as the subprocess of TestInfoFlagsExitZeroWithoutATerminal")
	}
	os.Args = append([]string{"qayaba"}, strings.Fields(args)...)
	main()
	os.Exit(0)
}
