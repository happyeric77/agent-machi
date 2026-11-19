package bridge

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

const ingestBodyLimit = 8 << 10

type reportRequest struct {
	Source string `json:"source"`
	ID     string `json:"id"`
	Name   string `json:"name"`
	Agent  string `json:"agent"`
	Status string `json:"status"`
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
		w.Write([]byte("unauthorized"))
		return
	}

	switch r.Method {
	case http.MethodPost:
		body := http.MaxBytesReader(w, r.Body, ingestBodyLimit)
		var req reportRequest
		if err := json.NewDecoder(body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json body")
			return
		}
		row, changed, err := b.applyReport(req, time.Now())
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, map[string]any{
			"ok":      true,
			"pane_id": row.PaneID,
			"status":  row.AgentStatus,
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
		w.Write([]byte("method not allowed"))
	}
}

func writeError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

// applyReport upserts an external agent. A changed status publishes an event;
// an unchanged status is only a heartbeat and stays silent.
func (b *Bridge) applyReport(req reportRequest, now time.Time) (*AgentRow, bool, error) {
	if !validExternalPart(req.Source) {
		return nil, false, errors.New("source must be non-empty and must not contain ':'")
	}
	if !validExternalPart(req.ID) {
		return nil, false, errors.New("id must be non-empty and must not contain ':'")
	}
	if !validReportStatus(req.Status) {
		return nil, false, errors.New("status must be working, blocked, done or idle")
	}
	if len(req.Name) > 128 || len(req.Agent) > 128 {
		return nil, false, errors.New("name and agent are limited to 128 bytes")
	}

	paneID := externalPaneID(req.Source, req.ID)

	b.mu.Lock()
	defer b.mu.Unlock()

	ext, exists := b.external[paneID]
	row := b.agents[paneID]
	if !exists || row == nil {
		if req.Name == "" && req.Agent == "" {
			// Keep the display-name fallback chain intact.
		}
		row = &AgentRow{
			PaneID:        paneID,
			AgentStatus:   AgentStatus(req.Status),
			StatusSince:   nowIso(),
			LastChangeSeq: 0,
		}
		if req.Name != "" {
			name := req.Name
			row.Name = &name
		}
		if req.Agent != "" {
			agent := req.Agent
			row.Agent = &agent
		}
		b.external[paneID] = &externalAgent{source: req.Source, lastSeen: now}
		b.markSeenLocked(paneID)
		b.agents[paneID] = row
		b.addOrderLocked(paneID)
		b.refreshDisplayNamesLocked()
		b.publishLocked(row)
		return row, true, nil
	}

	if req.Name != "" {
		name := req.Name
		row.Name = &name
	}
	if req.Agent != "" {
		agent := req.Agent
		row.Agent = &agent
	}
	ext.lastSeen = now

	changed := row.AgentStatus != AgentStatus(req.Status)
	if changed {
		row.AgentStatus = AgentStatus(req.Status)
		row.StatusSince = nowIso()
	}
	b.refreshDisplayNamesLocked()
	if changed {
		b.publishLocked(row)
	}
	return row, changed, nil
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
