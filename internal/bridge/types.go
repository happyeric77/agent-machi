package bridge

import "encoding/json"

type AgentStatus string

const (
	StatusIdle    AgentStatus = "idle"
	StatusWorking AgentStatus = "working"
	StatusBlocked AgentStatus = "blocked"
	StatusDone    AgentStatus = "done"
	StatusUnknown AgentStatus = "unknown"
)

func normalizeStatus(value string) AgentStatus {
	switch AgentStatus(value) {
	case StatusIdle, StatusWorking, StatusBlocked, StatusDone, StatusUnknown:
		return AgentStatus(value)
	default:
		return StatusUnknown
	}
}

// AgentRow is the /snapshot row shape. Keep the JSON field order and nulls
// identical to the Node bridge.
type AgentRow struct {
	PaneID             string      `json:"pane_id"`
	Name               *string     `json:"name"`
	DisplayName        string      `json:"display_name"`
	TerminalTitleStrip *string     `json:"terminal_title_stripped"`
	Agent              *string     `json:"agent"`
	AgentStatus        AgentStatus `json:"agent_status"`
	StatusSince        string      `json:"status_since"`
	LastChangeSeq      uint64      `json:"last_change_seq"`
}

type Event struct {
	Source             string      `json:"source"`
	PaneID             string      `json:"pane_id"`
	Name               *string     `json:"name"`
	DisplayName        string      `json:"display_name"`
	TerminalTitleStrip *string     `json:"terminal_title_stripped"`
	Agent              *string     `json:"agent"`
	Status             AgentStatus `json:"status"`
	At                 string      `json:"at"`
}

type agentLocation struct {
	Cwd           *string
	ForegroundCwd *string
}

type eventData struct {
	PaneID             string          `json:"pane_id"`
	AgentStatus        string          `json:"agent_status"`
	Name               json.RawMessage `json:"name"`
	TerminalTitleStrip json.RawMessage `json:"terminal_title_stripped"`
	Title              json.RawMessage `json:"title"`
	Agent              json.RawMessage `json:"agent"`
	StateChangeSeq     json.RawMessage `json:"state_change_seq"`
	Cwd                json.RawMessage `json:"cwd"`
	ForegroundCwd      json.RawMessage `json:"foreground_cwd"`
	Released           bool            `json:"released"`
	FinalStatus        string          `json:"final_status"`
	Type               string          `json:"type"`
}

type snapshotAgent struct {
	PaneID             string          `json:"pane_id"`
	Name               json.RawMessage `json:"name"`
	TerminalTitleStrip json.RawMessage `json:"terminal_title_stripped"`
	TerminalTitle      json.RawMessage `json:"terminal_title"`
	Agent              json.RawMessage `json:"agent"`
	AgentStatus        string          `json:"agent_status"`
	StateChangeSeq     json.RawMessage `json:"state_change_seq"`
	Cwd                json.RawMessage `json:"cwd"`
	ForegroundCwd      json.RawMessage `json:"foreground_cwd"`
}

func rawPresent(raw json.RawMessage) bool {
	return len(raw) > 0
}

func rawString(raw json.RawMessage) (string, bool) {
	if !rawPresent(raw) || string(raw) == "null" {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func rawStringPtr(raw json.RawMessage) *string {
	value, ok := rawString(raw)
	if !ok {
		return nil
	}
	return &value
}

func rawUint64(raw json.RawMessage, fallback uint64) uint64 {
	if !rawPresent(raw) || string(raw) == "null" {
		return fallback
	}
	var value uint64
	if err := json.Unmarshal(raw, &value); err != nil {
		return fallback
	}
	return value
}
