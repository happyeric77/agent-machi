package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	defaultBridgeURL = "http://127.0.0.1:8731"
	defaultSource    = "cli"
	reportTimeout    = 5 * time.Second
)

// errUsageReported means the flag package already printed the problem and the
// usage text; runReport should exit without saying it twice.
var errUsageReported = errors.New("usage already reported")

var validReportStatuses = map[string]bool{
	"working": true,
	"blocked": true,
	"done":    true,
	"idle":    true,
}

type reportOptions struct {
	bridgeURL string
	token     string
	source    string
	id        string
	status    string
	name      string
	nameSet   bool
	agent     string
	agentSet  bool
	remove    bool
}

// runReport is the whole client mode: one request, then exit. It never loads
// the embedded assets, binds a port, or touches the events log.
func runReport(args []string, stdout, stderr io.Writer) int {
	opts, err := parseReportArgs(args, os.Getenv, stderr)
	if err != nil {
		if !errors.Is(err, flag.ErrHelp) && !errors.Is(err, errUsageReported) {
			fmt.Fprintf(stderr, "agent-machi report: %v\n", err)
		}
		return 2
	}

	request, err := buildReportRequest(opts)
	if err != nil {
		fmt.Fprintf(stderr, "agent-machi report: %v\n", err)
		return 1
	}

	client := &http.Client{Timeout: reportTimeout}
	response, err := client.Do(request)
	if err != nil {
		fmt.Fprintf(stderr, "agent-machi report: cannot reach bridge at %s: %v\n", opts.bridgeURL, err)
		return 1
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 8<<10))

	if response.StatusCode != http.StatusOK {
		fmt.Fprintf(stderr, "agent-machi report: %v\n", explainReportError(opts, response.StatusCode, body))
		return 1
	}

	var result struct {
		PaneID  string `json:"pane_id"`
		Status  string `json:"status"`
		Changed bool   `json:"changed"`
	}
	if opts.remove {
		fmt.Fprintf(stdout, "ok removed %s\n", opts.id)
		return 0
	}
	if err := json.Unmarshal(body, &result); err != nil {
		fmt.Fprintf(stdout, "ok\n")
		return 0
	}
	change := "unchanged"
	if result.Changed {
		change = "changed"
	}
	fmt.Fprintf(stdout, "ok %s %s (%s)\n", result.PaneID, result.Status, change)
	return 0
}

func parseReportArgs(args []string, getenv func(string) string, stderr io.Writer) (*reportOptions, error) {
	opts := &reportOptions{
		bridgeURL: getenv("AGENT_MACHI_BRIDGE_URL"),
		token:     getenv("AGENT_MACHI_INGEST_TOKEN"),
		source:    defaultSource,
	}
	if opts.bridgeURL == "" {
		opts.bridgeURL = defaultBridgeURL
	}

	fs := flag.NewFlagSet("agent-machi report", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&opts.bridgeURL, "url", opts.bridgeURL, "bridge base URL (env AGENT_MACHI_BRIDGE_URL)")
	fs.StringVar(&opts.id, "id", "", "agent id inside the source (required)")
	fs.StringVar(&opts.status, "status", "", "working, blocked, done or idle")
	fs.StringVar(&opts.source, "source", opts.source, "source name; two sources may reuse an id")
	fs.StringVar(&opts.name, "name", "", "optional name shown on the sign")
	fs.StringVar(&opts.agent, "agent", "", "optional agent label")
	fs.BoolVar(&opts.remove, "remove", false, "remove the agent instead of reporting a status")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil, flag.ErrHelp
		}
		return nil, errUsageReported
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	fs.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "name":
			opts.nameSet = true
		case "agent":
			opts.agentSet = true
		}
	})

	if opts.id == "" {
		return nil, errors.New("--id is required")
	}
	if opts.source == "" || strings.Contains(opts.source, ":") || strings.Contains(opts.id, ":") {
		return nil, errors.New("--source and --id must not be empty or contain ':'")
	}
	if _, err := url.Parse(opts.bridgeURL); err != nil {
		return nil, fmt.Errorf("invalid bridge URL %q: %w", opts.bridgeURL, err)
	}
	if opts.remove {
		if opts.status != "" {
			return nil, errors.New("--status cannot be used with --remove")
		}
		return opts, nil
	}
	if opts.status == "" {
		return nil, errors.New("--status is required unless --remove is set")
	}
	if !validReportStatuses[opts.status] {
		return nil, fmt.Errorf("--status must be working, blocked, done or idle, not %q", opts.status)
	}
	return opts, nil
}

func buildReportRequest(opts *reportOptions) (*http.Request, error) {
	base := strings.TrimSuffix(opts.bridgeURL, "/")
	if opts.remove {
		query := url.Values{"source": {opts.source}, "id": {opts.id}}
		request, err := http.NewRequest(http.MethodDelete, base+"/report?"+query.Encode(), nil)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Authorization", "Bearer "+opts.token)
		return request, nil
	}

	payload := map[string]string{
		"source": opts.source,
		"id":     opts.id,
		"status": opts.status,
	}
	if opts.nameSet {
		payload["name"] = opts.name
	}
	if opts.agentSet {
		payload["agent"] = opts.agent
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequest(http.MethodPost, base+"/report", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+opts.token)
	return request, nil
}

// explainReportError turns the bridge's status codes into the action that
// fixes them; callers only pass non-200 responses.
func explainReportError(opts *reportOptions, code int, body []byte) error {
	serverMessage := strings.TrimSpace(string(body))
	var payload struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &payload) == nil && payload.Error != "" {
		serverMessage = payload.Error
	}

	switch code {
	case http.StatusUnauthorized:
		return fmt.Errorf("bridge %s rejected the token: check AGENT_MACHI_INGEST_TOKEN", opts.bridgeURL)
	case http.StatusNotFound:
		return fmt.Errorf("ingest is disabled on %s: set AGENT_MACHI_INGEST_TOKEN when starting the bridge", opts.bridgeURL)
	case http.StatusBadRequest:
		return fmt.Errorf("bridge rejected the report: %s", serverMessage)
	default:
		return fmt.Errorf("bridge %s returned %d: %s", opts.bridgeURL, code, serverMessage)
	}
}
