package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const ingestBodyLimit = 8 << 10

// optString tells an absent field apart from an explicit null: only a plain
// string is accepted, so "name": null is a validation error, not a silent clear.
type optString struct {
	Set   bool
	Value string
}

func (o *optString) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		return errors.New("null is not allowed here; omit the field or send a string")
	}
	o.Set = true
	return json.Unmarshal(data, &o.Value)
}

// reportRequest uses pointers so "absent" and "null" stay distinguishable from
// an explicit empty string, which clears the optional field.
type reportRequest struct {
	Source *string   `json:"source"`
	ID     *string   `json:"id"`
	Name   optString `json:"name"`
	Agent  optString `json:"agent"`
	Status *string   `json:"status"`
}

// externalAgent tracks the lease for one ingested agent. last_seen is separate
// from the row's status_since: a heartbeat renews the lease without touching
// the status timestamp, the SSE stream or the events log.
type externalAgent struct {
	source   string
	lastSeen time.Time
}

func externalPaneID(source, id string) string {
	return "ext:" + source + ":" + id
}

// validExternalPart rejects the separator so (a:b, c) and (a, b:c) can never
// resolve to the same pane id.
func validExternalPart(value string) bool {
	return value != "" && len(value) <= 128 && !strings.Contains(value, ":")
}

func validReportStatus(status string) bool {
	switch status {
	case "working", "blocked", "done", "idle":
		return true
	}
	return false
}

// serveReport handles POST and DELETE /report itself, before the GET-only
// dispatcher. With no token configured the route does not exist (404).
func (b *Bridge) serveReport(w http.ResponseWriter, r *http.Request) {
	if b.cfg.IngestToken == "" {
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+b.cfg.IngestToken {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("unauthorized"))
		return
	}

	switch r.Method {
	case http.MethodPost:
		req, err := decodeReport(w, r)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		paneID, status, changed, err := b.applyReport(req, time.Now())
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, map[string]any{
			"ok":      true,
			"pane_id": paneID,
			"status":  status,
			"changed": changed,
		})
	case http.MethodDelete:
		source := r.URL.Query().Get("source")
		id := r.URL.Query().Get("id")
		if err := b.removeExternal(source, id); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
		_, _ = w.Write([]byte("method not allowed"))
	}
}

// decodeReport reads one complete JSON object within the body cap. Trailing
// data and unknown fields are rejected so a report is exactly what it claims.
func decodeReport(w http.ResponseWriter, r *http.Request) (reportRequest, error) {
	var req reportRequest
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, ingestBodyLimit))
	if err != nil {
		return req, errors.New("body must be a single JSON object under 8 KiB")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return req, errors.New("invalid json body")
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return req, errors.New("body must contain exactly one JSON object")
	}
	return req, nil
}

func writeError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func validateReport(req reportRequest) (source, id, status string, name, agent *string, err error) {
	if req.Source == nil || !validExternalPart(*req.Source) {
		return "", "", "", nil, nil, errors.New("source must be non-empty and must not contain ':'")
	}
	if req.ID == nil || !validExternalPart(*req.ID) {
		return "", "", "", nil, nil, errors.New("id must be non-empty and must not contain ':'")
	}
	if req.Status == nil || !validReportStatus(*req.Status) {
		return "", "", "", nil, nil, errors.New("status must be working, blocked, done or idle")
	}
	if req.Name.Set && len(req.Name.Value) > 128 {
		return "", "", "", nil, nil, errors.New("name is limited to 128 bytes")
	}
	if req.Agent.Set && len(req.Agent.Value) > 128 {
		return "", "", "", nil, nil, errors.New("agent is limited to 128 bytes")
	}
	if req.Name.Set {
		value := req.Name.Value
		name = &value
	}
	if req.Agent.Set {
		value := req.Agent.Value
		agent = &value
	}
	return *req.Source, *req.ID, *req.Status, name, agent, nil
}

// applyReport upserts an external agent and returns copies of the response
// fields taken under the lock. A changed status publishes an event and replaces
// the optional fields; an unchanged status renews only the lease.
func (b *Bridge) applyReport(req reportRequest, now time.Time) (paneID, status string, changed bool, err error) {
	source, id, want, name, agent, err := validateReport(req)
	if err != nil {
		return "", "", false, err
	}
	paneID = externalPaneID(source, id)

	b.mu.Lock()
	defer b.mu.Unlock()

	ext, exists := b.external[paneID]
	row := b.agents[paneID]
	if !exists || row == nil {
		row = &AgentRow{
			PaneID:      paneID,
			Name:        name,
			Agent:       agent,
			AgentStatus: AgentStatus(want),
			StatusSince: nowIso(),
		}
		b.external[paneID] = &externalAgent{source: source, lastSeen: now}
		b.markSeenLocked(paneID)
		b.agents[paneID] = row
		b.addOrderLocked(paneID)
		b.refreshDisplayNamesLocked()
		b.publishLocked(row)
		return paneID, want, true, nil
	}

	ext.lastSeen = now
	if row.AgentStatus == AgentStatus(want) {
		return paneID, want, false, nil
	}

	row.AgentStatus = AgentStatus(want)
	row.StatusSince = nowIso()
	row.Name = name
	row.Agent = agent
	b.refreshDisplayNamesLocked()
	b.publishLocked(row)
	return paneID, want, true, nil
}

// removeExternal mirrors a closed Herdr pane: the row disappears from the next
// snapshot, and nothing is published to SSE or the events log.
func (b *Bridge) removeExternal(source, id string) error {
	if !validExternalPart(source) || !validExternalPart(id) {
		return errors.New("source and id must be non-empty and must not contain ':'")
	}
	paneID := externalPaneID(source, id)
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.external[paneID]; !ok {
		return nil
	}
	delete(b.external, paneID)
	b.removeAgentRowLocked(paneID)
	return nil
}

// expireExternal drops external agents whose lease ran out. Like removal it
// only changes what the next snapshot contains.
func (b *Bridge) expireExternal(now time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for paneID, ext := range b.external {
		if now.Sub(ext.lastSeen) >= b.cfg.IngestTTL {
			delete(b.external, paneID)
			b.removeAgentRowLocked(paneID)
		}
	}
}

func (b *Bridge) expireLoop() {
	interval := b.cfg.IngestTTL / 4
	if interval < 10*time.Millisecond {
		interval = 10 * time.Millisecond
	}
	if interval > 30*time.Second {
		interval = 30 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-b.ingestDone:
			return
		case now := <-ticker.C:
			b.expireExternal(now)
		}
	}
}
