/* Command qayaba is the installable terminal client for the Qayaba control plane (the Go/Bubble Tea channel). It connects to a running orchestrator and launches and watches QA runs live. */
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"runtime/debug"
	"strings"
	"time"

	"github.com/ArielFalcon/qayaba/internal/api"
	"github.com/ArielFalcon/qayaba/internal/contract"
	"github.com/ArielFalcon/qayaba/internal/store"
	"github.com/ArielFalcon/qayaba/internal/ui"
	tea "github.com/charmbracelet/bubbletea"
)

// version is set at build time with -ldflags "-X main.version=<v>"; otherwise it is the module
// version a `go install` records, or "dev".
var version = ""

func main() {
	if printInfo(os.Args[1:], os.Stdout) {
		return
	}
	args := os.Args[1:]
	if firstArg(args) == "agent" {
		if err := runCommand(args); err != nil {
			fmt.Fprintln(os.Stderr, "qayaba:", err)
			os.Exit(1)
		}
		return
	}
	if len(args) > 0 {
		fmt.Fprintf(os.Stderr, "qayaba: unknown argument %q\n\n%s", args[0], usage())
		os.Exit(2)
	}

	p := tea.NewProgram(ui.New(), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "qayaba:", err)
		os.Exit(1)
	}
}

// printInfo answers --help/-h and --version anywhere in args, without a terminal and before any
// network call or UI; it reports whether it handled one.
func printInfo(args []string, w io.Writer) bool {
	for _, arg := range args {
		switch arg {
		case "--help", "-h":
			fmt.Fprint(w, usage())
			return true
		case "--version":
			fmt.Fprintf(w, "qayaba %s\n", versionString())
			return true
		}
	}
	return false
}

func usage() string {
	return `qayaba — terminal client for the Qayaba QA control plane

Usage:
  qayaba                                       open the interactive UI (needs a terminal)
  qayaba agent [status]                        print the agent runtime configuration
  qayaba agent models [provider]               list a provider's models
  qayaba --help | --version

Environment:
  QA_HOST       orchestrator host (default ` + api.DefaultHost + `)
  QA_API_TOKEN  machine token (otherwise the login saved for QA_HOST)
`
}

func versionString() string {
	if version != "" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "dev"
}

func runCommand(args []string) error {
	client := api.New(defaultHostURL(), defaultToken())
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	return runAgentCommand(ctx, client, args[1:])
}

func runAgentCommand(ctx context.Context, client *api.Client, args []string) error {
	switch firstArg(args) {
	case "", "status":
		cfg, err := client.GetAgentConfig(ctx)
		if err != nil {
			return err
		}
		printAgentConfig(cfg)
		return nil
	case "models":
		provider := "opencode"
		if len(args) > 1 {
			provider = args[1]
		}
		models, err := client.ListAgentModels(ctx, provider)
		if err != nil {
			return err
		}
		for _, model := range models.Models {
			fmt.Printf("%s\t%s\n", models.Provider, model.Id)
		}
		return nil
	default:
		return fmt.Errorf("usage: qayaba agent [status|models [provider]]")
	}
}

func printAgentConfig(cfg contract.PublicAgentConfig) {
	fmt.Printf("keys: opencode=%t\n", cfg.Keys.Opencode)
	for _, role := range []struct {
		name string
		a    contract.RoleAssignment
	}{
		{"primary", cfg.Assignments.Primary},
		{"reviewer", cfg.Assignments.Reviewer},
		{"chat", cfg.Assignments.Chat},
	} {
		fmt.Printf("%s: %s %s\n", role.name, role.a.Provider, role.a.Model)
	}
	if !cfg.Validation.Ok {
		fmt.Println("errors:")
		for _, err := range cfg.Validation.Errors {
			fmt.Println("  - " + err)
		}
	}
}

func defaultHostURL() string {
	host := os.Getenv("QA_HOST")
	if host == "" {
		host = api.DefaultHost
	}
	if strings.HasPrefix(host, "http://") || strings.HasPrefix(host, "https://") {
		return strings.TrimRight(host, "/")
	}
	return "http://" + host
}

func defaultToken() string {
	if token := os.Getenv("QA_API_TOKEN"); token != "" {
		return token
	}
	host := os.Getenv("QA_HOST")
	if host == "" {
		host = api.DefaultHost
	}
	return store.LoadToken(host)
}

func firstArg(args []string) string {
	if len(args) == 0 {
		return ""
	}
	return args[0]
}
