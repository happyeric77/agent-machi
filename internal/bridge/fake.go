package bridge

import "time"

const fakeDefaultCwd = "/Users/example/Projects/agent-machi"

func strPtr(value string) *string { return &value }

func (b *Bridge) StartFake() {
	makeAgent := func(paneID string, name *string, cwd ...string) *AgentRow {
		place := fakeDefaultCwd
		if len(cwd) > 0 {
			place = cwd[0]
		}
		b.mu.Lock()
		row := &AgentRow{
			PaneID:        paneID,
			Name:          name,
			Agent:         strPtr("opencode"),
			AgentStatus:   StatusIdle,
			StatusSince:   nowIso(),
			LastChangeSeq: 0,
		}
		b.locations[paneID] = agentLocation{Cwd: strPtr(place), ForegroundCwd: strPtr(place)}
		b.markSeenLocked(paneID)
		b.agents[paneID] = row
		b.addOrderLocked(paneID)
		b.refreshDisplayNamesLocked()
		b.mu.Unlock()
		return row
	}

	setFakeStatus := func(row *AgentRow, status AgentStatus) {
		b.mu.Lock()
		row.AgentStatus = status
		row.StatusSince = nowIso()
		row.LastChangeSeq++
		b.publishLocked(row)
		b.mu.Unlock()
	}

	at := func(delay time.Duration, row *AgentRow, status AgentStatus) {
		time.AfterFunc(delay, func() { setFakeStatus(row, status) })
	}

	switch b.cfg.FakeScenario {
	case "signnames":
		paneID := makeAgent("w7:p2", nil)
		longName := makeAgent("fake:p-long", strPtr("Wakamiya Coffee Roaster"))
		at(1500*time.Millisecond, paneID, StatusWorking)
		at(1500*time.Millisecond, longName, StatusWorking)
		return

	case "dupe":
		a := makeAgent("fake:p1", nil)
		c := makeAgent("fake:p2", nil)
		at(1500*time.Millisecond, a, StatusWorking)
		at(2500*time.Millisecond, c, StatusWorking)
		return

	case "panelnames":
		a := makeAgent("fake:p1", nil)
		c := makeAgent("fake:p2", nil)
		d := makeAgent("fake:p3", nil, "/tmp")
		e := makeAgent("fake:p4", nil, "/tmp/agent-a")
		f := makeAgent("fake:p5", nil, "/tmp/agent-b")
		g := makeAgent("fake:p6", nil, "/tmp/agent-c")
		h := makeAgent("fake:p7", nil, "/tmp/runwarden")
		at(1500*time.Millisecond, a, StatusWorking)
		at(2500*time.Millisecond, c, StatusWorking)
		at(3500*time.Millisecond, d, StatusWorking)
		at(4500*time.Millisecond, e, StatusWorking)
		at(5500*time.Millisecond, f, StatusWorking)
		at(6500*time.Millisecond, g, StatusWorking)
		at(7500*time.Millisecond, h, StatusWorking)
		return
	}

	p1 := makeAgent("fake:p1", strPtr("Fake Agent"))

	switch b.cfg.FakeScenario {
	case "flip":
		at(1500*time.Millisecond, p1, StatusWorking)
		at(3500*time.Millisecond, p1, StatusDone)
		at(12000*time.Millisecond, p1, StatusIdle)

	case "blocked2":
		p2 := makeAgent("fake:p2", strPtr("Fake Agent B"))
		at(1500*time.Millisecond, p1, StatusBlocked)
		at(8000*time.Millisecond, p2, StatusBlocked)
		at(16000*time.Millisecond, p1, StatusWorking)
		at(30000*time.Millisecond, p1, StatusBlocked)

	case "roster":
		p2 := makeAgent("fake:p2", strPtr("Fake Agent B"))
		p3 := makeAgent("fake:p3", strPtr("Fake Agent C"))
		at(1500*time.Millisecond, p1, StatusWorking)
		at(4500*time.Millisecond, p2, StatusWorking)
		at(7500*time.Millisecond, p3, StatusWorking)
		at(14000*time.Millisecond, p1, StatusBlocked)
		at(17000*time.Millisecond, p3, StatusDone)
		at(20000*time.Millisecond, p2, StatusBlocked)
		at(26000*time.Millisecond, p1, StatusWorking)
		at(32000*time.Millisecond, p2, StatusDone)
		at(35000*time.Millisecond, p3, StatusIdle)

	case "cast":
		p2 := makeAgent("fake:p2", strPtr("Fake Agent B"))
		p3 := makeAgent("fake:p3", strPtr("Fake Agent C"))
		p4 := makeAgent("fake:p4", strPtr("Fake Agent D"))
		at(1500*time.Millisecond, p1, StatusWorking)
		at(2500*time.Millisecond, p2, StatusWorking)
		at(3500*time.Millisecond, p3, StatusWorking)
		at(4500*time.Millisecond, p4, StatusWorking)
		at(18000*time.Millisecond, p2, StatusBlocked)
		at(22000*time.Millisecond, p3, StatusIdle)
		at(26000*time.Millisecond, p4, StatusDone)
		at(30000*time.Millisecond, p2, StatusWorking)

	case "home4":
		p2 := makeAgent("fake:p2", strPtr("Fake Agent B"))
		p3 := makeAgent("fake:p3", strPtr("Fake Agent C"))
		p4 := makeAgent("fake:p4", strPtr("Fake Agent D"))
		at(1500*time.Millisecond, p1, StatusWorking)
		at(2500*time.Millisecond, p2, StatusWorking)
		at(3500*time.Millisecond, p3, StatusWorking)
		at(4500*time.Millisecond, p4, StatusWorking)

	case "beach3":
		p2 := makeAgent("fake:p2", strPtr("Fake Agent B"))
		p3 := makeAgent("fake:p3", strPtr("Fake Agent C"))
		at(1500*time.Millisecond, p1, StatusWorking)
		at(2500*time.Millisecond, p2, StatusWorking)
		at(3500*time.Millisecond, p3, StatusWorking)
		at(12000*time.Millisecond, p1, StatusIdle)
		at(12000*time.Millisecond, p2, StatusIdle)
		at(13000*time.Millisecond, p3, StatusIdle)
		at(30000*time.Millisecond, p1, StatusWorking)
		time.AfterFunc(32000*time.Millisecond, func() {
			p4 := makeAgent("fake:p4", strPtr("Fake Agent D"))
			setFakeStatus(p4, StatusWorking)
			time.AfterFunc(4000*time.Millisecond, func() { setFakeStatus(p4, StatusIdle) })
		})

	case "castreuse":
		p2 := makeAgent("fake:p2", strPtr("Fake Agent B"))
		p3 := makeAgent("fake:p3", strPtr("Fake Agent C"))
		p4 := makeAgent("fake:p4", strPtr("Fake Agent D"))
		at(1500*time.Millisecond, p1, StatusWorking)
		at(2500*time.Millisecond, p2, StatusWorking)
		at(3500*time.Millisecond, p3, StatusWorking)
		at(4500*time.Millisecond, p4, StatusWorking)
		time.AfterFunc(10000*time.Millisecond, func() {
			b.mu.Lock()
			delete(b.agents, "fake:p3")
			b.mu.Unlock()
		})
		time.AfterFunc(35000*time.Millisecond, func() {
			at(0, makeAgent("fake:p5", strPtr("Fake Agent E")), StatusWorking)
		})

	case "home":
		var cycle func()
		cycle = func() {
			at(0, p1, StatusWorking)
			at(16000*time.Millisecond, p1, StatusBlocked)
			at(32000*time.Millisecond, p1, StatusDone)
			at(48000*time.Millisecond, p1, StatusIdle)
			time.AfterFunc(64000*time.Millisecond, cycle)
		}
		time.AfterFunc(8000*time.Millisecond, cycle)

	case "homeblock":
		at(10000*time.Millisecond, p1, StatusWorking)
		at(15000*time.Millisecond, p1, StatusBlocked)

	default:
		script := []AgentStatus{StatusWorking, StatusBlocked, StatusWorking, StatusDone, StatusIdle}
		var advance func(step int)
		advance = func(step int) {
			if step >= len(script) {
				return
			}
			setFakeStatus(p1, script[step])
			if step+1 < len(script) {
				time.AfterFunc(10000*time.Millisecond, func() { advance(step + 1) })
			}
		}
		time.AfterFunc(1500*time.Millisecond, func() { advance(0) })
	}
}
