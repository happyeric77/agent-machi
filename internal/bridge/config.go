package bridge

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Mode is the one feeding source for a bridge process.
type Mode int

const (
	ModeLocalHerdr Mode = iota
	ModeFake
	ModeExternal
)

// Mode applies the fixed precedence external > FAKE > local Herdr. External
// mode is exactly the condition that enables /report: a non-empty raw token.
func (c Config) Mode() Mode {
	if c.IngestToken != "" {
		return ModeExternal
	}
	if c.Fake {
		return ModeFake
	}
	return ModeLocalHerdr
}

type Config struct {
	Host         string
	Port         int
	Fake         bool
	FakeScenario string
	SocketPath   string
	EventsLog    string
	NoOpen       bool
	// IngestToken enables POST/DELETE /report when non-empty; unset means the
	// route behaves as if it did not exist.
	IngestToken string
	// IngestTTL is how long an external agent may stay silent before it is
	// removed through the same path as a closed Herdr pane.
	IngestTTL time.Duration
}

func ConfigFromEnv() Config {
	home, _ := os.UserHomeDir()
	port := 8731
	if raw := os.Getenv("PORT"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			port = parsed
		}
	}
	host := os.Getenv("HOST")
	if host == "" {
		host = "0.0.0.0"
	}
	socket := os.Getenv("HERDR_SOCKET_PATH")
	if socket == "" {
		session := os.Getenv("HERDR_SESSION")
		if session != "" && session != "default" {
			socket = filepath.Join(home, ".config", "herdr", "sessions", session, "herdr.sock")
		} else {
			socket = filepath.Join(home, ".config", "herdr", "herdr.sock")
		}
	}
	events := os.Getenv("AGENT_MACHI_EVENTS_LOG")
	if events == "" {
		events = filepath.Join(home, ".local", "share", "agent-machi", "events.jsonl")
	}
	scenario := os.Getenv("FAKE_SCENARIO")
	if scenario == "" {
		scenario = "default"
	}
	ingestTTL := 15 * time.Minute
	if raw := os.Getenv("AGENT_MACHI_INGEST_TTL_SECONDS"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			ingestTTL = time.Duration(parsed) * time.Second
		}
	}
	return Config{
		Host:         host,
		Port:         port,
		Fake:         os.Getenv("FAKE") == "1",
		FakeScenario: scenario,
		SocketPath:   socket,
		EventsLog:    events,
		NoOpen:       os.Getenv("AGENT_MACHI_NO_OPEN") == "1",
		IngestToken:  os.Getenv("AGENT_MACHI_INGEST_TOKEN"),
		IngestTTL:    ingestTTL,
	}
}
