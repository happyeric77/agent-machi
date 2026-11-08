package bridge

import (
	"path/filepath"
	"testing"
)

func strptr(value string) *string { return &value }

func TestDisplayNamePriorityAndDedupe(t *testing.T) {
	b := New(Config{EventsLog: filepath.Join(t.TempDir(), "events.jsonl")})

	b.agents["named"] = &AgentRow{PaneID: "named", Name: strptr("Explicit"), Agent: strptr("opencode")}
	b.locations["named"] = agentLocation{Cwd: strptr("/tmp/project-a")}
	b.firstSeen["named"] = 1
	b.order = append(b.order, "named")

	b.agents["project"] = &AgentRow{PaneID: "project", Agent: strptr("opencode")}
	b.locations["project"] = agentLocation{ForegroundCwd: strptr("/tmp/project-b")}
	b.firstSeen["project"] = 2
	b.order = append(b.order, "project")

	b.agents["agent-fallback"] = &AgentRow{PaneID: "agent-fallback", Agent: strptr("codex")}
	b.locations["agent-fallback"] = agentLocation{Cwd: strptr("/tmp")}
	b.firstSeen["agent-fallback"] = 3
	b.order = append(b.order, "agent-fallback")

	b.agents["dupe-1"] = &AgentRow{PaneID: "dupe-1", Agent: strptr("opencode")}
	b.locations["dupe-1"] = agentLocation{Cwd: strptr("/tmp/same")}
	b.firstSeen["dupe-1"] = 4
	b.order = append(b.order, "dupe-1")

	b.agents["dupe-2"] = &AgentRow{PaneID: "dupe-2", Agent: strptr("opencode")}
	b.locations["dupe-2"] = agentLocation{Cwd: strptr("/tmp/same")}
	b.firstSeen["dupe-2"] = 5
	b.order = append(b.order, "dupe-2")

	b.refreshDisplayNamesLocked()

	if got := b.agents["named"].DisplayName; got != "Explicit" {
		t.Fatalf("name must win, got %q", got)
	}
	if got := b.agents["project"].DisplayName; got != "project-b" {
		t.Fatalf("cwd basename fallback, got %q", got)
	}
	if got := b.agents["agent-fallback"].DisplayName; got != "codex" {
		t.Fatalf("agent fallback, got %q", got)
	}
	if got := b.agents["dupe-1"].DisplayName; got != "same" {
		t.Fatalf("first duplicate keeps plain name, got %q", got)
	}
	if got := b.agents["dupe-2"].DisplayName; got != "same (2)" {
		t.Fatalf("second duplicate gets suffix, got %q", got)
	}
}

func TestCwdBaseSkipsNonIdentifyingDirectories(t *testing.T) {
	home, _ := filepath.Abs("/Users/example")
	for _, value := range []string{"", "/", "/tmp", "/private/tmp", "/var/tmp", "/Users", "/private", "/home", "/tmp/", home} {
		if got := cwdBase(strptr(value), home); got != "" {
			t.Fatalf("cwdBase(%q) = %q, want empty", value, got)
		}
	}
	if got := cwdBase(strptr("/tmp/agent-machi/"), home); got != "agent-machi" {
		t.Fatalf("cwdBase project = %q", got)
	}
}
