// Package collectors holds the read-only scripts the agent runs. The panel reads
// the same files from disk (panel/lib/collectors.ts) when it has to fall
// back to ssh, so both paths produce the same output for the same parsers.
package collectors

import (
	"embed"
	"time"
)

//go:embed *.sh
var files embed.FS

// Kind names one collector.
type Kind string

const (
	Probe   Kind = "probe"
	Details Kind = "details"
	Updates Kind = "updates"
	Index   Kind = "index"
)

// Kinds lists every collector.
var Kinds = []Kind{Probe, Details, Updates, Index}

var timeouts = map[Kind]time.Duration{
	Probe:   8 * time.Second,
	Details: 15 * time.Second,
	Updates: 60 * time.Second,
	Index:   30 * time.Second,
}

// Valid reports whether k is a known collector.
func Valid(k Kind) bool {
	_, ok := timeouts[k]
	return ok
}

// Script returns the collector's bash script.
func Script(k Kind) (string, bool) {
	if !Valid(k) {
		return "", false
	}
	b, err := files.ReadFile(string(k) + ".sh")
	if err != nil {
		return "", false
	}
	return string(b), true
}

// Timeout is how long the collector may run before it's killed.
func Timeout(k Kind) time.Duration {
	return timeouts[k]
}
