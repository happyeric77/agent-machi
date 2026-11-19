package bridge

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

const testIngestToken = "test-token"

func newIngestBridge(t *testing.T, token string, ttl time.Duration) (*Bridge, fs.FS) {
	t.Helper()
	b := New(Config{
		EventsLog:   filepath.Join(t.TempDir(), "events.jsonl"),
		IngestToken: token,
		IngestTTL:   ttl,
	})
	return b, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("town")}}
}

func reportRequestFor(method, target, body, token string) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return request
}

func serve(t *testing.T, b *Bridge, static fs.FS, request *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	b.Handler(static).ServeHTTP(recorder, request)
	return recorder
}

func reportBody(source, id, status string) string {
	return fmt.Sprintf(`{"source":%q,"id":%q,"status":%q}`, source, id, status)
}

func TestReportRouteMissingWithoutToken(t *testing.T) {
	b, static := newIngestBridge(t, "", 0)
	for _, method := range []string{http.MethodPost, http.MethodDelete, http.MethodGet} {
		recorder := serve(t, b, static, reportRequestFor(method, "/report", `{}`, ""))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s /report = %d, want 404 when no token is configured", method, recorder.Code)
		}
	}
}

func TestReportRejectsWrongToken(t *testing.T) {
	b, static := newIngestBridge(t, testIngestToken, 0)
	body := reportBody("ci", "build", "working")
	for _, token := range []string{"", "wrong"} {
		recorder := serve(t, b, static, reportRequestFor(http.MethodPost, "/report", body, token))
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("token %q = %d, want 401", token, recorder.Code)
		}
	}
	recorder := serve(t, b, static, reportRequestFor(http.MethodPost, "/report", body, testIngestToken))
	if recorder.Code != http.StatusOK {
		t.Fatalf("valid token = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestReportValidatesFields(t *testing.T) {
	b, static := newIngestBridge(t, testIngestToken, 0)
	tests := []struct {
		name string
		body string
	}{
		{"missing source", `{"id":"x","status":"working"}`},
		{"missing id", `{"source":"ci","status":"working"}`},
		{"unknown status", reportBody("ci", "x", "unknown")},
		{"gone is not a status", reportBody("ci", "x", "gone")},
		{"colon in source", reportBody("a:b", "x", "working")},
		{"colon in id", reportBody("ci", "a:b", "working")},
		{"invalid json", `{"source":`},
	}
	for _, test := range tests {
		recorder := serve(t, b, static, reportRequestFor(http.MethodPost, "/report", test.body, testIngestToken))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s = %d, want 400", test.name, recorder.Code)
		}
	}
}

func TestReportIdentityCannotAlias(t *testing.T) {
	b, static := newIngestBridge(t, testIngestToken, 0)
	// A separator is rejected, so (a:b, c) and (a, b:c) can never collide.
	for _, body := range []string{reportBody("a:b", "c", "working"), reportBody("a", "b:c", "working")} {
		if recorder := serve(t, b, static, reportRequestFor(http.MethodPost, "/report", body, testIngestToken)); recorder.Code != http.StatusBadRequest {
			t.Fatalf("aliasing body %s = %d, want 400", body, recorder.Code)
		}
	}
	for _, body := range []string{reportBody("a", "b", "working"), reportBody("c", "d", "working")} {
		if recorder := serve(t, b, static, reportRequestFor(http.MethodPost, "/report", body, testIngestToken)); recorder.Code != http.StatusOK {
			t.Fatalf("body %s = %d", body, recorder.Code)
		}
	}
	rows := b.Snapshot()
	if len(rows) != 2 {
		t.Fatalf("snapshot has %d rows, want 2", len(rows))
	}
	if rows[0].PaneID == rows[1].PaneID {
		t.Fatalf("distinct reports shared pane id %q", rows[0].PaneID)
	}
}

func TestReportHeartbeatStaysSilent(t *testing.T) {
	b, static := newIngestBridge(t, testIngestToken, 0)
	body := reportBody("ci", "build", "working")
	serve(t, b, static, reportRequestFor(http.MethodPost, "/report", body, testIngestToken))
	first := b.Snapshot()
	serve(t, b, static, reportRequestFor(http.MethodPost, "/report", body, testIngestToken))
	second := b.Snapshot()

	if got := len(b.ReadLog(10)); got != 1 {
		t.Fatalf("heartbeat wrote %d log rows, want 1", got)
	}
	if first[0].StatusSince != second[0].StatusSince {
		t.Fatalf("heartbeat moved status_since from %s to %s", first[0].StatusSince, second[0].StatusSince)
	}
	if got := len(b.ReadLog(10)); got != 1 {
		t.Fatalf("log rows after heartbeat = %d, want 1", got)
	}
}

func TestDeleteRemovesWithoutEvent(t *testing.T) {
	b, static := newIngestBridge(t, testIngestToken, 0)
	body := reportBody("ci", "build", "done")
	serve(t, b, static, reportRequestFor(http.MethodPost, "/report", body, testIngestToken))

	sse := make(chan []byte, 8)
	b.addSSEClient(sse)
	defer b.removeSSEClient(sse)

	recorder := serve(t, b, static, reportRequestFor(http.MethodDelete, "/report?source=ci&id=build", "", testIngestToken))
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", recorder.Code, recorder.Body.String())
	}
	if rows := b.Snapshot(); len(rows) != 0 {
		t.Fatalf("snapshot still has %d rows after delete", len(rows))
	}
	if got := len(b.ReadLog(10)); got != 1 {
		t.Fatalf("delete wrote a log row (%d total), want the report row only", got)
	}
	if len(sse) != 0 {
		t.Fatalf("delete published %d SSE events, want 0", len(sse))
	}
}

func TestExpiryRemovesWithoutEvent(t *testing.T) {
	b, static := newIngestBridge(t, testIngestToken, 60*time.Millisecond)
	serve(t, b, static, reportRequestFor(http.MethodPost, "/report", reportBody("ci", "build", "working"), testIngestToken))
	if rows := b.Snapshot(); len(rows) != 1 {
		t.Fatalf("snapshot has %d rows before expiry, want 1", len(rows))
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && len(b.Snapshot()) == 1 {
		time.Sleep(20 * time.Millisecond)
	}
	if rows := b.Snapshot(); len(rows) != 0 {
		t.Fatalf("snapshot still has %d rows after TTL expiry", len(rows))
	}
	if got := len(b.ReadLog(10)); got != 1 {
		t.Fatalf("expiry wrote a log row (%d total), want the report row only", got)
	}
}

func TestHerdrReconcileKeepsExternalRows(t *testing.T) {
	b, static := newIngestBridge(t, testIngestToken, 0)
	serve(t, b, static, reportRequestFor(http.MethodPost, "/report", reportBody("ci", "build", "working"), testIngestToken))

	b.syncAgents(nil)
	rows := b.Snapshot()
	if len(rows) != 1 || rows[0].PaneID != "ext:ci:build" {
		t.Fatalf("Herdr reconcile pruned the external row: %v", rows)
	}
	if count := b.AgentCount(); count != 1 {
		t.Fatalf("AgentCount = %d, want 1", count)
	}
}

func TestServesHTTPWithoutHerdrSocket(t *testing.T) {
	b, static := newIngestBridge(t, testIngestToken, 0)
	b.cfg.SocketPath = filepath.Join(t.TempDir(), "missing", "herdr.sock")
	go b.StartHerdr()
	defer b.Stop()

	handler := b.Handler(static)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/health", nil))
		if recorder.Code == http.StatusOK {
			var payload health
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("health body: %v", err)
			}
			if !payload.OK {
				t.Fatalf("health not ok: %s", recorder.Body.String())
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("bridge never served /health without a Herdr socket")
}
