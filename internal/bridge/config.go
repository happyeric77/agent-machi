package bridge

import (
	"os"
	"path/filepath"
	"strconv"
)

type Config struct {
	Host         string
	Port         int
	Fake         bool
	FakeScenario string
	SocketPath   string
	EventsLog    string
	NoOpen       bool
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
	return Config{
		Host:         host,
		Port:         port,
		Fake:         os.Getenv("FAKE") == "1",
		FakeScenario: scenario,
		SocketPath:   socket,
		EventsLog:    events,
		NoOpen:       os.Getenv("AGENT_MACHI_NO_OPEN") == "1",
	}
}
