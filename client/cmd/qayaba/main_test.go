package main

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/ArielFalcon/qayaba/internal/api"
)

func TestParseRuntimeFlags(t *testing.T) {
	flags, rest := parseRuntimeFlags([]string{"--opencode", "agent", "status"})
	if flags.provider != "opencode" || flags.dual || len(rest) != 2 || rest[0] != "agent" {
		t.Fatalf("opencode parse: flags=%+v rest=%v", flags, rest)
	}

	flags, rest = parseRuntimeFlags([]string{"--dual", "agent", "set", "--codex"})
	if flags.provider != "codex" || flags.dual || len(rest) != 2 || rest[0] != "agent" || rest[1] != "set" {
		t.Fatalf("last runtime flag should win: flags=%+v rest=%v", flags, rest)
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
	if !printInfo([]string{"agent", "set", "--help"}, &out) || out.Len() == 0 {
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

func TestRunMainAsHelperProcess(t *testing.T) {
	args := os.Getenv("QAYABA_HELPER_ARGS")
	if args == "" {
		t.Skip("runs only as the subprocess of TestInfoFlagsExitZeroWithoutATerminal")
	}
	os.Args = append([]string{"qayaba"}, strings.Fields(args)...)
	main()
	os.Exit(0)
}
