package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

const maxBinary = 200 << 20

// selfUpdate downloads a new binary from the panel, checks its sha256, replaces
// this executable atomically and re-execs it. A build that failed is not retried
// for an hour.
func (a *Agent) selfUpdate(ctx context.Context, m panelMsg) {
	if m.Build == "" || m.Build == a.Build {
		return
	}
	a.mu.Lock()
	if a.updating || time.Since(a.failed[m.Build]) < time.Hour {
		a.mu.Unlock()
		return
	}
	a.updating = true
	base, conn := a.base, a.conn
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.updating = false
		a.mu.Unlock()
	}()

	a.Log.Printf("updating to build %s", m.Build)
	exe, err := a.download(ctx, base, m)
	if err == nil {
		a.Log.Printf("updated to build %s, restarting", m.Build)
		if conn != nil {
			conn.Close(websocket.StatusNormalClosure, "restarting after an update")
		}
		err = a.Exec(exe)
	}
	if err != nil {
		a.Log.Printf("update to build %s failed: %v", m.Build, err)
		a.mu.Lock()
		a.failed[m.Build] = time.Now()
		a.mu.Unlock()
		a.send(ctx, updateFailedMsg{T: "update-failed", Build: m.Build, Error: err.Error()})
	}
}

// download fetches the binary into place and returns the executable's path.
func (a *Agent) download(ctx context.Context, base string, m panelMsg) (string, error) {
	if base == "" {
		return "", errors.New("not connected")
	}
	want := strings.ToLower(strings.TrimSpace(m.SHA256))
	if len(want) != 64 {
		return "", errors.New("the panel sent no sha256")
	}
	b, err := url.Parse(base + "/")
	if err != nil {
		return "", err
	}
	u, err := b.Parse(m.URL)
	if err != nil {
		return "", err
	}
	// The token only ever goes to the panel it came from.
	if u.Scheme != "https" || u.Host != b.Host {
		return "", fmt.Errorf("refusing to download from %s", u.Redacted())
	}

	exe := a.exePath
	if exe == "" {
		if exe, err = os.Executable(); err != nil {
			return "", err
		}
		if exe, err = filepath.EvalSymlinks(exe); err != nil {
			return "", err
		}
	}

	dctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(dctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+a.Cfg.Token)
	resp, err := a.httpClient().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download: HTTP %d", resp.StatusCode)
	}

	tmp, err := os.CreateTemp(filepath.Dir(exe), ".fleet-agent-update-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name()) // no-op once renamed
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, maxBinary+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	if n > maxBinary {
		return "", errors.New("download too large")
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return "", fmt.Errorf("sha256 mismatch: got %s, want %s", got, want)
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), exe); err != nil {
		return "", err
	}
	return exe, nil
}

func execSelf(path string) error {
	return syscall.Exec(path, os.Args, os.Environ())
}
