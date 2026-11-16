package agent

import "sync"

// Backfill keeps the probes taken while disconnected, newest last, for at most
// Window milliseconds and Max entries.
type Backfill struct {
	Window int64
	Max    int

	mu      sync.Mutex
	reports []Report
}

// Add keeps r and drops what has fallen out of the window.
func (b *Backfill) Add(r Report) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.reports = append(b.reports, r)
	cut := 0
	for cut < len(b.reports) && (r.At-b.reports[cut].At > b.Window || len(b.reports)-cut > b.Max) {
		cut++
	}
	b.reports = append([]Report(nil), b.reports[cut:]...)
}

// Take returns everything kept, oldest first, and empties the buffer.
func (b *Backfill) Take() []Report {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := b.reports
	b.reports = nil
	return out
}

// Len is how many reports are kept.
func (b *Backfill) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.reports)
}
