package bridge

import (
	"bytes"
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
	rows := b.ReadLog(1)
	if len(rows) != 1 || !strings.Contains(string(rows[0]), `"pane_id":"new"`) {
		t.Fatalf("last row = %s, want the appended event", rows)
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
	if info, err := os.Stat(logPath); err != nil || info.Size() != eventsLogMaxBytes {
		t.Fatalf("setup: size %v err %v", info, err)
	}
	b := New(Config{EventsLog: logPath})
	b.appendEventLog(Event{PaneID: "new", Status: StatusDone, At: nowIso()})
	assertBounded(t, logPath)
}

func TestEventLogKeepsOversizedRowAlone(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "events.jsonl")
	big := Event{PaneID: "new", Status: StatusDone, At: nowIso(), DisplayName: strings.Repeat("x", eventsLogMaxBytes)}
	b := New(Config{EventsLog: logPath})
	b.appendEventLog(big)
	info, err := os.Stat(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() <= eventsLogMaxBytes || info.Size() > eventsLogMaxBytes+1024 {
		t.Fatalf("oversized row wrote %d bytes, want just the row", info.Size())
	}
	if rows := b.ReadLog(1); len(rows) != 1 || !strings.Contains(string(rows[0]), `"pane_id":"new"`) {
		t.Fatalf("last row = %s, want the oversized event", rows)
	}
}
