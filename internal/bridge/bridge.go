package bridge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
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
	external   map[string]*externalAgent
	ingestDone chan struct{}
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
	b := &Bridge{
		cfg:        cfg,
		home:       home,
		agents:     map[string]*AgentRow{},
		locations:  map[string]agentLocation{},
		firstSeen:  map[string]int{},
		external:   map[string]*externalAgent{},
		ingestDone: make(chan struct{}),
		sse:        map[chan []byte]struct{}{},
		subs:       map[string]net.Conn{},
		retryDelay: 500 * time.Millisecond,
	}
	if cfg.IngestToken != "" {
		go b.expireLoop()
	}
	return b
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
	line := append(data, '\n')
	if int64(len(line)) > eventsLogMaxBytes {
		fmt.Println("[bridge] events.jsonl: event larger than the cap, dropping it")
		return
	}
	if err := b.makeRoomInEventLog(int64(len(line))); err != nil {
		fmt.Printf("[bridge] events.jsonl rotation failed, dropping event: %v\n", err)
		return
	}
	file, err := os.OpenFile(b.cfg.EventsLog, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		fmt.Printf("[bridge] cannot append events.jsonl: %v\n", err)
		return
	}
	defer file.Close()
	if _, err := file.Write(line); err != nil {
		fmt.Printf("[bridge] cannot append events.jsonl: %v\n", err)
	}
}

// eventsLogMaxBytes keeps a long-running demo pod from growing its log
// forever; ReadLog only caps the response, not the file.
const eventsLogMaxBytes = 1 << 20

// makeRoomInEventLog guarantees the pending line still fits the cap: it keeps
// the newest whole rows within both half the cap and the room left after the
// pending line. Every caller holds b.mu, so the rewrite cannot race another
// append. A failed rotation is returned to the caller, which then drops the
// event instead of appending past the cap.
func (b *Bridge) makeRoomInEventLog(pending int64) error {
	info, err := os.Stat(b.cfg.EventsLog)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	size := int64(0)
	if err == nil {
		size = info.Size()
	}
	if size+pending <= eventsLogMaxBytes {
		return nil
	}
	data, err := os.ReadFile(b.cfg.EventsLog)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	// A row is only whole when a newline closes it; a truncated tail is dropped.
	if end := bytes.LastIndexByte(data, '\n'); end >= 0 {
		data = data[:end]
	} else {
		data = nil
	}
	budget := int64(eventsLogMaxBytes / 2)
	if room := int64(eventsLogMaxBytes) - pending; room < budget {
		budget = room
	}
	if budget < 0 {
		budget = 0
	}
	payload := strings.Join(newestLinesWithin(splitLines(string(data)), budget), "\n")
	if payload != "" {
		payload += "\n"
	}
	temp := b.cfg.EventsLog + ".tmp"
	if err := os.WriteFile(temp, []byte(payload), 0o644); err != nil {
		return err
	}
	if err := os.Rename(temp, b.cfg.EventsLog); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}

// newestLinesWithin keeps the newest whole lines that fit budget bytes.
func newestLinesWithin(lines []string, budget int64) []string {
	start := len(lines)
	total := int64(0)
	for start > 0 {
		size := int64(len(lines[start-1]) + 1)
		if total+size > budget {
			break
		}
		total += size
		start--
	}
	return lines[start:]
}

// publishLocked requires b.mu to be held. It mirrors Node publish().
func (b *Bridge) publishLocked(row *AgentRow) {
	source := "herdr"
	if ext, ok := b.external[row.PaneID]; ok {
		source = ext.source
	}
	event := Event{
		Source:             source,
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
	if b.ingestDone != nil {
		close(b.ingestDone)
	}
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
