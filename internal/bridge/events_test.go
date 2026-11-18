package bridge

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeLog(t *testing.T, minBytes int) (string, []byte) {
	t.Helper()
	logPath := filepath.Join(t.TempDir(), "events.jsonl")
	line := []byte(`{"pane_id":"old","status":"working","at":"2026-01-01T00:00:00.000Z"}` + "\n")
	body := bytes.Repeat(line, minBytes/len(line)+200)
	if err := os.WriteFile(logPath, body, 0o644); err != nil {
		t.Fatal(err)
	}
	return logPath, body
}

// assertBounded checks the file never exceeds the cap and that every surviving
// row is whole JSON, not a fragment left by rotation.
func assertBounded(t *testing.T, logPath string) {
	t.Helper()
	info, err := os.Stat(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() > eventsLogMaxBytes {
		t.Fatalf("events log is %d bytes, want <= %d", info.Size(), eventsLogMaxBytes)
	}
	b := New(Config{EventsLog: logPath})
	rows := b.ReadLog(10)
	if len(rows) == 0 || !strings.Contains(string(rows[len(rows)-1]), `"pane_id":"new"`) {
		t.Fatalf("rows = %s, want the appended event last", rows)
	}
	for _, row := range rows {
		if !json.Valid(row) {
			t.Fatalf("row is not whole JSON: %q", row)
		}
	}
}

func TestEventLogStaysBoundedAboveCap(t *testing.T) {
	logPath, _ := writeLog(t, eventsLogMaxBytes)
	b := New(Config{EventsLog: logPath})
	b.appendEventLog(Event{PaneID: "new", Status: StatusDone, At: nowIso()})
	assertBounded(t, logPath)
}

func TestEventLogStaysBoundedAtExactCap(t *testing.T) {
	logPath, body := writeLog(t, eventsLogMaxBytes)
	if err := os.WriteFile(logPath, body[:eventsLogMaxBytes], 0o644); err != nil {
		t.Fatal(err)
	}
	b := New(Config{EventsLog: logPath})
	b.appendEventLog(Event{PaneID: "new", Status: StatusDone, At: nowIso()})
	assertBounded(t, logPath)
}

func TestEventLogDropsRowLargerThanCap(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "events.jsonl")
	b := New(Config{EventsLog: logPath})
	b.appendEventLog(Event{
		PaneID:      "new",
		Status:      StatusDone,
		At:          nowIso(),
		DisplayName: strings.Repeat("x", eventsLogMaxBytes),
	})
	if info, err := os.Stat(logPath); err == nil && info.Size() != 0 {
		t.Fatalf("oversized row wrote %d bytes, want it dropped", info.Size())
	}
	if rows := b.ReadLog(1); len(rows) != 0 {
		t.Fatalf("rows = %s, want none", rows)
	}
}

func TestEventLogRotationKeepsTwoLargeRowsUnderCap(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "events.jsonl")
	b := New(Config{EventsLog: logPath})
	b.appendEventLog(Event{
		PaneID: "old", Status: StatusWorking, At: nowIso(),
		DisplayName: strings.Repeat("a", 700*1024),
	})
	b.appendEventLog(Event{
		PaneID: "new", Status: StatusDone, At: nowIso(),
		DisplayName: strings.Repeat("b", 600*1024),
	})
	assertBounded(t, logPath)
}
