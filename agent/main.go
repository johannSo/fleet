// fleet-agent reports this machine to the Fleet panel: it runs a fixed set of
// read-only collectors and pushes their output over one WebSocket that it opens
// itself. It listens on no port and accepts no commands. See docs/SERVER_AGENT.md.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"fleet-agent/agent"
	"fleet-agent/collectors"
)

// Set at build time by build.sh.
var (
	version = "0.1.0"
	build   = "dev"
)

const usage = `fleet-agent reports this machine to the Fleet panel.

  fleet-agent run              connect to the panel and report (what the service runs)
  fleet-agent install          install ~/.local/bin/fleet-agent and fleet-agent.service
                               (the panel writes ~/.config/fleet-agent/ first)
  fleet-agent uninstall        stop and remove the service, config, token and binary
  fleet-agent collect <kind>   run one collector and print its output: probe, details, updates, index
  fleet-agent version
`

func main() {
	cmd := "run"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "run":
		dir, err := agent.ConfigDir()
		if err != nil {
			fail(err)
		}
		cfg, err := agent.LoadConfig(dir)
		if err != nil {
			fail(fmt.Errorf("%s: %w (reinstall the agent from the panel)", dir, err))
		}
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		a := &agent.Agent{Cfg: cfg, Version: version, Build: build}
		_ = a.Run(ctx)
	case "install":
		if err := agent.Install(os.Stdout); err != nil {
			fail(err)
		}
	case "uninstall":
		if err := agent.Uninstall(os.Stdout); err != nil {
			fail(err)
		}
	case "collect":
		if len(os.Args) < 3 || !collectors.Valid(collectors.Kind(os.Args[2])) {
			fail(fmt.Errorf("collect needs one of: probe, details, updates, index"))
		}
		r := agent.NewRunner().Run(context.Background(), collectors.Kind(os.Args[2]))
		fmt.Print(r.Out)
		if r.Err != "" {
			fmt.Fprintln(os.Stderr, r.Err)
		}
		fmt.Fprintf(os.Stderr, "exit %d in %d ms\n", r.Code, r.Ms)
		if r.Code != 0 {
			os.Exit(1)
		}
	case "version", "--version", "-v":
		fmt.Printf("fleet-agent %s (build %s, %s/%s)\n", version, build, runtime.GOOS, runtime.GOARCH)
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "fleet-agent:", err)
	os.Exit(1)
}
