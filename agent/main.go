// fleet-agent reports this machine to the Fleet panel: it runs a fixed set of
// read-only collectors and pushes their output over one WebSocket that it opens
// itself. It listens on no port and accepts no commands. Its `approve` command
// is how the machine's owner lets the panel run a custom script here.
// See docs/SERVER_AGENT.md.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"

	"fleet-agent/agent"
	"fleet-agent/collectors"
)

// Set at build time by build.sh.
var (
	version = "0.3.0-beta.1"
	build   = "dev"
)

const usage = `fleet-agent reports this machine to the Fleet panel.

  fleet-agent run              connect to the panel and report (what the service runs)
  fleet-agent install          install ~/.local/bin/fleet-agent and fleet-agent.service
                               (the panel writes ~/.config/fleet-agent/ first)
  fleet-agent uninstall        stop and remove the service, config, token and binary
  fleet-agent collect <kind>   run one collector and print its output: probe, details, updates, index
  fleet-agent approve <sha256> let the panel run a custom script here: shows it, then asks
  fleet-agent approved         list the scripts approved on this machine
  fleet-agent unapprove <hash> take an approval back (the first 8+ characters of its hash)
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
	case "approve":
		if len(os.Args) != 3 {
			fail(fmt.Errorf("approve needs the script's sha256: copy the whole command from the panel"))
		}
		approve(strings.ToLower(strings.TrimSpace(os.Args[2])))
	case "approved":
		file, err := agent.ApprovedFile()
		if err != nil {
			fail(err)
		}
		list, err := agent.ReadApproved(file)
		if err != nil {
			fail(err)
		}
		if len(list) == 0 {
			fmt.Println("No scripts approved on this machine.")
		}
		for _, a := range list {
			fmt.Printf("%s  %s\n", a.Hash[:12], a.Name)
		}
	case "unapprove":
		if len(os.Args) != 3 {
			fail(fmt.Errorf("unapprove needs the script's hash (see fleet-agent approved)"))
		}
		file, err := agent.ApprovedFile()
		if err != nil {
			fail(err)
		}
		n, err := agent.Unapprove(file, os.Args[2])
		if err != nil {
			fail(err)
		}
		fmt.Printf("Removed %d approval(s). The panel can no longer run that script here.\n", n)
	case "version", "--version", "-v":
		fmt.Printf("fleet-agent %s (build %s, %s/%s)\n", version, build, runtime.GOOS, runtime.GOARCH)
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}

// approve asks on the terminal itself, so piping something in can't answer for the person.
func approve(hash string) {
	file, err := agent.ApprovedFile()
	if err != nil {
		fail(err)
	}
	manual := fmt.Sprintf("Without fleet-agent, check the script in the panel and run: mkdir -p ~/.config/fleet && echo %s >> ~/.config/fleet/approved-scripts", hash)
	dir, err := agent.ConfigDir()
	if err != nil {
		fail(err)
	}
	cfg, err := agent.LoadConfig(dir)
	if err != nil {
		fail(fmt.Errorf("%s: %w\n%s", dir, err, manual))
	}
	tty, err := os.Open("/dev/tty")
	if err != nil {
		fail(fmt.Errorf("approving needs a terminal to ask you: %w", err))
	}
	defer tty.Close()
	if err := agent.Approve(context.Background(), cfg, file, hash, tty, os.Stdout); err != nil {
		if agent.ValidHash(hash) {
			err = fmt.Errorf("%w\n%s", err, manual)
		}
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "fleet-agent:", err)
	os.Exit(1)
}
