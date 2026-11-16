package agent

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"fleet-agent/collectors"
)

// fakePanel is a TLS server that speaks the panel's side of /ws/agent.
type fakePanel struct {
	t   *testing.T
	srv *httptest.Server

	mu     sync.Mutex
	reject int // answer this many upgrades with 503 first
	status int // answer every upgrade with this status
	hellos int

	// onConn runs for every accepted connection after its hello; msgs gets everything else.
	onConn func(c *websocket.Conn)
	msgs   chan map[string]any
	extra  http.Handler
}

func newPanel(t *testing.T) *fakePanel {
	p := &fakePanel{t: t, msgs: make(chan map[string]any, 1000)}
	p.srv = httptest.NewTLSServer(http.HandlerFunc(p.serve))
	t.Cleanup(p.srv.Close)
	return p
}

func (p *fakePanel) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/ws/agent" {
		if p.extra != nil {
			p.extra.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
		return
	}
	p.mu.Lock()
	status := p.status
	if p.reject > 0 {
		p.reject--
		status = http.StatusServiceUnavailable
	}
	p.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer tok" {
		status = http.StatusUnauthorized
	}
	if status != 0 {
		http.Error(w, "no", status)
		return
	}
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
	ctx := r.Context()
	var hello map[string]any
	if err := wsjson.Read(ctx, c, &hello); err != nil || hello["t"] != "hello" {
		p.t.Errorf("first message isn't hello: %v %v", hello, err)
		return
	}
	p.mu.Lock()
	p.hellos++
	p.mu.Unlock()
	if p.onConn != nil {
		p.onConn(c)
	}
	for {
		var m map[string]any
		if err := wsjson.Read(ctx, c, &m); err != nil {
			return
		}
		p.msgs <- m
	}
}

func (p *fakePanel) helloCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.hellos
}

// next returns the next message of type t, skipping others.
func (p *fakePanel) next(t string, within time.Duration) map[string]any {
	p.t.Helper()
	deadline := time.After(within)
	for {
		select {
		case m := <-p.msgs:
			if m["t"] == t {
				return m
			}
		case <-deadline:
			p.t.Fatalf("no %q message within %v", t, within)
			return nil
		}
	}
}

func testAgent(p *fakePanel) *Agent {
	pool := x509.NewCertPool()
	pool.AddCert(p.srv.Certificate())
	return &Agent{
		Cfg:            &Config{ID: "t1", URLs: []string{p.srv.URL}, Token: "tok", CA: pool},
		Version:        "test",
		Build:          "b1",
		MinBackoff:     20 * time.Millisecond,
		MaxBackoff:     200 * time.Millisecond,
		DefaultProbe:   30 * time.Millisecond,
		PingEvery:      time.Hour,
		BackfillWindow: time.Minute,
		Runner: &Runner{Shell: "/bin/sh", Script: func(k collectors.Kind) (string, bool) {
			return "echo hostname=test\necho kind=" + string(k) + "\n", true
		}},
	}
}

func runAgent(t *testing.T, a *Agent) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		a.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
}

func waitFor(t *testing.T, what string, within time.Duration, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestReportsProbes(t *testing.T) {
	p := newPanel(t)
	runAgent(t, testAgent(p))
	m := p.next("report", 5*time.Second)
	if m["kind"] != "probe" || !strings.Contains(m["out"].(string), "hostname=test") || m["code"].(float64) != 0 {
		t.Fatalf("unexpected report %v", m)
	}
}

func TestReconnects(t *testing.T) {
	p := newPanel(t)
	p.onConn = func(c *websocket.Conn) { c.Close(websocket.StatusGoingAway, "bye") }
	runAgent(t, testAgent(p))
	waitFor(t, "three connections", 5*time.Second, func() bool { return p.helloCount() >= 3 })
}

func TestTriesTheNextURL(t *testing.T) {
	p := newPanel(t)
	a := testAgent(p)
	// Nothing listens on port 1; the second address is the panel.
	a.Cfg.URLs = []string{"https://127.0.0.1:1", p.srv.URL}
	runAgent(t, a)
	waitFor(t, "a connection through the second URL", 5*time.Second, func() bool { return p.helloCount() >= 1 })
}

func TestBackfillsProbesTakenWhileDisconnected(t *testing.T) {
	p := newPanel(t)
	p.reject = 4
	runAgent(t, testAgent(p))
	m := p.next("backfill", 10*time.Second)
	reports := m["reports"].([]any)
	if len(reports) < 2 {
		t.Fatalf("expected several backfilled probes, got %d", len(reports))
	}
	var last float64
	for _, r := range reports {
		r := r.(map[string]any)
		if r["kind"] != "probe" {
			t.Fatalf("backfilled a %v", r["kind"])
		}
		if at := r["at"].(float64); at < last {
			t.Fatalf("backfill out of order")
		} else {
			last = at
		}
	}
	// After the backfill, live reports follow.
	p.next("report", 5*time.Second)
}

func TestBackfillWindow(t *testing.T) {
	b := Backfill{Window: 100, Max: 3}
	for i := int64(0); i < 10; i++ {
		b.Add(Report{At: i * 40})
	}
	got := b.Take()
	if len(got) != 3 || got[0].At != 280 || got[2].At != 360 {
		t.Fatalf("kept %v", got)
	}
	if b.Len() != 0 {
		t.Fatal("Take didn't empty the buffer")
	}
}

func TestAnswersCollectAndConfig(t *testing.T) {
	p := newPanel(t)
	p.onConn = func(c *websocket.Conn) {
		ctx := context.Background()
		wsjson.Write(ctx, c, map[string]any{"t": "config", "probeMs": 1000})
		wsjson.Write(ctx, c, map[string]any{"t": "collect", "req": "r1", "kind": "details"})
		wsjson.Write(ctx, c, map[string]any{"t": "collect", "req": "r2", "kind": "rm -rf"})
	}
	runAgent(t, testAgent(p))
	got := map[string]map[string]any{}
	for len(got) < 2 {
		m := p.next("reply", 5*time.Second)
		got[m["req"].(string)] = m
	}
	if r := got["r1"]; r["kind"] != "details" || !strings.Contains(r["out"].(string), "kind=details") {
		t.Fatalf("bad reply %v", r)
	}
	if r := got["r2"]; r["code"].(float64) != -1 || r["out"] != "" {
		t.Fatalf("an unknown collector ran: %v", r)
	}
}

func TestRejectedToken(t *testing.T) {
	p := newPanel(t)
	p.status = http.StatusUnauthorized
	a := testAgent(p)
	a.defaults()
	if _, err := a.session(context.Background(), p.srv.URL); err != errAuth {
		t.Fatalf("got %v, want errAuth", err)
	}
}

func TestRevokedWhileConnected(t *testing.T) {
	p := newPanel(t)
	p.onConn = func(c *websocket.Conn) { c.Close(4001, "token revoked") }
	a := testAgent(p)
	a.defaults()
	connected, err := a.session(context.Background(), p.srv.URL)
	if !connected || err != errAuth {
		t.Fatalf("got %v %v, want connected and errAuth", connected, err)
	}
}

func TestUntrustedCertificate(t *testing.T) {
	p := newPanel(t)
	a := testAgent(p)
	a.Cfg.CA = x509.NewCertPool() // not the panel's CA
	a.defaults()
	if connected, err := a.session(context.Background(), p.srv.URL); connected || err == nil {
		t.Fatal("connected to a panel whose certificate isn't signed by the pinned CA")
	}
}

func TestSelfUpdate(t *testing.T) {
	p := newPanel(t)
	payload := []byte("#!/bin/sh\necho new\n")
	sum := sha256.Sum256(payload)
	p.extra = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/bin/amd64" || r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		w.Write(payload)
	})
	a := testAgent(p)
	a.defaults()
	a.exePath = filepath.Join(t.TempDir(), "fleet-agent")
	os.WriteFile(a.exePath, []byte("old"), 0o755)

	bad := panelMsg{T: "update", Build: "b2", URL: "/agent/bin/amd64", SHA256: strings.Repeat("0", 64)}
	if _, err := a.download(context.Background(), p.srv.URL, bad); err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("a wrong checksum was accepted: %v", err)
	}
	if b, _ := os.ReadFile(a.exePath); string(b) != "old" {
		t.Fatal("a failed update changed the binary")
	}
	foreign := panelMsg{Build: "b2", URL: "https://example.com/agent/bin/amd64", SHA256: hex.EncodeToString(sum[:])}
	if _, err := a.download(context.Background(), p.srv.URL, foreign); err == nil {
		t.Fatal("downloaded from another host with the machine's token")
	}

	var execd string
	a.base = p.srv.URL // as if connected
	a.Exec = func(path string) error { execd = path; return nil }
	a.selfUpdate(context.Background(), panelMsg{T: "update", Build: "b2", URL: "/agent/bin/amd64", SHA256: hex.EncodeToString(sum[:])})
	if b, _ := os.ReadFile(a.exePath); string(b) != string(payload) {
		t.Fatal("binary not replaced")
	}
	if execd != a.exePath {
		t.Fatalf("didn't re-exec the new binary (%q)", execd)
	}
	if st, _ := os.Stat(a.exePath); st.Mode().Perm() != 0o755 {
		t.Fatalf("mode %v", st.Mode())
	}
}

// The collectors' real output carries the markers the panel's parsers look for.
func TestCollectorsOnThisMachine(t *testing.T) {
	r := NewRunner()
	want := map[collectors.Kind][]string{
		collectors.Probe:   {"hostname=", "kernel=", "cpustat=cpu ", "mem_MemTotal=", "pkg="},
		collectors.Details: {"##procs", "##units", "##docker", "##listen", "##end"},
		collectors.Index:   {"hostname=", "arch=", "pkg=", "end=1"},
		collectors.Updates: {"done=1"},
	}
	for _, k := range collectors.Kinds {
		if k == collectors.Updates && testing.Short() {
			continue
		}
		rep := r.Run(context.Background(), k)
		if rep.Code != 0 {
			t.Errorf("%s exited %d: %s", k, rep.Code, rep.Err)
		}
		for _, w := range want[k] {
			if !strings.Contains(rep.Out, w) {
				t.Errorf("%s output lacks %q", k, w)
			}
		}
		if os.Getenv("FLEET_CAPTURE") != "" {
			b, _ := json.Marshal(rep)
			os.WriteFile(filepath.Join(os.Getenv("FLEET_CAPTURE"), string(k)+".json"), b, 0o644)
		}
	}
}

func TestRunnerTimesOutAndJoins(t *testing.T) {
	r := &Runner{Shell: "/bin/sh", Script: func(collectors.Kind) (string, bool) { return "sleep 30\n", true }}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	var wg sync.WaitGroup
	reps := make([]Report, 2)
	for i := range reps {
		wg.Add(1)
		go func() {
			defer wg.Done()
			reps[i] = r.Run(ctx, collectors.Probe)
		}()
	}
	wg.Wait()
	if time.Since(start) > 5*time.Second {
		t.Fatal("sleep wasn't killed")
	}
	for _, rep := range reps {
		if rep.Code != -1 {
			t.Fatalf("got code %d", rep.Code)
		}
	}
}
