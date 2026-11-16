package agent

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
)

// Unit is the systemd user service the agent runs as.
const Unit = "fleet-agent.service"

const unitFile = `[Unit]
Description=Fleet agent: reports this machine to the Fleet panel
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%h/.local/bin/fleet-agent run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`

func unitPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "systemd", "user", Unit), nil
}

// BinPath is where the agent lives: ~/.local/bin/fleet-agent.
func BinPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "bin", "fleet-agent"), nil
}

func run(out io.Writer, name string, args ...string) error {
	fmt.Fprintf(out, "  $ %s %s\n", name, strings.Join(args, " "))
	c := exec.Command(name, args...)
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, out, out
	return c.Run()
}

// Install checks the config the panel wrote, puts this binary at ~/.local/bin/fleet-agent,
// writes and starts fleet-agent.service, and turns on linger so it runs without a login.
func Install(out io.Writer) error {
	dir, err := ConfigDir()
	if err != nil {
		return err
	}
	cfg, err := LoadConfig(dir)
	if err != nil {
		return fmt.Errorf("the panel's config in %s isn't usable: %w", dir, err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}

	bin, err := BinPath()
	if err != nil {
		return err
	}
	if err := copySelf(bin); err != nil {
		return fmt.Errorf("installing %s: %w", bin, err)
	}
	fmt.Fprintf(out, "fleet-agent installed at %s for %s\n", bin, cfg.ID)

	up, err := unitPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(up), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(up, []byte(unitFile), 0o644); err != nil {
		return err
	}
	if err := run(out, "systemctl", "--user", "daemon-reload"); err != nil {
		return err
	}
	if err := run(out, "systemctl", "--user", "enable", Unit); err != nil {
		return err
	}
	if err := run(out, "systemctl", "--user", "restart", Unit); err != nil {
		return err
	}

	if lingering() {
		fmt.Fprintln(out, "linger is on: the agent runs without anyone logged in")
	} else {
		u, _ := user.Current()
		name := os.Getenv("USER")
		if u != nil {
			name = u.Username
		}
		fmt.Fprintln(out, "turning on linger so the agent runs without anyone logged in (sudo may ask for your password):")
		if err := run(out, "sudo", "loginctl", "enable-linger", name); err != nil {
			fmt.Fprintf(out, "  ! couldn't turn on linger (%v): the agent only runs while %s is logged in.\n    Fix it later with: sudo loginctl enable-linger %s\n", err, name, name)
		}
	}
	_ = run(out, "systemctl", "--user", "--no-pager", "--lines=0", "status", Unit)
	return nil
}

// Uninstall stops and removes the service, the config (token included) and the binary.
func Uninstall(out io.Writer) error {
	_ = run(out, "systemctl", "--user", "disable", "--now", Unit)
	var errs []error
	if up, err := unitPath(); err == nil {
		if err := os.Remove(up); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	_ = run(out, "systemctl", "--user", "daemon-reload")
	if dir, err := ConfigDir(); err == nil {
		if err := os.RemoveAll(dir); err != nil {
			errs = append(errs, err)
		}
	}
	if bin, err := BinPath(); err == nil {
		if err := os.Remove(bin); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	if len(errs) == 0 {
		fmt.Fprintln(out, "fleet-agent removed: service, config, token and binary")
	}
	return errors.Join(errs...)
}

func lingering() bool {
	u, err := user.Current()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join("/var/lib/systemd/linger", u.Username))
	return err == nil
}

// copySelf puts the running executable at dst atomically (nothing to do if it is dst).
func copySelf(dst string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	if d, err := filepath.EvalSymlinks(dst); err == nil && d == exe {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	src, err := os.Open(exe)
	if err != nil {
		return err
	}
	defer src.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".fleet-agent-install-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, src); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}
