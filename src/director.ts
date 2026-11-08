import * as THREE from "three";
import type { Object3D } from "three";
import type { Graph } from "../station-to-sea/src/game/graph.ts";
import { RouteAnimator } from "./animator.ts";
import { logLine } from "./log.ts";
import { planRoute, routeLength, type RouteStep } from "./planner.ts";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentRow {
  pane_id: string;
  name: string | null;
  terminal_title_stripped?: string | null;
  agent: string | null;
  agent_status: AgentStatus;
  status_since: string;
  last_change_seq: number;
}

export interface BridgeEvent {
  source: string;
  pane_id: string;
  name: string | null;
  terminal_title_stripped?: string | null;
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
  ring: THREE.Mesh;
  highlightTimer: ReturnType<typeof setTimeout> | null;
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
  private readonly roster = new Map<string, AgentRow>();
  private readonly rosterListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: BridgeEvent) => void>();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

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

  getRoster(): AgentRow[] {
    return [...this.roster.values()];
  }

  getRole(paneId: string): "Amber" | "Teal" | null {
    const slot = this.travellerSlots[paneId];
    return slot === 0 ? "Amber" : slot === 1 ? "Teal" : null;
  }

  getHome(paneId: string): string | null {
    const index = this.homes[paneId];
    return Number.isInteger(index) && index >= 0 && index < HOME_POOL.length
      ? HOME_POOL[index]
      : null;
  }

  onRosterChange(listener: () => void): () => void {
    this.rosterListeners.add(listener);
    return () => this.rosterListeners.delete(listener);
  }

  onEvent(listener: (event: BridgeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  highlight(paneId: string): boolean {
    const actor = this.actors.get(paneId);
    if (!actor) return false;
    actor.ring.visible = true;
    if (actor.highlightTimer) clearTimeout(actor.highlightTimer);
    actor.highlightTimer = setTimeout(() => {
      actor.ring.visible = false;
      actor.highlightTimer = null;
    }, 2500);
    return true;
  }

  private emitRoster(): void {
    for (const listener of this.rosterListeners) listener();
  }

  start(bridgeUrl: string): void {
    this.bridgeUrl = bridgeUrl.replace(/\/+$/, "");
    this.refreshSnapshot();
    if (!this.snapshotTimer) {
      this.snapshotTimer = setInterval(() => void this.refreshSnapshot(), 5000);
    }
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
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row?.pane_id) continue;
      seen.add(row.pane_id);
      this.roster.set(row.pane_id, {
        ...row,
        terminal_title_stripped: row.terminal_title_stripped ?? null,
        agent_status: normalizeStatus(row.agent_status),
      });
    }
    for (const paneId of [...this.roster.keys()]) {
      if (!seen.has(paneId)) this.roster.delete(paneId);
    }
    for (const paneId of new Set([
      ...this.actors.keys(),
      ...Object.keys(this.travellerSlots),
      ...Object.keys(this.homes),
    ])) {
      if (!seen.has(paneId)) this.removeAgent(paneId);
    }
    this.emitRoster();

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
    const previous = this.roster.get(event.pane_id);
    this.roster.set(event.pane_id, {
      pane_id: event.pane_id,
      name: event.name ?? previous?.name ?? null,
      terminal_title_stripped:
        event.terminal_title_stripped ?? previous?.terminal_title_stripped ?? null,
      agent: event.agent ?? previous?.agent ?? null,
      agent_status: status,
      status_since: event.at,
      last_change_seq: previous?.last_change_seq ?? 0,
    });
    this.emitRoster();
    for (const listener of this.eventListeners) listener(event);

    const actor = this.actors.get(event.pane_id) ?? this.createActor(event.pane_id, event);
    if (!actor) {
      this.logExtra(event.pane_id, event.name, status);
      return;
    }
    actor.name = event.name;
    actor.agent = event.agent;
    this.setStatus(actor, status);
  }

  private removeAgent(paneId: string): void {
    const actor = this.actors.get(paneId);
    if (actor) {
      if (actor.debounceTimer) clearTimeout(actor.debounceTimer);
      if (actor.highlightTimer) clearTimeout(actor.highlightTimer);
      this.releaseBlockedSlot(actor);
      actor.moving = false;
      actor.traveler.visible = false;
      this.actors.delete(paneId);
    }
    if (paneId in this.travellerSlots) {
      delete this.travellerSlots[paneId];
      saveMap(TRAVELLERS_KEY, this.travellerSlots);
    }
    if (paneId in this.homes) {
      delete this.homes[paneId];
      saveMap(HOMES_KEY, this.homes);
    }
    this.extraStatuses.delete(paneId);
  }

  private createActor(paneId: string, row: { name: string | null; agent: string | null }): Actor | null {
    const slot = this.travellerSlot(paneId);
    if (slot === null) return null;
    this.travelers[slot].visible = true;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.26, 0.36, 32),
      new THREE.MeshBasicMaterial({
        color: slot === 0 ? "#f2b705" : "#3d9bb5",
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    ring.visible = false;

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
      ring,
      highlightTimer: null,
      debounceTimer: null,
    };
    actor.animator = new RouteAnimator(actor.traveler, this.graph, this.groundY, (nodeId) => {
      this.onNodeReached(actor, nodeId);
    });
    actor.traveler.add(ring);
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
