import type { AgentRow, BridgeEvent, Director } from "./director.ts";
import { resolveDisplayName } from "./display.ts";
import { statusColor } from "./status.ts";

const STATUS_LABELS: Record<string, string> = {
  idle: "idle",
  working: "working",
  blocked: "blocked",
  done: "done",
  unknown: "unknown",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function durationSince(iso: string): string {
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export class RosterPanel {
  private readonly root = el("aside", "panel roster");
  private readonly toggle = el("button", "panel-toggle");
  private readonly count = el("span", "panel-count");
  private readonly list = el("div", "roster-list");
  private readonly note = el("p", "roster-note");
  private readonly durations = new Map<string, HTMLElement>();
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private collapsed = false;

  constructor(private readonly director: Director) {
    this.root.append(this.toggle, this.list, this.note);
    this.toggle.type = "button";
    this.toggle.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    this.director.onRosterChange(() => this.render());
    this.render();
    setInterval(() => this.tickDurations(), 1000);
    document.body.append(this.root);
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.root.classList.toggle("is-collapsed", collapsed);
    this.toggle.setAttribute("aria-expanded", String(!collapsed));
    this.updateHeader();
  }

  private updateHeader(): void {
    this.toggle.replaceChildren(
      document.createTextNode("Agents "),
      this.count,
      document.createTextNode(this.collapsed ? " ▸" : " ▾"),
    );
  }

  private render(): void {
    const rows = this.director.getRoster();
    this.count.textContent = `(${rows.length})`;
    this.updateHeader();
    this.list.replaceChildren();
    this.durations.clear();

    for (const row of rows) {
      const item = el("button", "roster-row");
      item.type = "button";
      item.dataset.status = row.agent_status;

      const role = this.director.getRole(row.pane_id);
      const top = el("span", "roster-top");
      const badge = el("span", `role-badge ${role ? `role-${role.toLowerCase()}` : "role-log"}`);
      badge.textContent = role ?? "log only";
      const name = el("span", "roster-name");
      name.textContent = resolveDisplayName(row);
      top.append(badge, name);

      const meta = el("span", "roster-meta");
      const dot = el("span", "status-dot");
      dot.style.background = statusColor(row.agent_status);
      dot.style.boxShadow =
        row.agent_status === "blocked" ? `0 0 0 3px ${statusColor("blocked")}2e` : "none";
      const status = el("span", "status-text");
      status.textContent = STATUS_LABELS[row.agent_status] ?? row.agent_status;
      const duration = el("span", "status-duration");
      duration.textContent = durationSince(row.status_since);
      this.durations.set(row.pane_id, duration);
      meta.append(dot, status, duration);

      const sub = el("span", "roster-sub");
      const agent = el("span", "");
      agent.textContent = row.agent ?? "agent ?";
      const home = el("span", "");
      const assigned = this.director.getHome(row.pane_id);
      home.textContent = assigned ? `Home ${assigned}` : "Home unassigned";
      sub.append(agent, home);

      item.append(top, meta, sub);
      item.addEventListener("click", () => {
        const highlighted = this.director.highlight(row.pane_id);
        this.showNote(
          highlighted
            ? `Located ${role ?? resolveDisplayName(row)}`
            : `${resolveDisplayName(row)} has no character`,
        );
      });
      this.list.append(item);
    }
  }

  private tickDurations(): void {
    for (const row of this.director.getRoster()) {
      const element = this.durations.get(row.pane_id);
      if (element) element.textContent = durationSince(row.status_since);
    }
  }

  private showNote(text: string): void {
    this.note.textContent = text;
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.note.textContent = "";
      this.noteTimer = null;
    }, 2500);
  }
}

export class LogPanel {
  private readonly root = el("section", "panel log-panel");
  private readonly toggle = el("button", "panel-toggle");
  private readonly count = el("span", "panel-count");
  private readonly list = el("ol", "log-list");
  private readonly entries: BridgeEvent[] = [];
  private readonly known = new Set<string>();
  private readonly lastStatus = new Map<string, string>();
  private readonly pending: BridgeEvent[] = [];
  private historyLoaded = false;
  private collapsed = false;
  private stickToBottom = true;
  private static readonly MAX_ENTRIES = 500;

  constructor(private readonly director: Director, bridgeUrl: string) {
    this.root.append(this.toggle, this.list);
    this.toggle.type = "button";
    this.toggle.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    this.list.addEventListener("scroll", () => {
      this.stickToBottom =
        this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 24;
    });
    this.director.onEvent((event) => this.accept(event));
    void this.loadHistory(bridgeUrl);
    document.body.append(this.root);
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.root.classList.toggle("is-collapsed", collapsed);
    this.toggle.setAttribute("aria-expanded", String(!collapsed));
    this.updateHeader();
  }

  private updateHeader(): void {
    this.count.textContent = `(${this.entries.length})`;
    this.toggle.replaceChildren(
      document.createTextNode("Log "),
      this.count,
      document.createTextNode(this.collapsed ? " ▸" : " ▾"),
    );
  }

  private async loadHistory(bridgeUrl: string): Promise<void> {
    try {
      const response = await fetch(`${bridgeUrl.replace(/\/+$/, "")}/log?limit=200`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rows = (await response.json()) as BridgeEvent[];
      for (const event of rows) this.add(event);
    } catch {
      // A bridge without /log or a cold log file is not fatal.
    }
    this.historyLoaded = true;
    for (const event of this.pending.splice(0)) this.add(event);
    this.renderAll();
  }

  private accept(event: BridgeEvent): void {
    if (!event?.pane_id || !event.at) return;
    if (!this.historyLoaded) {
      this.pending.push(event);
      return;
    }
    if (!this.add(event)) return;
    const stick = this.stickToBottom;
    this.list.append(this.renderEntry(event));
    this.updateHeader();
    if (stick) this.list.scrollTop = this.list.scrollHeight;
  }

  private add(event: BridgeEvent): boolean {
    const key = `${event.pane_id}|${event.status}|${event.at}`;
    if (this.known.has(key)) return false;
    this.known.add(key);
    this.entries.push(event);
    if (this.entries.length > LogPanel.MAX_ENTRIES) {
      const removed = this.entries.shift();
      if (removed) this.known.delete(`${removed.pane_id}|${removed.status}|${removed.at}`);
      this.list.firstElementChild?.remove();
    }
    return true;
  }

  private renderAll(): void {
    this.lastStatus.clear();
    this.list.replaceChildren();
    for (const event of this.entries) this.list.append(this.renderEntry(event));
    this.updateHeader();
    if (this.stickToBottom) this.list.scrollTop = this.list.scrollHeight;
  }

  private renderEntry(event: BridgeEvent): HTMLLIElement {
    const item = el("li", "log-entry");
    item.dataset.status = event.status;

    const time = el("time", "log-time");
    const parsed = new Date(event.at);
    time.textContent = Number.isNaN(parsed.getTime())
      ? event.at
      : parsed.toLocaleTimeString("en-GB", { hour12: false });

    const name = el("span", "log-name");
    name.textContent = resolveDisplayName(event);

    const change = el("span", "log-change");
    change.style.color = statusColor(event.status);
    const previous = this.lastStatus.get(event.pane_id);
    change.textContent =
      previous && previous !== event.status
        ? `${previous} → ${event.status}`
        : `detected · ${event.status}`;
    this.lastStatus.set(event.pane_id, event.status);

    item.append(time, name, change);
    return item;
  }
}
