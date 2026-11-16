package agent

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"fleet-agent/collectors"
)

// Runner runs collectors through the user's login shell, one at a time per kind:
// a request for a collector that is already running waits for that run.
type Runner struct {
	// Shell is the login shell; scripts run as `$Shell -lc 'exec bash -s'` so PATH
	// matches an ssh session (omarchy-update, yay and friends are found).
	Shell string
	// Script returns a collector's script; collectors.Script by default.
	Script func(collectors.Kind) (string, bool)

	mu       sync.Mutex
	inflight map[collectors.Kind]*call
}

type call struct {
	done chan struct{}
	r    Report
}

const maxOut = 4 << 20

// NewRunner uses the login shell from $SHELL or /etc/passwd.
func NewRunner() *Runner {
	return &Runner{Shell: loginShell(), Script: collectors.Script}
}

// Run runs the collector, or joins the run already in progress.
func (r *Runner) Run(ctx context.Context, k collectors.Kind) Report {
	r.mu.Lock()
	if r.inflight == nil {
		r.inflight = map[collectors.Kind]*call{}
	}
	if c, ok := r.inflight[k]; ok {
		r.mu.Unlock()
		select {
		case <-c.done:
			return c.r
		case <-ctx.Done():
			return Report{Kind: k, At: time.Now().UnixMilli(), Code: -1, Err: ctx.Err().Error()}
		}
	}
	c := &call{done: make(chan struct{})}
	r.inflight[k] = c
	r.mu.Unlock()

	c.r = r.run(ctx, k)

	r.mu.Lock()
	delete(r.inflight, k)
	r.mu.Unlock()
	close(c.done)
	return c.r
}

func (r *Runner) run(ctx context.Context, k collectors.Kind) Report {
	start := time.Now()
	rep := Report{Kind: k, At: start.UnixMilli()}
	script, ok := r.Script(k)
	if !ok {
		rep.Code = -1
		rep.Err = "unknown collector " + string(k)
		return rep
	}
	ctx, cancel := context.WithTimeout(ctx, collectors.Timeout(k))
	defer cancel()

	shell := r.Shell
	if shell == "" {
		shell = "/bin/bash"
	}
	cmd := exec.CommandContext(ctx, shell, "-lc", "exec bash -s")
	cmd.Stdin = strings.NewReader(script)
	var stdout, stderr limitedBuffer
	stdout.max, stderr.max = maxOut, 64<<10
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	cmd.Dir, _ = os.UserHomeDir()
	// Kill the whole process group on timeout, not just the shell.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second

	err := cmd.Run()
	rep.Ms = time.Since(start).Milliseconds()
	rep.Out = stdout.String()
	rep.Err = tail(stderr.String(), 2000)
	var exit *exec.ExitError
	switch {
	case ctx.Err() == context.DeadlineExceeded:
		rep.Code = -1
		rep.TimedOut = true
		rep.Err = "timed out"
	case errors.As(err, &exit):
		rep.Code = exit.ExitCode()
	case err != nil:
		rep.Code = -1
		rep.Err = err.Error()
	}
	return rep
}

func tail(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

type limitedBuffer struct {
	bytes.Buffer
	max int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.Len(); room > 0 {
		if len(p) > room {
			b.Buffer.Write(p[:room])
		} else {
			b.Buffer.Write(p)
		}
	}
	return len(p), nil
}

// loginShell is $SHELL (systemd sets it for user services), else the user's
// entry in /etc/passwd, else bash.
func loginShell() string {
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	if f, err := os.Open("/etc/passwd"); err == nil {
		defer f.Close()
		uid := os.Getuid()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			p := strings.Split(sc.Text(), ":")
			if len(p) == 7 && p[2] == strconv.Itoa(uid) && p[6] != "" {
				return p[6]
			}
		}
	}
	return "/bin/bash"
}
