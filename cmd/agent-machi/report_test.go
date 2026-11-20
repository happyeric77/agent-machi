package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func envFrom(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestParseReportArgs(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		env     map[string]string
		wantErr string
		check   func(*testing.T, *reportOptions)
	}{
		{
			name: "defaults",
			args: []string{"--id", "build", "--status", "working"},
			check: func(t *testing.T, opts *reportOptions) {
				if opts.bridgeURL != defaultBridgeURL {
					t.Errorf("bridgeURL = %q", opts.bridgeURL)
				}
				if opts.source != defaultSource {
					t.Errorf("source = %q", opts.source)
				}
				if opts.token != "" || opts.nameSet || opts.agentSet || opts.remove {
					t.Errorf("unexpected option state: %+v", opts)
				}
			},
		},
		{
			name: "env and flags",
			args: []string{"--id", "build", "--status", "done", "--name", "build", "--agent", "ci"},
			env: map[string]string{
				"AGENT_MACHI_BRIDGE_URL":    "http://10.0.0.2:9999",
				"AGENT_MACHI_INGEST_TOKEN":  "secret",
				"AGENT_MACHI_UNUSED_FOR_CI": "ignored",
			},
			check: func(t *testing.T, opts *reportOptions) {
				if opts.bridgeURL != "http://10.0.0.2:9999" || opts.token != "secret" {
					t.Errorf("env not applied: %+v", opts)
				}
				if !opts.nameSet || opts.name != "build" || !opts.agentSet || opts.agent != "ci" {
					t.Errorf("optional fields not tracked: %+v", opts)
				}
			},
		},
		{
			name: "flag overrides env url",
			args: []string{"--id", "build", "--status", "idle", "--url", "http://localhost:7000/"},
			env:  map[string]string{"AGENT_MACHI_BRIDGE_URL": "http://10.0.0.2:9999"},
			check: func(t *testing.T, opts *reportOptions) {
				if opts.bridgeURL != "http://localhost:7000/" {
					t.Errorf("bridgeURL = %q", opts.bridgeURL)
				}
			},
		},
		{
			name: "remove needs no status",
			args: []string{"--id", "build", "--remove"},
			check: func(t *testing.T, opts *reportOptions) {
				if !opts.remove {
					t.Error("remove not set")
				}
			},
		},
		{name: "missing id", args: []string{"--status", "idle"}, wantErr: "--id is required"},
		{name: "missing status", args: []string{"--id", "build"}, wantErr: "--status is required"},
		{
			name:    "bad status",
			args:    []string{"--id", "build", "--status", "sleeping"},
			wantErr: "must be working, blocked, done or idle",
		},
		{
			name:    "remove with status",
			args:    []string{"--id", "build", "--remove", "--status", "idle"},
			wantErr: "--status cannot be used with --remove",
		},
		{
			name:    "colon in id",
			args:    []string{"--id", "a:b", "--status", "idle"},
			wantErr: "must not be empty or contain ':'",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			opts, err := parseReportArgs(test.args, envFrom(test.env), io.Discard)
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			test.check(t, opts)
		})
	}
}

func TestBuildReportRequest(t *testing.T) {
	opts := &reportOptions{
		bridgeURL: "http://127.0.0.1:8731/",
		token:     "secret",
		source:    "ci",
		id:        "build",
		status:    "blocked",
		name:      "build-runner",
		nameSet:   true,
	}

	request, err := buildReportRequest(opts)
	if err != nil {
		t.Fatalf("buildReportRequest: %v", err)
	}
	if request.Method != http.MethodPost || request.URL.String() != "http://127.0.0.1:8731/report" {
		t.Errorf("request = %s %s", request.Method, request.URL)
	}
	if got := request.Header.Get("Authorization"); got != "Bearer secret" {
		t.Errorf("Authorization = %q", got)
	}
	body, _ := io.ReadAll(request.Body)
	var payload map[string]string
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("body json: %v", err)
	}
	want := map[string]string{"source": "ci", "id": "build", "status": "blocked", "name": "build-runner"}
	if len(payload) != len(want) {
		t.Errorf("payload = %v", payload)
	}
	for key, value := range want {
		if payload[key] != value {
			t.Errorf("payload[%q] = %q, want %q", key, payload[key], value)
		}
	}

	opts.remove = true
	request, err = buildReportRequest(opts)
	if err != nil {
		t.Fatalf("buildReportRequest remove: %v", err)
	}
	if request.Method != http.MethodDelete || request.URL.Path != "/report" {
		t.Errorf("request = %s %s", request.Method, request.URL)
	}
	if request.URL.Query().Get("source") != "ci" || request.URL.Query().Get("id") != "build" {
		t.Errorf("query = %s", request.URL.RawQuery)
	}
	if request.Body != nil {
		t.Error("remove request should have no body")
	}
}

func TestRunReport(t *testing.T) {
	var lastRequest struct {
		method, path, token, body string
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		lastRequest = struct{ method, path, token, body string }{
			r.Method, r.URL.Path, r.Header.Get("Authorization"), string(body),
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"pane_id":"ext:ci:build","status":"blocked","changed":true}`))
	}))
	defer server.Close()

	t.Run("post succeeds", func(t *testing.T) {
		t.Setenv("AGENT_MACHI_INGEST_TOKEN", "secret")
		var stdout bytes.Buffer
		code := runReport([]string{"--url", server.URL, "--id", "build", "--source", "ci", "--status", "blocked"}, &stdout, io.Discard)
		if code != 0 {
			t.Fatalf("exit = %d", code)
		}
		if got := strings.TrimSpace(stdout.String()); got != "ok ext:ci:build blocked (changed)" {
			t.Errorf("stdout = %q", got)
		}
		if lastRequest.method != http.MethodPost || lastRequest.path != "/report" || lastRequest.token != "Bearer secret" {
			t.Errorf("request = %+v", lastRequest)
		}
		if !strings.Contains(lastRequest.body, `"status":"blocked"`) {
			t.Errorf("body = %s", lastRequest.body)
		}
	})

	t.Run("remove succeeds without a status", func(t *testing.T) {
		var stdout bytes.Buffer
		code := runReport([]string{"--url", server.URL, "--id", "build", "--source", "ci", "--remove"}, &stdout, io.Discard)
		if code != 0 {
			t.Fatalf("exit = %d", code)
		}
		if lastRequest.method != http.MethodDelete || lastRequest.path != "/report" || lastRequest.body != "" {
			t.Errorf("request = %+v", lastRequest)
		}
	})

	t.Run("errors", func(t *testing.T) {
		cases := []struct {
			code    int
			body    string
			message string
		}{
			{http.StatusUnauthorized, "unauthorized", "rejected the token"},
			{http.StatusNotFound, "404 page not found", "ingest is disabled"},
			{http.StatusBadRequest, `{"error":"status must be working, blocked, done or idle"}`, "status must be working"},
			{http.StatusInternalServerError, "boom", "returned 500"},
		}
		for _, tc := range cases {
			status := tc.code
			failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(tc.body))
			}))
			var stderr bytes.Buffer
			code := runReport([]string{"--url", failing.URL, "--id", "build", "--status", "idle"}, io.Discard, &stderr)
			failing.Close()
			if code == 0 {
				t.Errorf("%d: expected non-zero exit", tc.code)
			}
			if !strings.Contains(stderr.String(), tc.message) {
				t.Errorf("%d: stderr = %q, want containing %q", tc.code, stderr.String(), tc.message)
			}
		}
	})

	t.Run("unreachable bridge", func(t *testing.T) {
		dead := httptest.NewServer(http.NotFoundHandler())
		deadURL := dead.URL
		dead.Close()

		var stderr bytes.Buffer
		code := runReport([]string{"--url", deadURL, "--id", "build", "--status", "idle"}, io.Discard, &stderr)
		if code == 0 || !strings.Contains(stderr.String(), "cannot reach bridge") {
			t.Errorf("exit = %d, stderr = %q", code, stderr.String())
		}
	})
}
