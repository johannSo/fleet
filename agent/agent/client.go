package agent

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"fleet-agent/collectors"
)

// Agent keeps one WebSocket to the panel, pushes probe reports on a timer and
// answers the panel's collect requests. It accepts no other commands.
type Agent struct {
	Cfg     *Config
	Version string
	Build   string
	Runner  *Runner
	Log     *log.Logger

	// Timings; zero values get the defaults in Run.
	MinBackoff   time.Duration // 1 s
	MaxBackoff   time.Duration // 60 s
	DefaultProbe time.Duration // 30 s, until the panel says otherwise and whenever disconnected
	UpdatesEvery time.Duration // 15 min
	PingEvery    time.Duration // 30 s
	// BackfillWindow is how far back probes taken while disconnected are kept (10 min).
	BackfillWindow time.Duration

	// Exec replaces the process after a self-update; syscall.Exec by default.
	Exec func(path string) error
	// exePath overrides os.Executable for self-updates (tests).
	exePath string

	backfill   Backfill
	probeEvery chan time.Duration

	mu        sync.Mutex
	conn      *websocket.Conn
	base      string
	connected time.Time
	failed    map[string]time.Time // builds whose update failed, and when
	updating  bool
}

var errAuth = errors.New("the panel rejected this machine's token (removed, or a new one was made); reinstall the agent from the panel")

func (a *Agent) defaults() {
	if a.MinBackoff == 0 {
		a.MinBackoff = time.Second
	}
	if a.MaxBackoff == 0 {
		a.MaxBackoff = 60 * time.Second
	}
	if a.DefaultProbe == 0 {
		a.DefaultProbe = 30 * time.Second
	}
	if a.UpdatesEvery == 0 {
		a.UpdatesEvery = 15 * time.Minute
	}
	if a.PingEvery == 0 {
		a.PingEvery = 30 * time.Second
	}
	if a.BackfillWindow == 0 {
		a.BackfillWindow = 10 * time.Minute
	}
	if a.Log == nil {
		a.Log = log.New(os.Stderr, "", 0)
	}
	if a.Runner == nil {
		a.Runner = NewRunner()
	}
	if a.Exec == nil {
		a.Exec = execSelf
	}
	a.backfill.Window = a.BackfillWindow.Milliseconds()
	a.backfill.Max = 1000
	a.probeEvery = make(chan time.Duration, 1)
	a.failed = map[string]time.Time{}
}

// Run blocks until ctx is done.
func (a *Agent) Run(ctx context.Context) error {
	a.defaults()
	a.Log.Printf("fleet-agent %s (build %s) for %s, panel at %s", a.Version, a.Build, a.Cfg.ID, strings.Join(a.Cfg.URLs, ", "))
	go a.probeLoop(ctx)
	go a.updatesLoop(ctx)

	backoff := a.MinBackoff
	var lastErr string
	for ctx.Err() == nil {
		connected := false
		var err error
		for _, u := range a.Cfg.URLs {
			connected, err = a.session(ctx, u)
			if connected || ctx.Err() != nil {
				break
			}
			if msg := fmt.Sprintf("%s: %v", u, err); msg != lastErr {
				a.Log.Printf("can't reach the panel at %s", msg)
				lastErr = msg
			}
		}
		if connected {
			backoff = a.MinBackoff
			lastErr = ""
		}
		wait := backoff
		if errors.Is(err, errAuth) {
			wait = a.MaxBackoff
		}
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
		if !connected {
			backoff = min(backoff*2, a.MaxBackoff)
		}
	}
	return ctx.Err()
}

func (a *Agent) httpClient() *http.Client {
	return panelClient(a.Cfg.CA)
}

// panelClient talks to the panel only: it trusts the panel's own CA, never the
// system store, and ignores proxy settings.
func panelClient(ca *x509.CertPool) *http.Client {
	return &http.Client{Transport: &http.Transport{
		TLSClientConfig:     &tls.Config{RootCAs: ca, MinVersion: tls.VersionTLS12},
		Proxy:               nil,
		TLSHandshakeTimeout: 10 * time.Second,
	}}
}

func wsURL(base string) string {
	return "wss://" + strings.TrimPrefix(base, "https://") + "/ws/agent"
}

// session connects to one panel address and serves it until the connection ends.
// connected reports whether the handshake got through.
func (a *Agent) session(ctx context.Context, base string) (connected bool, err error) {
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	conn, resp, err := websocket.Dial(dctx, wsURL(base), &websocket.DialOptions{
		HTTPClient: a.httpClient(),
		HTTPHeader: http.Header{"Authorization": {"Bearer " + a.Cfg.Token}},
	})
	cancel()
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			return false, errAuth
		}
		return false, err
	}
	conn.SetReadLimit(1 << 20)
	sctx, stop := context.WithCancel(ctx)
	defer stop()

	host, _ := os.Hostname()
	if err := a.write(sctx, conn, helloMsg{T: "hello", ID: a.Cfg.ID, Version: a.Version, Build: a.Build, Arch: runtime.GOARCH, Hostname: host, Now: time.Now().UnixMilli()}); err != nil {
		conn.CloseNow()
		return false, err
	}
	a.mu.Lock()
	a.conn, a.base, a.connected = conn, base, time.Now()
	a.mu.Unlock()
	a.Log.Printf("connected to %s", base)
	defer func() {
		a.mu.Lock()
		if a.conn == conn {
			a.conn, a.base = nil, ""
		}
		a.mu.Unlock()
		a.setProbeEvery(a.DefaultProbe)
		conn.CloseNow()
	}()

	if reports := a.backfill.Take(); len(reports) > 0 {
		if err := a.write(sctx, conn, backfillMsg{T: "backfill", Reports: reports}); err != nil {
			for _, r := range reports {
				a.backfill.Add(r)
			}
			return true, err
		}
	}

	go func() {
		t := time.NewTicker(a.PingEvery)
		defer t.Stop()
		for {
			select {
			case <-sctx.Done():
				return
			case <-t.C:
				pctx, c := context.WithTimeout(sctx, 15*time.Second)
				err := conn.Ping(pctx)
				c()
				if err != nil {
					conn.Close(websocket.StatusGoingAway, "no pong")
					return
				}
			}
		}
	}()

	for {
		var m panelMsg
		if err := wsjson.Read(sctx, conn, &m); err != nil {
			if s := websocket.CloseStatus(err); s != -1 {
				var ce websocket.CloseError
				errors.As(err, &ce)
				a.Log.Printf("connection closed (%d %s)", s, ce.Reason)
				if s == 4001 {
					return true, errAuth
				}
			} else if ctx.Err() == nil {
				a.Log.Printf("connection to %s lost: %v", base, err)
			}
			return true, err
		}
		a.handle(sctx, conn, m)
	}
}

func (a *Agent) handle(ctx context.Context, conn *websocket.Conn, m panelMsg) {
	switch m.T {
	case "config":
		if m.ProbeMs > 0 {
			d := time.Duration(m.ProbeMs) * time.Millisecond
			a.setProbeEvery(max(time.Second, min(d, 10*time.Minute)))
		}
	case "collect":
		go func() {
			var r Report
			if collectors.Valid(m.Kind) {
				r = a.Runner.Run(ctx, m.Kind)
			} else {
				r = Report{Kind: m.Kind, At: time.Now().UnixMilli(), Code: -1, Err: "unknown collector"}
			}
			_ = a.write(ctx, conn, replyMsg{T: "reply", Req: m.Req, Report: r})
		}()
	case "update":
		go a.selfUpdate(ctx, m)
	}
}

func (a *Agent) write(ctx context.Context, conn *websocket.Conn, v any) error {
	wctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return wsjson.Write(wctx, conn, v)
}

// send writes to the current connection; false when there is none or it failed.
func (a *Agent) send(ctx context.Context, v any) bool {
	a.mu.Lock()
	conn := a.conn
	a.mu.Unlock()
	if conn == nil {
		return false
	}
	return a.write(ctx, conn, v) == nil
}

// Connected reports whether a connection to the panel is up.
func (a *Agent) Connected() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.conn != nil
}

func (a *Agent) setProbeEvery(d time.Duration) {
	select {
	case <-a.probeEvery:
	default:
	}
	a.probeEvery <- d
}

// probeLoop probes on the current interval whether or not the panel is reachable;
// what can't be sent is kept for backfill.
func (a *Agent) probeLoop(ctx context.Context) {
	interval := a.DefaultProbe
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case d := <-a.probeEvery:
			if d == interval {
				continue
			}
			sooner := d < interval
			interval = d
			if sooner {
				// The panel started watching: probe now rather than at the end of a 30 s wait.
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(0)
			}
		case <-timer.C:
			start := time.Now()
			r := a.Runner.Run(ctx, collectors.Probe)
			if ctx.Err() != nil {
				return
			}
			if !a.send(ctx, reportMsg{T: "report", Report: r}) {
				a.backfill.Add(r)
			}
			timer.Reset(max(100*time.Millisecond, interval-time.Since(start)))
		}
	}
}

// updatesLoop pushes pending updates every UpdatesEvery while connected.
func (a *Agent) updatesLoop(ctx context.Context) {
	t := time.NewTicker(a.UpdatesEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if !a.Connected() {
				continue
			}
			r := a.Runner.Run(ctx, collectors.Updates)
			a.send(ctx, reportMsg{T: "report", Report: r})
		}
	}
}
