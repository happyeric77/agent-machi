package bridge

import "testing"

func TestNormalizeEventName(t *testing.T) {
	cases := map[string]string{
		"pane.agent_status_changed": "pane_agent_status_changed",
		"pane.agent_detected":       "pane_agent_detected",
		"pane.created":              "pane_created",
		"pane.closed":               "pane_closed",
		"pane.exited":               "pane_exited",
		"pane_agent_status_changed": "pane_agent_status_changed",
	}
	for input, want := range cases {
		if got := normalizeEventName(input); got != want {
			t.Fatalf("normalizeEventName(%q) = %q, want %q", input, got, want)
		}
	}
}
