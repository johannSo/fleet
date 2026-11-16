package agent

import "fleet-agent/collectors"

// Messages on the agent's WebSocket. Every message is a JSON object with a "t"
// field naming its type; see docs/SERVER_AGENT.md.

// Report is one collector's output, sent unchanged.
type Report struct {
	Kind collectors.Kind `json:"kind"`
	// At is when the collector started, in Unix milliseconds on the agent's clock.
	At   int64  `json:"at"`
	Out  string `json:"out"`
	Code int    `json:"code"`
	Ms   int64  `json:"ms"`
	// Err is the tail of stderr, or why the collector couldn't run.
	Err      string `json:"err,omitempty"`
	TimedOut bool   `json:"timedOut,omitempty"`
}

// Agent → panel.

type helloMsg struct {
	T        string `json:"t"` // "hello"
	ID       string `json:"id"`
	Version  string `json:"version"`
	Build    string `json:"build"`
	Arch     string `json:"arch"`
	Hostname string `json:"hostname"`
	// Now is the agent's clock (Unix ms), so the panel can correct for skew.
	Now int64 `json:"now"`
}

type reportMsg struct {
	T string `json:"t"` // "report"
	Report
}

type backfillMsg struct {
	T       string   `json:"t"` // "backfill"
	Reports []Report `json:"reports"`
}

type replyMsg struct {
	T   string `json:"t"` // "reply"
	Req string `json:"req"`
	Report
}

type updateFailedMsg struct {
	T     string `json:"t"` // "update-failed"
	Build string `json:"build"`
	Error string `json:"error"`
}

// Panel → agent. One struct covers all three; unused fields stay empty.
type panelMsg struct {
	T string `json:"t"` // "config", "collect" or "update"

	// config
	ProbeMs int64 `json:"probeMs,omitempty"`

	// collect
	Req  string          `json:"req,omitempty"`
	Kind collectors.Kind `json:"kind,omitempty"`

	// update
	Build  string `json:"build,omitempty"`
	URL    string `json:"url,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
}
