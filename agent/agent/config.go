package agent

import (
	"crypto/x509"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

// Config is what the panel wrote into ~/.config/fleet-agent/ when it installed the agent.
type Config struct {
	// ID is the machine's name in the panel's inventory.
	ID string `toml:"id"`
	// URLs of the panel, tried in order: LAN first, then Tailscale.
	URLs []string `toml:"urls"`

	// Token is the machine's own token (from the token file).
	Token string `toml:"-"`
	// CA is the panel's certificate authority (from ca.pem), the only one trusted.
	CA *x509.CertPool `toml:"-"`
	// Dir is where the files were read from.
	Dir string `toml:"-"`
}

// ConfigDir is $FLEET_AGENT_CONFIG, or ~/.config/fleet-agent.
func ConfigDir() (string, error) {
	if d := os.Getenv("FLEET_AGENT_CONFIG"); d != "" {
		return d, nil
	}
	// Always ~/.config, not $XDG_CONFIG_HOME: the installer's shell and the
	// systemd service must agree, and the service rarely has it set.
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "fleet-agent"), nil
}

// LoadConfig reads config.toml, token and ca.pem from dir.
func LoadConfig(dir string) (*Config, error) {
	c := &Config{Dir: dir}
	if _, err := toml.DecodeFile(filepath.Join(dir, "config.toml"), c); err != nil {
		return nil, fmt.Errorf("config.toml: %w", err)
	}
	if c.ID == "" {
		return nil, errors.New("config.toml: id is missing")
	}
	if len(c.URLs) == 0 {
		return nil, errors.New("config.toml: urls is empty")
	}
	for i, u := range c.URLs {
		p, err := url.Parse(u)
		if err != nil || p.Scheme != "https" || p.Host == "" {
			return nil, fmt.Errorf("config.toml: %q is not an https:// address", u)
		}
		c.URLs[i] = strings.TrimRight(u, "/")
	}
	tok, err := os.ReadFile(filepath.Join(dir, "token"))
	if err != nil {
		return nil, err
	}
	c.Token = strings.TrimSpace(string(tok))
	if c.Token == "" {
		return nil, errors.New("token is empty")
	}
	pem, err := os.ReadFile(filepath.Join(dir, "ca.pem"))
	if err != nil {
		return nil, err
	}
	c.CA = x509.NewCertPool()
	if !c.CA.AppendCertsFromPEM(pem) {
		return nil, errors.New("ca.pem holds no certificate")
	}
	return c, nil
}
