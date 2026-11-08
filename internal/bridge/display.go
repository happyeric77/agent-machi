package bridge

import (
	"fmt"
	"path/filepath"
	"strings"
)

func clean(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func (b *Bridge) markSeenLocked(paneID string) {
	if _, ok := b.firstSeen[paneID]; !ok {
		b.seenSeq++
		b.firstSeen[paneID] = b.seenSeq
	}
}

func cwdBase(raw *string, home string) string {
	if raw == nil {
		return ""
	}
	value := strings.TrimRight(strings.TrimSpace(*raw), "/")
	if value == "" || value == "/" {
		return ""
	}
	if value == home {
		return ""
	}
	switch value {
	case "/tmp", "/private/tmp", "/var/tmp", "/Users", "/private", "/home":
		return ""
	}
	base := filepath.Base(value)
	if base == "" || base == "." || base == "/" || base == "tmp" {
		return ""
	}
	return base
}

func (b *Bridge) baseDisplayNameLocked(row *AgentRow) string {
	if named := clean(row.Name); named != "" {
		return named
	}
	if place, ok := b.locations[row.PaneID]; ok {
		for _, cwd := range []*string{place.ForegroundCwd, place.Cwd} {
			if base := cwdBase(cwd, b.home); base != "" {
				return base
			}
		}
	}
	if agent := clean(row.Agent); agent != "" {
		return agent
	}
	return row.PaneID
}

func (b *Bridge) refreshDisplayNamesLocked() {
	ordered := make([]*AgentRow, 0, len(b.order))
	for _, paneID := range b.order {
		if row, ok := b.agents[paneID]; ok {
			ordered = append(ordered, row)
		}
	}
	sortAgentRows(ordered, b.firstSeen)
	used := map[string]int{}
	for _, row := range ordered {
		base := b.baseDisplayNameLocked(row)
		used[base]++
		if used[base] == 1 {
			row.DisplayName = base
		} else {
			row.DisplayName = fmt.Sprintf("%s (%d)", base, used[base])
		}
	}
}

func sortAgentRows(rows []*AgentRow, firstSeen map[string]int) {
	// Stable insertion sort keeps equal first-seen rows in table order.
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0; j-- {
			left := firstSeen[rows[j-1].PaneID]
			right := firstSeen[rows[j].PaneID]
			if left <= right {
				break
			}
			rows[j-1], rows[j] = rows[j], rows[j-1]
		}
	}
}

func (b *Bridge) addOrderLocked(paneID string) {
	for _, existing := range b.order {
		if existing == paneID {
			return
		}
	}
	b.order = append(b.order, paneID)
}

func (b *Bridge) removeOrderLocked(paneID string) {
	for index, existing := range b.order {
		if existing == paneID {
			b.order = append(b.order[:index], b.order[index+1:]...)
			return
		}
	}
}

func (b *Bridge) removeAgentRowLocked(paneID string) {
	delete(b.agents, paneID)
	delete(b.locations, paneID)
	delete(b.firstSeen, paneID)
	b.removeOrderLocked(paneID)
	b.refreshDisplayNamesLocked()
}
