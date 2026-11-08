package bridge

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestLogLimitAndBadLines(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "events.jsonl")
	content := "{\"pane_id\":\"one\"}\nnot json\n\n{\"pane_id\":\"two\"}\n[1,2]\n"
	if err := os.WriteFile(logPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	b := New(Config{EventsLog: logPath})
	static := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}

	tests := []struct {
		query string
		want  int
	}{
		{"?limit=2", 2},
		{"?limit=0", 1},
		{"?limit=9999", 3},
		{"?limit=nope", 3},
		{"", 3},
	}
	for _, test := range tests {
		request := httptest.NewRequest(http.MethodGet, "/log"+test.query, nil)
		recorder := httptest.NewRecorder()
		b.Handler(static).ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status = %d", test.query, recorder.Code)
		}
		var rows []json.RawMessage
		if err := json.Unmarshal(recorder.Body.Bytes(), &rows); err != nil {
			t.Fatalf("%s body: %v", test.query, err)
		}
		if len(rows) != test.want {
			t.Fatalf("%s returned %d rows, want %d", test.query, len(rows), test.want)
		}
	}
}

func TestLogMissingFileIsEmptyArray(t *testing.T) {
	b := New(Config{EventsLog: filepath.Join(t.TempDir(), "missing.jsonl")})
	static := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}
	recorder := httptest.NewRecorder()
	b.Handler(static).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/log", nil))
	if body := recorder.Body.String(); body != "[]" {
		t.Fatalf("missing log body = %q, want []", body)
	}
}

func TestStaticFallsBackToIndex(t *testing.T) {
	b := New(Config{EventsLog: filepath.Join(t.TempDir(), "events.jsonl")})
	static := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("town")}}
	recorder := httptest.NewRecorder()
	b.Handler(static).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/town/route", nil))
	if recorder.Code != http.StatusOK || recorder.Body.String() != "town" {
		t.Fatalf("SPA fallback = %d %q", recorder.Code, recorder.Body.String())
	}
	var _ fs.FS = static
}
