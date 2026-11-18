package agent

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"fleet-agent/collectors"
)

func sum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// scriptPanel serves /agent/script/<hash> for token "tok", answering with body for any hash it knows.
func scriptPanel(t *testing.T, scripts map[string]PanelScript) (*Config, *[]string) {
	p := newPanel(t)
	var asked []string
	p.extra = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		hash := strings.TrimPrefix(r.URL.Path, "/agent/script/")
		asked = append(asked, hash)
		s, ok := scripts[hash]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]string{"error": "no such script"})
			return
		}
		json.NewEncoder(w).Encode(s)
	})
	pool := x509.NewCertPool()
	pool.AddCert(p.srv.Certificate())
	return &Config{ID: "t1", URLs: []string{p.srv.URL}, Token: "tok", CA: pool}, &asked
}

func TestApproveAsksAndRecords(t *testing.T) {
	script := "docker image prune -f\ndf -h /"
	hash := sum(script)
	cfg, _ := scriptPanel(t, map[string]PanelScript{hash: {Machine: "nas", Name: "prune\nimages", Script: script}})
	file := filepath.Join(t.TempDir(), "fleet", "approved-scripts")

	var out strings.Builder
	if err := Approve(context.Background(), cfg, file, hash, strings.NewReader("n\n"), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "│ docker image prune -f") || !strings.Contains(out.String(), "Not approved") {
		t.Fatalf("didn't show the script or didn't refuse:\n%s", out.String())
	}
	if list, _ := ReadApproved(file); len(list) != 0 {
		t.Fatalf("recorded after answering no: %v", list)
	}

	out.Reset()
	if err := Approve(context.Background(), cfg, file, hash, strings.NewReader("y\n"), &out); err != nil {
		t.Fatal(err)
	}
	list, _ := ReadApproved(file)
	if len(list) != 1 || list[0].Hash != hash || list[0].Name != "prune images" {
		t.Fatalf("approvals = %v", list)
	}
	if fi, _ := os.Stat(file); fi.Mode().Perm() != 0o600 {
		t.Errorf("file mode %v", fi.Mode().Perm())
	}

	out.Reset()
	if err := Approve(context.Background(), cfg, file, hash, strings.NewReader(""), &out); err != nil || !strings.Contains(out.String(), "Already approved") {
		t.Fatalf("second approve: %v %q", err, out.String())
	}

	if n, err := Unapprove(file, hash[:10]); err != nil || n != 1 {
		t.Fatalf("unapprove: %d %v", n, err)
	}
	if list, _ := ReadApproved(file); len(list) != 0 {
		t.Fatalf("still approved: %v", list)
	}
	if _, err := Unapprove(file, "abc"); err == nil {
		t.Error("a 3-character prefix was accepted")
	}
}

func TestApproveRefusesAScriptWithAnotherHash(t *testing.T) {
	want := sum("uptime")
	cfg, _ := scriptPanel(t, map[string]PanelScript{want: {Machine: "nas", Name: "x", Script: "rm -rf ~"}})
	file := filepath.Join(t.TempDir(), "approved-scripts")
	var out strings.Builder
	err := Approve(context.Background(), cfg, file, want, strings.NewReader("y\n"), &out)
	if err == nil || !strings.Contains(err.Error(), "different hash") {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(out.String(), "rm -rf") {
		t.Error("showed the mismatching script")
	}
	if list, _ := ReadApproved(file); len(list) != 0 {
		t.Fatalf("recorded: %v", list)
	}
}

func TestApproveRejectsBadInput(t *testing.T) {
	cfg, asked := scriptPanel(t, nil)
	file := filepath.Join(t.TempDir(), "approved-scripts")
	for _, h := range []string{"", "abc", strings.Repeat("g", 64), strings.ToUpper(sum("x")), sum("x") + " ; rm -rf ~"} {
		if err := Approve(context.Background(), cfg, file, h, strings.NewReader("y\n"), &strings.Builder{}); err == nil {
			t.Errorf("accepted %q", h)
		}
	}
	if len(*asked) != 0 {
		t.Errorf("asked the panel for %v", *asked)
	}
	if err := Approve(context.Background(), cfg, file, sum("unknown"), strings.NewReader("y\n"), &strings.Builder{}); err == nil || !strings.Contains(err.Error(), "no such script") {
		t.Errorf("unknown script: %v", err)
	}
	cfg.Token = "wrong"
	if err := Approve(context.Background(), cfg, file, sum("unknown"), strings.NewReader("y\n"), &strings.Builder{}); err != errAuthWrapped(err) {
		t.Errorf("wrong token: %v", err)
	}
}

// errAuthWrapped returns err when it wraps errAuth, nil otherwise.
func errAuthWrapped(err error) error {
	if err != nil && strings.Contains(err.Error(), errAuth.Error()) {
		return err
	}
	return nil
}

func TestVisibleShowsHiddenCharacters(t *testing.T) {
	got := Visible("echo ok\r\x1b[2Krm -rf ~\u202e\tx\n")
	want := "echo ok\\x0d\\x1b[2Krm -rf ~\\u202e\tx\n"
	if got != want {
		t.Fatalf("Visible = %q, want %q", got, want)
	}
}

func TestProbeReportsApprovals(t *testing.T) {
	script, _ := collectors.Script(collectors.Probe)
	home := t.TempDir()
	run := func() string {
		cmd := exec.Command("bash", "-s")
		cmd.Stdin = strings.NewReader(script)
		cmd.Env = append(os.Environ(), "HOME="+home)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("probe failed: %v", err)
		}
		return string(out)
	}
	if out := run(); !strings.Contains(out, "approvals=1") || strings.Contains(out, "approved=") {
		t.Fatalf("without approvals:\n%s", out)
	}
	h := sum("uptime")
	os.MkdirAll(filepath.Join(home, ".config", "fleet"), 0o700)
	os.WriteFile(filepath.Join(home, ".config", "fleet", "approved-scripts"), []byte(h+" uptime\nnot-a-hash x\n"), 0o600)
	out := run()
	if !strings.Contains(out, "approved="+h+"\n") || strings.Count(out, "approved=") != 1 {
		t.Fatalf("with one approval:\n%s", out)
	}
}
