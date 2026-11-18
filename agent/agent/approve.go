package agent

// Approving custom scripts (panel/lib/approval.ts). The panel runs a custom
// script on this machine (an update script, a saved command) only when its
// sha256 is listed in ~/.config/fleet/approved-scripts, and it never writes that
// file itself. `fleet-agent approve <sha256>`, run by someone on this machine,
// fetches the script from the panel, checks it has that hash, shows it and asks.

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
)

var hashRE = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ValidHash reports whether h looks like a script's sha256 (lowercase hex).
func ValidHash(h string) bool { return hashRE.MatchString(h) }

// ApprovedFile is ~/.config/fleet/approved-scripts, the path the panel checks.
// It isn't under the agent's config, so it survives reinstalling or removing the
// agent, and works the same on machines without one.
func ApprovedFile() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "fleet", "approved-scripts"), nil
}

// Approval is one line of the approved-scripts file.
type Approval struct {
	Hash string
	Name string
}

// ReadApproved lists the approvals in file; a missing file is an empty list.
func ReadApproved(file string) ([]Approval, error) {
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Approval
	for _, line := range strings.Split(string(data), "\n") {
		hash, name, _ := strings.Cut(strings.TrimSpace(line), " ")
		if ValidHash(hash) {
			out = append(out, Approval{Hash: hash, Name: strings.TrimSpace(name)})
		}
	}
	return out, nil
}

func isApproved(list []Approval, hash string) bool {
	for _, a := range list {
		if a.Hash == hash {
			return true
		}
	}
	return false
}

// PanelScript is what the panel sends for a hash.
type PanelScript struct {
	Machine string `json:"machine"`
	Name    string `json:"name"`
	Script  string `json:"script"`
}

// FetchScript asks the panel for the script with this hash and checks that it
// has that hash, so the panel can't get a different script approved.
func FetchScript(ctx context.Context, cfg *Config, hash string) (*PanelScript, error) {
	client := panelClient(cfg.CA)
	var lastErr error
	for _, base := range cfg.URLs {
		rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		s, final, err := fetchScript(rctx, client, base, cfg.Token, hash)
		cancel()
		if err == nil {
			return s, nil
		}
		if final {
			return nil, err
		}
		lastErr = fmt.Errorf("%s: %w", base, err)
	}
	return nil, lastErr
}

// fetchScript tries one panel address; final means another address won't answer differently.
func fetchScript(ctx context.Context, client *http.Client, base, token, hash string) (_ *PanelScript, final bool, _ error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/agent/script/"+hash, nil)
	if err != nil {
		return nil, true, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		return nil, false, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, false, err
	}
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return nil, true, errAuth
	case http.StatusNotFound:
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &e) == nil && e.Error != "" {
			return nil, true, errors.New(e.Error)
		}
		return nil, true, errors.New("the panel doesn't know this script (an older fleet-agent or panel?)")
	default:
		return nil, false, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var s PanelScript
	if err := json.Unmarshal(body, &s); err != nil {
		return nil, true, fmt.Errorf("the panel's answer isn't JSON: %w", err)
	}
	sum := sha256.Sum256([]byte(s.Script))
	if hex.EncodeToString(sum[:]) != hash {
		return nil, true, errors.New("the panel sent a script with a different hash; not approving it")
	}
	return &s, true, nil
}

// Visible makes control and formatting characters visible, so a script can't
// hide lines from the person approving it (terminal escapes, carriage returns,
// right-to-left overrides). Tabs and newlines stay as they are.
func Visible(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\n' || r == '\t':
			b.WriteRune(r)
		case r == unicode.ReplacementChar:
			b.WriteString(`\ufffd`)
		case unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r):
			if r < 0x80 {
				fmt.Fprintf(&b, `\x%02x`, r)
			} else {
				fmt.Fprintf(&b, `\u%04x`, r)
			}
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// oneLine is a name as it goes into the approved-scripts file.
func oneLine(s string) string {
	s = strings.Join(strings.Fields(Visible(s)), " ")
	if r := []rune(s); len(r) > 80 {
		s = string(r[:80])
	}
	return s
}

// Approve shows the script with this hash, as the panel has it, and records it
// in file when the person answers yes on in.
func Approve(ctx context.Context, cfg *Config, file, hash string, in io.Reader, out io.Writer) error {
	if !ValidHash(hash) {
		return errors.New("that isn't a script hash: copy the whole approve command from the panel")
	}
	list, err := ReadApproved(file)
	if err != nil {
		return err
	}
	if isApproved(list, hash) {
		fmt.Fprintln(out, "Already approved on this machine.")
		return nil
	}
	s, err := FetchScript(ctx, cfg, hash)
	if err != nil {
		return fmt.Errorf("couldn't get the script from the panel: %w", err)
	}

	host, _ := os.Hostname()
	fmt.Fprintf(out, "\n“%s” from the Fleet panel, to run on %s as %s:\n\n", oneLine(s.Name), oneLine(s.Machine), currentUser())
	for _, line := range strings.Split(Visible(s.Script), "\n") {
		fmt.Fprintf(out, "  │ %s\n", line)
	}
	fmt.Fprintf(out, "\nsha256 %s\n\n", hash)
	fmt.Fprintf(out, "The panel will be able to run exactly this script on %s whenever someone asks it to. Approve? [y/N] ", host)

	answer, _ := bufio.NewReader(in).ReadString('\n')
	if a := strings.ToLower(strings.TrimSpace(answer)); a != "y" && a != "yes" {
		fmt.Fprintln(out, "Not approved.")
		return nil
	}
	if err := appendApproval(file, hash, oneLine(s.Name)); err != nil {
		return err
	}
	fmt.Fprintf(out, "Approved. It's in %s; `fleet-agent unapprove %s` takes it back.\n", file, hash[:12])
	return nil
}

func appendApproval(file, hash, name string) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(f, "%s %s\n", hash, name)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// Unapprove removes every approval whose hash starts with prefix (at least 8
// characters); it reports how many it removed.
func Unapprove(file, prefix string) (int, error) {
	prefix = strings.ToLower(strings.TrimSpace(prefix))
	if len(prefix) < 8 || !regexp.MustCompile(`^[0-9a-f]+$`).MatchString(prefix) {
		return 0, errors.New("give at least the first 8 characters of the script's hash (see `fleet-agent approved`)")
	}
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var keep []string
	n := 0
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		if hash, _, _ := strings.Cut(strings.TrimSpace(line), " "); ValidHash(hash) && strings.HasPrefix(hash, prefix) {
			n++
			continue
		}
		if line != "" {
			keep = append(keep, line)
		}
	}
	if n == 0 {
		return 0, nil
	}
	out := strings.Join(keep, "\n")
	if out != "" {
		out += "\n"
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, []byte(out), 0o600); err != nil {
		return 0, err
	}
	return n, os.Rename(tmp, file)
}

func currentUser() string {
	if u := os.Getenv("USER"); u != "" {
		return u
	}
	return "this user"
}
