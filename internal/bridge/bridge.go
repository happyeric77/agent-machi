package bridge

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

type Bridge struct {
	cfg  Config
	home string

	mu         sync.Mutex
	agents     map[string]*AgentRow
	order      []string
	locations  map[string]agentLocation
	firstSeen  map[string]int
	seenSeq    int
	sse        map[chan []byte]struct{}
	subs       map[string]net.Conn
	requestSeq atomic.Uint64

	reconcileTimer *time.Timer
	reconciling    bool
	reconcileAgain bool
	stopping       bool
	retryDelay     time.Duration
}

func New(cfg Config) *Bridge {
	home, _ := os.UserHomeDir()
	if dir := filepath.Dir(cfg.EventsLog); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
	return &Bridge{
		cfg:        cfg,
		home:       home,
		agents:     map[string]*AgentRow{},
		locations:  map[string]agentLocation{},
		firstSeen:  map[string]int{},
		sse:        map[chan []byte]struct{}{},
		subs:       map[string]net.Conn{},
		retryDelay: 500 * time.Millisecond,
	}
}

func nowIso() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func (b *Bridge) Snapshot() []AgentRow {
	b.mu.Lock()
	defer b.mu.Unlock()
	rows := make([]AgentRow, 0, len(b.order))
	for _, paneID := range b.order {
		if row, ok := b.agents[paneID]; ok {
			rows = append(rows, *row)
		}
	}
	return rows
}

func (b *Bridge) AgentCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.agents)
}

func (b *Bridge) appendEventLog(event Event) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	file, err := os.OpenFile(b.cfg.EventsLog, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		fmt.Printf("[bridge] cannot append events.jsonl: %v\n", err)
		return
	}
	defer file.Close()
	if _, err := file.Write(append(data, '\n')); err != nil {
		fmt.Printf("[bridge] cannot append events.jsonl: %v\n", err)
	}
}

// publishLocked requires b.mu to be held. It mirrors Node publish().
func (b *Bridge) publishLocked(row *AgentRow) {
	event := Event{
		Source:             "herdr",
		PaneID:             row.PaneID,
		Name:               row.Name,
		DisplayName:        row.DisplayName,
		TerminalTitleStrip: row.TerminalTitleStrip,
		Agent:              row.Agent,
		Status:             row.AgentStatus,
		At:                 nowIso(),
	}
	b.appendEventLog(event)
	data, err := json.Marshal(event)
	if err == nil {
		line := append([]byte("data: "), data...)
		line = append(line, '\n', '\n')
		for client := range b.sse {
			select {
			case client <- line:
			default:
			}
		}
	}
	agent := "?"
	if row.Agent != nil && *row.Agent != "" {
		agent = *row.Agent
	}
	fmt.Printf("[bridge] %s %s -> %s\n", event.PaneID, agent, event.Status)
}

func (b *Bridge) addSSEClient(client chan []byte) {
	b.mu.Lock()
	b.sse[client] = struct{}{}
	b.mu.Unlock()
}

func (b *Bridge) removeSSEClient(client chan []byte) {
	b.mu.Lock()
	delete(b.sse, client)
	b.mu.Unlock()
}

func (b *Bridge) Stop() {
	b.mu.Lock()
	if b.stopping {
		b.mu.Unlock()
		return
	}
	b.stopping = true
	if b.reconcileTimer != nil {
		b.reconcileTimer.Stop()
		b.reconcileTimer = nil
	}
	conns := make([]net.Conn, 0, len(b.subs))
	for key, conn := range b.subs {
		conns = append(conns, conn)
		delete(b.subs, key)
	}
	clients := make([]chan []byte, 0, len(b.sse))
	for client := range b.sse {
		clients = append(clients, client)
		delete(b.sse, client)
	}
	b.mu.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
	for _, client := range clients {
		close(client)
	}
}

// ReadLog mirrors GET /log?limit=N.
func (b *Bridge) ReadLog(limit int) []json.RawMessage {
	events := make([]json.RawMessage, 0)
	data, err := os.ReadFile(b.cfg.EventsLog)
	if err != nil {
		if !os.IsNotExist(err) {
			fmt.Printf("[bridge] cannot read events.jsonl: %v\n", err)
		}
		return events
	}
	for _, line := range splitLines(string(data)) {
		if line == "" {
			continue
		}
		var value any
		if err := json.Unmarshal([]byte(line), &value); err != nil {
			continue
		}
		switch value.(type) {
		case map[string]any, []any:
			events = append(events, json.RawMessage(line))
		}
	}
	if len(events) > limit {
		events = events[len(events)-limit:]
	}
	return events
}

func splitLines(text string) []string {
	lines := make([]string, 0)
	start := 0
	for index, char := range text {
		if char == '\n' {
			lines = append(lines, text[start:index])
			start = index + 1
		}
	}
	if start < len(text) {
		lines = append(lines, text[start:])
	}
	return lines
}
