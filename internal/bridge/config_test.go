package bridge

import "testing"

func TestConfigMode(t *testing.T) {
	cases := []struct {
		name   string
		config Config
		want   Mode
	}{
		{"tokenless local", Config{}, ModeLocalHerdr},
		{"tokenless fake", Config{Fake: true}, ModeFake},
		{"non-empty token", Config{IngestToken: "secret"}, ModeExternal},
		{"token beats fake", Config{Fake: true, IngestToken: "secret"}, ModeExternal},
		// A whitespace-only token enables /report today, so it selects
		// external mode too. The decision never trims.
		{"whitespace token", Config{IngestToken: " "}, ModeExternal},
		{"token beats everything", Config{Fake: true, IngestToken: " ", FakeScenario: "demo"}, ModeExternal},
	}
	for _, test := range cases {
		if got := test.config.Mode(); got != test.want {
			t.Errorf("%s: Mode() = %v, want %v", test.name, got, test.want)
		}
	}
}
