import type { Object3D } from "three";
import type { Graph } from "../station-to-sea/src/game/graph.ts";
import { RouteAnimator } from "./animator.ts";
import { logLine } from "./log.ts";
import { planRoute, routeLength, type RouteStep } from "./planner.ts";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentRow {
  pane_id: string;
  name: string | null;
  agent: string | null;
  agent_status: AgentStatus;
  status_since: string;
  last_change_seq: number;
}

export interface BridgeEvent {
  source: string;
  pane_id: string;
  name: string | null;
  agent: string | null;
  status: AgentStatus;
  at: string;
}

const HOME_POOL = ["P4", "P2", "P1", "P3", "P5", "R1", "R2"] as const;
const STATION_SLOTS = ["S", "S-2", "S-3"] as const;
const BEACH_NODES = ["F-W", "F-E"] as const;
const DEBOUNCE_MS = 3000;

const HOMES_KEY = "agent-machi.homes";
const TRAVELLERS_KEY = "agent-machi.travellers";

interface Actor {
  paneId: string;
  name: string | null;
  agent: string | null;
  traveler: Object3D;
  reportedStatus: AgentStatus | null;
  stableStatus: AgentStatus | null;
  node: string;
  targetNode: string | null;
  moving: boolean;
  blockedSlot: string | null;
  animator: RouteAnimator;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

function normalizeStatus(value: string): AgentStatus {
  return value === "idle" || value === "working" || value === "blocked" || value === "done"
    ? value
    : "unknown";
}

function loadMap(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveMap(key: string, value: Record<string, number>): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: in-memory assignment still works */
  }
}

export class Director {
  private readonly graph: Graph;
  private readonly travelers: Object3D[];
  private readonly groundY: number;
  private readonly statusElement: HTMLElement;

  private readonly actors = new Map<string, Actor>();
  private readonly extraStatuses = new Map<string, AgentStatus>();
  private readonly blockedOccupancy = new Map<string, string>();

  private homes: Record<string, number> = loadMap(HOMES_KEY);
  private travellerSlots: Record<string, number> = loadMap(TRAVELLERS_KEY);

  private bridgeUrl = `http://${location.hostname}:8731`;
  private eventSource: EventSource | null = null;

  constructor(graph: Graph, travelers: Object3D[], groundY: number, statusElement: HTMLElement) {
    this.graph = graph;
    this.travelers = travelers;
    this.groundY = groundY;
    this.statusElement = statusElement;
  }

  start(bridgeUrl: string): void {
    this.bridgeUrl = bridgeUrl.replace(/\/+$/, "");
    this.refreshSnapshot();
    this.eventSource = new EventSource(`${this.bridgeUrl}/events`);
    this.eventSource.onopen = () => {
      this.setBridgeState("online", "bridge: 已連線");
      this.refreshSnapshot();
    };
    this.eventSource.onerror = () => {
      this.setBridgeState("offline", "bridge: 未連線");
    };
    this.eventSource.onmessage = (message) => {
      try {
        this.handleEvent(JSON.parse(message.data) as BridgeEvent);
      } catch (error) {
        logLine(`bad bridge event: ${String(error)}`);
      }
    };
  }

  update(dtSeconds: number): void {
    for (const actor of this.actors.values()) {
      if (actor.moving) actor.animator.update(dtSeconds);
    }
  }

  private setBridgeState(state: "connecting" | "online" | "offline", text: string): void {
    this.statusElement.dataset.state = state;
    this.statusElement.textContent = text;
  }

  private async refreshSnapshot(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${this.bridgeUrl}/snapshot`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rows = (await response.json()) as AgentRow[];
      this.applySnapshot(rows);
      this.setBridgeState("online", "bridge: 已連線");
    } catch {
      this.setBridgeState("offline", "bridge: 未連線");
    } finally {
      clearTimeout(timer);
    }
  }

  private applySnapshot(rows: AgentRow[]): void {
    for (const row of rows) {
      if (!row?.pane_id) continue;
      const actor = this.actors.get(row.pane_id) ?? this.createActor(row.pane_id, row);
      if (!actor) {
        this.logExtra(row.pane_id, row.name, normalizeStatus(row.agent_status));
        continue;
      }
      actor.name = row.name;
      actor.agent = row.agent;
      this.setStatus(actor, normalizeStatus(row.agent_status));
    }
  }

  private handleEvent(event: BridgeEvent): void {
    if (!event?.pane_id) return;
    const status = normalizeStatus(event.status);
    const actor = this.actors.get(event.pane_id) ?? this.createActor(event.pane_id, event);
    if (!actor) {
      this.logExtra(event.pane_id, event.name, status);
      return;
    }
    actor.name = event.name;
    actor.agent = event.agent;
    this.setStatus(actor, status);
  }

  private createActor(paneId: string, row: { name: string | null; agent: string | null }): Actor | null {
    const slot = this.travellerSlot(paneId);
    if (slot === null) return null;

    const actor: Actor = {
      paneId,
      name: row.name,
      agent: row.agent,
      traveler: this.travelers[slot],
      reportedStatus: null,
      stableStatus: null,
      node: "S",
      targetNode: null,
      moving: false,
      blockedSlot: null,
      animator: null as unknown as RouteAnimator,
      debounceTimer: null,
    };
    actor.animator = new RouteAnimator(actor.traveler, this.graph, this.groundY, (nodeId) => {
      this.onNodeReached(actor, nodeId);
    });
    this.actors.set(paneId, actor);
    this.placeAtNode(actor, "S");
    logLine(`${paneId} (${row.name ?? row.agent ?? "agent"}) 第一次偵測到，放在 S，角色 ${slot === 0 ? "Amber" : "Teal"}`);
    return actor;
  }

  private travellerSlot(paneId: string): number | null {
    const existing = this.travellerSlots[paneId];
    if (existing === 0 || existing === 1) {
      const usedByOther = Object.entries(this.travellerSlots).some(
        ([otherPane, slot]) => otherPane !== paneId && slot === existing,
      );
      if (!usedByOther) return existing;
    }

    const taken = new Set(
      Object.entries(this.travellerSlots)
        .filter(([otherPane]) => otherPane !== paneId)
        .map(([, slot]) => slot),
    );
    for (let slot = 0; slot < this.travelers.length; slot += 1) {
      if (!taken.has(slot)) {
        this.travellerSlots[paneId] = slot;
        saveMap(TRAVELLERS_KEY, this.travellerSlots);
        return slot;
      }
    }
    return null;
  }

  private logExtra(paneId: string, name: string | null, status: AgentStatus): void {
    if (this.extraStatuses.get(paneId) === status) return;
    this.extraStatuses.set(paneId, status);
    logLine(`${paneId} (${name ?? "agent"}) -> ${status}（第三位起不畫）`);
  }

  private setStatus(actor: Actor, status: AgentStatus): void {
    if (actor.reportedStatus === status) return;
    actor.reportedStatus = status;
    if (actor.debounceTimer) {
      clearTimeout(actor.debounceTimer);
      actor.debounceTimer = null;
    }

    if (status !== "blocked") this.releaseBlockedSlot(actor);
    if (status === "unknown") {
      logLine(`${actor.paneId} unknown：不移動`);
      return;
    }

    actor.debounceTimer = setTimeout(() => {
      actor.debounceTimer = null;
      if (actor.reportedStatus !== status) return;
      actor.stableStatus = status;
      this.retarget(actor);
    }, DEBOUNCE_MS);
  }

  private retarget(actor: Actor): void {
    const status = actor.stableStatus;
    if (!status || status === "unknown") return;

    let target: string | null = null;
    if (status === "working" || status === "done") {
      target = this.homeFor(actor.paneId);
    } else if (status === "blocked") {
      target = this.acquireBlockedSlot(actor);
    } else if (status === "idle") {
      target = this.nearestBeach(actor.node);
    }

    if (!target) {
      logLine(`${actor.paneId} ${status}: 找不到可走目標`);
      return;
    }

    actor.targetNode = target;

    if (actor.moving) {
      logLine(`${actor.paneId} ${status}: 新目標 ${target}，在目前路段終點改線`);
      return;
    }

    logLine(`${actor.paneId} ${status}: 前往 ${target}`);
    this.startRoute(actor);
  }

  private homeFor(paneId: string): string {
    const existing = this.homes[paneId];
    if (Number.isInteger(existing) && existing >= 0 && existing < HOME_POOL.length) {
      return HOME_POOL[existing];
    }
    const taken = new Set(Object.values(this.homes));
    let index = 0;
    while (index < HOME_POOL.length && taken.has(index)) index += 1;
    if (index >= HOME_POOL.length) index = Object.keys(this.homes).length % HOME_POOL.length;
    this.homes[paneId] = index;
    saveMap(HOMES_KEY, this.homes);
    logLine(`${paneId} 指派家 ${HOME_POOL[index]}`);
    return HOME_POOL[index];
  }

  private acquireBlockedSlot(actor: Actor): string {
    if (actor.blockedSlot) return actor.blockedSlot;
    for (const slot of STATION_SLOTS) {
      if (!this.blockedOccupancy.has(slot)) {
        this.blockedOccupancy.set(slot, actor.paneId);
        actor.blockedSlot = slot;
        return slot;
      }
    }
    return "S";
  }

  private releaseBlockedSlot(actor: Actor): void {
    if (!actor.blockedSlot) return;
    if (this.blockedOccupancy.get(actor.blockedSlot) === actor.paneId) {
      this.blockedOccupancy.delete(actor.blockedSlot);
    }
    actor.blockedSlot = null;
  }

  private nearestBeach(fromNode: string): string | null {
    let best: string | null = null;
    let bestLength = Number.POSITIVE_INFINITY;
    for (const beach of BEACH_NODES) {
      const length = routeLength(this.graph, fromNode, beach);
      if (length < bestLength) {
        bestLength = length;
        best = beach;
      }
    }
    return Number.isFinite(bestLength) ? best : null;
  }

  private startRoute(actor: Actor): void {
    if (!actor.targetNode) return;
    const steps: RouteStep[] | null = planRoute(this.graph, actor.node, actor.targetNode);
    if (steps === null) {
      logLine(`${actor.paneId}: ${actor.node} -> ${actor.targetNode} 沒有可通行路線`);
      actor.moving = false;
      return;
    }
    if (steps.length === 0) {
      actor.node = actor.targetNode;
      actor.moving = false;
      return;
    }
    actor.moving = true;
    actor.animator.start(steps);
  }

  private onNodeReached(actor: Actor, nodeId: string): void {
    actor.node = nodeId;
    if (actor.targetNode && nodeId !== actor.targetNode) {
      this.startRoute(actor);
      return;
    }
    actor.moving = false;
    logLine(`${actor.paneId} 抵達 ${nodeId}`);
  }

  private placeAtNode(actor: Actor, nodeId: string): void {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return;
    actor.traveler.position.set(node.worldX, this.groundY, node.worldZ);
  }
}
