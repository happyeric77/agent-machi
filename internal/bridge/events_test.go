package bridge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEventLogStaysBounded(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "events.jsonl")
	line := `{"pane_id":"old","status":"working","at":"2026-01-01T00:00:00.000Z"}` + "\n"
	oversized := strings.Repeat(line, eventsLogMaxBytes/len(line)+100)
	if err := os.WriteFile(logPath, []byte(oversized), 0o644); err != nil {
		t.Fatal(err)
	}

	b := New(Config{EventsLog: logPath})
	b.appendEventLog(Event{PaneID: "new", Status: StatusDone, At: nowIso()})

	info, err := os.Stat(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() > eventsLogMaxBytes {
		t.Fatalf("events log still %d bytes, want <= %d", info.Size(), eventsLogMaxBytes)
	}
	rows := b.ReadLog(1)
	if len(rows) != 1 || !strings.Contains(string(rows[0]), `"pane_id":"new"`) {
		t.Fatalf("last row = %s, want the appended event", rows)
	}
}
