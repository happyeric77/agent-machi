package bridge

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

type subscription struct {
	Type   string `json:"type"`
	PaneID string `json:"pane_id,omitempty"`
}

var globalSubscriptions = []subscription{
	{Type: "pane.agent_detected"},
	{Type: "pane.created"},
	{Type: "pane.closed"},
	{Type: "pane.exited"},
}

func normalizeEventName(name string) string {
	return strings.ReplaceAll(name, ".", "_")
}

func (b *Bridge) StartHerdr() {
	b.reconcileAll()
}

func (b *Bridge) requestOnce(method string, params any) (json.RawMessage, error) {
	conn, err := net.DialTimeout("unix", b.cfg.SocketPath, 8*time.Second)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(8 * time.Second))

	id := fmt.Sprintf("agent-machi-%d", b.requestSeq.Add(1))
	request := map[string]any{"id": id, "method": method, "params": params}
	payload, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(append(payload, '\n')); err != nil {
		return nil, err
	}

	reader := bufio.NewReader(conn)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF && line == "" {
				return nil, fmt.Errorf("Herdr socket closed before response")
			}
			return nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var response struct {
			ID     string `json:"id"`
			Result json.RawMessage
			Error  *struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(line), &response); err != nil {
			continue
		}
		if response.ID != id {
			continue
		}
		if response.Error != nil {
			message := response.Error.Message
			if message == "" {
				message = response.Error.Code
			}
			return nil, fmt.Errorf("%s", message)
		}
		return response.Result, nil
	}
}

func (b *Bridge) closeSubscription(key string) {
	b.mu.Lock()
	conn, ok := b.subs[key]
	if ok {
		delete(b.subs, key)
	}
	b.mu.Unlock()
	if ok {
		_ = conn.Close()
	}
}

func (b *Bridge) closeAllSubscriptions() {
	b.mu.Lock()
	conns := make([]net.Conn, 0, len(b.subs))
	for key, conn := range b.subs {
		conns = append(conns, conn)
		delete(b.subs, key)
	}
	b.mu.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
}

func (b *Bridge) openSubscription(key string, list []subscription) {
	b.mu.Lock()
	if _, exists := b.subs[key]; exists || b.stopping {
		b.mu.Unlock()
		return
	}
	conn, err := net.DialTimeout("unix", b.cfg.SocketPath, 8*time.Second)
	if err != nil {
		b.mu.Unlock()
		fmt.Printf("[bridge] subscription %s error: %v\n", key, err)
		b.scheduleReconcile(500 * time.Millisecond)
		return
	}
	b.subs[key] = conn
	b.mu.Unlock()

	go func() {
		id := fmt.Sprintf("agent-machi-sub-%d", b.requestSeq.Add(1))
		request := map[string]any{
			"id":     id,
			"method": "events.subscribe",
			"params": map[string]any{"subscriptions": list},
		}
		payload, _ := json.Marshal(request)
		if _, err := conn.Write(append(payload, '\n')); err != nil {
			b.subscriptionClosed(key, conn)
			return
		}
		reader := bufio.NewReader(conn)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				b.subscriptionClosed(key, conn)
				return
			}
			line = strings.TrimSpace(line)
			if line != "" {
				b.handleSocketLine(line)
			}
		}
	}()
}

func (b *Bridge) subscriptionClosed(key string, conn net.Conn) {
	b.mu.Lock()
	current, ok := b.subs[key]
	if ok && current == conn {
		delete(b.subs, key)
		ok = true
	} else {
		ok = false
	}
	stopping := b.stopping
	b.mu.Unlock()
	_ = conn.Close()
	if ok && !stopping {
		b.scheduleReconcile(500 * time.Millisecond)
	}
}

func (b *Bridge) handleSocketLine(line string) {
	var message struct {
		ID     string          `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		Event string          `json:"event"`
		Data  json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(line), &message); err != nil {
		fmt.Printf("[bridge] non-JSON socket line: %.120s\n", line)
		return
	}
	if message.ID != "" && len(message.Result) > 0 {
		var result struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(message.Result, &result) == nil && result.Type == "subscription_started" {
			return
		}
	}
	if message.ID != "" && message.Error != nil {
		text := message.Error.Message
		if text == "" {
			text = message.Error.Code
		}
		fmt.Printf("[bridge] subscription rejected: %s\n", text)
		return
	}

	var data eventData
	if len(message.Data) > 0 {
		_ = json.Unmarshal(message.Data, &data)
	}
	eventName := normalizeEventName(message.Event)
	if eventName == "" {
		eventName = normalizeEventName(data.Type)
	}
	if eventName == "" {
		return
	}

	if strings.Contains(eventName, "events_lost") {
		fmt.Println("[bridge] events_lost; resubscribing and reconciling")
		b.scheduleReconcile(0)
		return
	}

	if strings.Contains(eventName, "agent_status_changed") {
		if data.PaneID != "" {
			b.setStatus(data.PaneID, normalizeStatus(data.AgentStatus), data)
		}
		return
	}

	if strings.Contains(eventName, "agent_detected") {
		paneID := data.PaneID
		if paneID == "" {
			return
		}
		if data.Released || data.FinalStatus == "unknown" {
			b.mu.Lock()
			b.removeAgentRowLocked(paneID)
			b.mu.Unlock()
			b.closeSubscription("pane:" + paneID)
			return
		}
		b.openSubscription("pane:"+paneID, []subscription{{Type: "pane.agent_status_changed", PaneID: paneID}})
		b.scheduleReconcile(250 * time.Millisecond)
		return
	}

	if strings.Contains(eventName, "pane_created") {
		if data.PaneID != "" {
			b.openSubscription("pane:"+data.PaneID, []subscription{{Type: "pane.agent_status_changed", PaneID: data.PaneID}})
		}
		b.scheduleReconcile(250 * time.Millisecond)
		return
	}

	if strings.Contains(eventName, "pane_closed") || strings.Contains(eventName, "pane_exited") {
		if data.PaneID == "" {
			return
		}
		b.mu.Lock()
		b.removeAgentRowLocked(data.PaneID)
		b.mu.Unlock()
		b.closeSubscription("pane:" + data.PaneID)
	}
}

func (b *Bridge) setStatus(paneID string, status AgentStatus, data eventData) {
	b.mu.Lock()
	defer b.mu.Unlock()
	at := nowIso()
	row, ok := b.agents[paneID]
	if !ok {
		row = &AgentRow{
			PaneID:             paneID,
			Name:               rawStringPtr(data.Name),
			TerminalTitleStrip: rawStringPtr(data.TerminalTitleStrip),
			Agent:              rawStringPtr(data.Agent),
			AgentStatus:        status,
			StatusSince:        at,
			LastChangeSeq:      rawUint64(data.StateChangeSeq, 0),
		}
		if !rawPresent(data.TerminalTitleStrip) && rawPresent(data.Title) {
			row.TerminalTitleStrip = rawStringPtr(data.Title)
		}
		b.locations[paneID] = agentLocation{
			Cwd:           rawStringPtr(data.Cwd),
			ForegroundCwd: rawStringPtr(data.ForegroundCwd),
		}
		b.markSeenLocked(paneID)
		b.agents[paneID] = row
		b.addOrderLocked(paneID)
		b.refreshDisplayNamesLocked()
		b.publishLocked(row)
		return
	}

	if rawPresent(data.Name) {
		row.Name = rawStringPtr(data.Name)
	}
	if rawPresent(data.TerminalTitleStrip) {
		row.TerminalTitleStrip = rawStringPtr(data.TerminalTitleStrip)
	} else if rawPresent(data.Title) {
		row.TerminalTitleStrip = rawStringPtr(data.Title)
	}
	if rawPresent(data.Agent) && string(data.Agent) != "null" {
		row.Agent = rawStringPtr(data.Agent)
	}
	if rawPresent(data.StateChangeSeq) {
		row.LastChangeSeq = rawUint64(data.StateChangeSeq, row.LastChangeSeq)
	}
	place := b.locations[paneID]
	if rawPresent(data.Cwd) {
		place.Cwd = rawStringPtr(data.Cwd)
	}
	if rawPresent(data.ForegroundCwd) {
		place.ForegroundCwd = rawStringPtr(data.ForegroundCwd)
	}
	b.locations[paneID] = place
	b.refreshDisplayNamesLocked()

	if row.AgentStatus != status {
		row.AgentStatus = status
		row.StatusSince = at
		b.publishLocked(row)
	}
}

func (b *Bridge) syncAgents(snapshotAgents []snapshotAgent) {
	b.mu.Lock()
	defer b.mu.Unlock()
	seen := map[string]bool{}
	at := nowIso()
	changed := make([]*AgentRow, 0)

	for _, info := range snapshotAgents {
		paneID := info.PaneID
		agent, hasAgent := rawString(info.Agent)
		if paneID == "" || !hasAgent || agent == "" {
			continue
		}
		seen[paneID] = true
		status := normalizeStatus(info.AgentStatus)
		b.locations[paneID] = agentLocation{
			Cwd:           rawStringPtr(info.Cwd),
			ForegroundCwd: rawStringPtr(info.ForegroundCwd),
		}
		previous, exists := b.agents[paneID]
		if !exists {
			row := &AgentRow{
				PaneID:             paneID,
				Name:               rawStringPtr(info.Name),
				TerminalTitleStrip: rawStringPtr(info.TerminalTitleStrip),
				Agent:              &agent,
				AgentStatus:        status,
				StatusSince:        at,
				LastChangeSeq:      rawUint64(info.StateChangeSeq, 0),
			}
			if !rawPresent(info.TerminalTitleStrip) && rawPresent(info.TerminalTitle) {
				row.TerminalTitleStrip = rawStringPtr(info.TerminalTitle)
			}
			b.markSeenLocked(paneID)
			b.agents[paneID] = row
			b.addOrderLocked(paneID)
			changed = append(changed, row)
			continue
		}
		if rawPresent(info.Name) {
			previous.Name = rawStringPtr(info.Name)
		}
		if rawPresent(info.TerminalTitleStrip) {
			previous.TerminalTitleStrip = rawStringPtr(info.TerminalTitleStrip)
		} else if rawPresent(info.TerminalTitle) {
			previous.TerminalTitleStrip = rawStringPtr(info.TerminalTitle)
		}
		previous.Agent = &agent
		previous.LastChangeSeq = rawUint64(info.StateChangeSeq, previous.LastChangeSeq)
		if previous.AgentStatus != status {
			previous.AgentStatus = status
			previous.StatusSince = at
			changed = append(changed, previous)
		}
	}

	for _, paneID := range append([]string{}, b.order...) {
		if !seen[paneID] {
			b.removeAgentRowLocked(paneID)
		}
	}
	b.refreshDisplayNamesLocked()
	for _, row := range changed {
		b.publishLocked(row)
	}
}

func (b *Bridge) scheduleReconcile(delay time.Duration) {
	if b.cfg.Fake {
		return
	}
	b.mu.Lock()
	if b.stopping || b.reconcileTimer != nil {
		b.mu.Unlock()
		return
	}
	b.reconcileTimer = time.AfterFunc(delay, func() {
		b.mu.Lock()
		b.reconcileTimer = nil
		stopping := b.stopping
		b.mu.Unlock()
		if !stopping {
			b.reconcileAll()
		}
	})
	b.mu.Unlock()
}

func (b *Bridge) reconcileAll() {
	b.mu.Lock()
	if b.stopping {
		b.mu.Unlock()
		return
	}
	if b.reconciling {
		b.reconcileAgain = true
		b.mu.Unlock()
		return
	}
	b.reconciling = true
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		b.reconciling = false
		again := b.reconcileAgain
		b.reconcileAgain = false
		b.mu.Unlock()
		if again {
			b.scheduleReconcile(250 * time.Millisecond)
		}
	}()

	b.closeAllSubscriptions()
	result, err := b.requestOnce("session.snapshot", map[string]any{})
	if err != nil {
		fmt.Printf("[bridge] reconcile failed: %v\n", err)
		b.mu.Lock()
		delay := b.retryDelay
		b.retryDelay = minDuration(b.retryDelay*2, 30*time.Second)
		b.mu.Unlock()
		b.scheduleReconcile(delay)
		return
	}

	var envelope struct {
		Snapshot *struct {
			Agents []snapshotAgent `json:"agents"`
			Panes  []struct {
				PaneID string `json:"pane_id"`
			} `json:"panes"`
		} `json:"snapshot"`
		Agents []snapshotAgent `json:"agents"`
	}
	if err := json.Unmarshal(result, &envelope); err != nil {
		fmt.Printf("[bridge] reconcile failed: %v\n", err)
		b.scheduleReconcile(500 * time.Millisecond)
		return
	}
	snapshotAgents := envelope.Agents
	paneIDs := map[string]bool{}
	if envelope.Snapshot != nil {
		snapshotAgents = envelope.Snapshot.Agents
		for _, pane := range envelope.Snapshot.Panes {
			if pane.PaneID != "" {
				paneIDs[pane.PaneID] = true
			}
		}
	}
	b.syncAgents(snapshotAgents)

	b.openSubscription("global", globalSubscriptions)
	for _, info := range snapshotAgents {
		if info.PaneID != "" {
			paneIDs[info.PaneID] = true
		}
	}
	for paneID := range paneIDs {
		b.openSubscription("pane:"+paneID, []subscription{{Type: "pane.agent_status_changed", PaneID: paneID}})
	}
	b.mu.Lock()
	b.retryDelay = 500 * time.Millisecond
	b.mu.Unlock()
}

func minDuration(left, right time.Duration) time.Duration {
	if left < right {
		return left
	}
	return right
}
