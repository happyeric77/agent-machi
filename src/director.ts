import * as THREE from "three";
import type { Object3D } from "three";
import type { Graph } from "./town/graph/graph.ts";
import { RouteAnimator } from "./animator.ts";
import { ACCENTS, TRAVELLERS, createNameTag, type NameTag } from "./characters.ts";
import { createFadeController, type FadeController } from "./fade.ts";
import { HomeSign, homeSpot } from "./homes.ts";
import { BEACH_SPOTS, beachSpot } from "./beaches.ts";
import { resolveDisplayName } from "./display.ts";
import { logLine } from "./log.ts";
import { planRoute, routeLength, type RouteStep } from "./planner.ts";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentRow {
  pane_id: string;
  name: string | null;
  display_name?: string | null;
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
  display_name?: string | null;
  terminal_title_stripped?: string | null;
  agent: string | null;
  status: AgentStatus;
  at: string;
}

const HOME_POOL = ["P4", "P2", "P1", "P3", "P5", "R1", "R2"] as const;
const STATION_SLOTS = ["S", "S-2", "S-3"] as const;
const BEACH_NODES = ["F-W", "F-E"] as const;
const DEBOUNCE_MS = 3000;
const DOORSTEP_SECONDS = 0.9;

const HOMES_KEY = "agent-machi.homes";
const TRAVELLERS_KEY = "agent-machi.travellers";

interface DoorState {
  kind: "door" | "beach";
  phase: "entering" | "exiting";
  elapsed: number;
  duration: number;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  label?: string;
}

interface Actor {
  paneId: string;
  name: string | null;
  displayName: string;
  agent: string | null;
  traveler: Object3D;
  reportedStatus: AgentStatus | null;
  stableStatus: AgentStatus | null;
  node: string;
  targetNode: string | null;
  moving: boolean;
  inside: boolean;
  door: DoorState | null;
  blockedSlot: string | null;
  beachSpot: string | null;
  atBeachSpot: boolean;
  animator: RouteAnimator;
  fade: FadeController;
  ring: THREE.Mesh;
  tag: NameTag;
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
  private readonly signParent: Object3D;

  private readonly actors = new Map<string, Actor>();
  private readonly extraStatuses = new Map<string, AgentStatus>();
  private readonly blockedOccupancy = new Map<string, string>();
  private readonly beachOccupancy = new Map<string, string>();
  private readonly roster = new Map<string, AgentRow>();
  private readonly homeSigns = new Map<string, HomeSign>();
  private readonly rosterListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: BridgeEvent) => void>();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  private homes: Record<string, number> = loadMap(HOMES_KEY);
  private travellerSlots: Record<string, number> = loadMap(TRAVELLERS_KEY);

  private bridgeUrl = `http://${location.hostname}:8731`;
  private eventSource: EventSource | null = null;

  constructor(
    graph: Graph,
    travelers: Object3D[],
    groundY: number,
    statusElement: HTMLElement,
    signParent: Object3D,
  ) {
    this.graph = graph;
    this.travelers = travelers;
    this.groundY = groundY;
    this.statusElement = statusElement;
    this.signParent = signParent;
  }

  getRoster(): AgentRow[] {
    return [...this.roster.values()];
  }

  getRole(paneId: string): string | null {
    const slot = this.travellerSlots[paneId];
    return Number.isInteger(slot) && slot >= 0 && slot < TRAVELLERS.length
      ? TRAVELLERS[slot]
      : null;
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
      this.setBridgeState("online", "bridge: connected");
      this.refreshSnapshot();
    };
    this.eventSource.onerror = () => {
      this.setBridgeState("offline", "bridge: disconnected");
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
      if (actor.door) this.updateDoor(actor, dtSeconds);
      else if (actor.moving) actor.animator.update(dtSeconds);
    }
    for (const sign of this.homeSigns.values()) sign.update(dtSeconds);
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
      this.setBridgeState("online", "bridge: connected");
    } catch {
      this.setBridgeState("offline", "bridge: disconnected");
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

    for (const row of rows) {
      if (!row?.pane_id) continue;
      const actor = this.actors.get(row.pane_id) ?? this.createActor(row.pane_id, row);
      if (!actor) {
        this.logExtra(row.pane_id, row.name, normalizeStatus(row.agent_status));
        continue;
      }
      actor.name = row.name;
      actor.displayName = resolveDisplayName(row);
      actor.agent = row.agent;
      actor.tag.setText(this.signName(actor));
      this.setStatus(actor, normalizeStatus(row.agent_status));
      this.syncSign(actor);
    }
    this.emitRoster();
  }

  private handleEvent(event: BridgeEvent): void {
    if (!event?.pane_id) return;
    const status = normalizeStatus(event.status);
    const previous = this.roster.get(event.pane_id);
    this.roster.set(event.pane_id, {
      pane_id: event.pane_id,
      name: event.name ?? previous?.name ?? null,
      display_name: event.display_name ?? previous?.display_name ?? null,
      terminal_title_stripped:
        event.terminal_title_stripped ?? previous?.terminal_title_stripped ?? null,
      agent: event.agent ?? previous?.agent ?? null,
      agent_status: status,
      status_since: event.at,
      last_change_seq: previous?.last_change_seq ?? 0,
    });
    for (const listener of this.eventListeners) listener(event);

    const actor = this.actors.get(event.pane_id) ?? this.createActor(event.pane_id, event);
    if (!actor) {
      this.logExtra(event.pane_id, event.name, status);
      this.emitRoster();
      return;
    }
    actor.name = event.name;
    actor.displayName = resolveDisplayName(event);
    actor.agent = event.agent;
    actor.tag.setText(this.signName(actor));
    this.setStatus(actor, status);
    this.syncSign(actor);
    this.emitRoster();
  }

  private removeAgent(paneId: string): void {
    const actor = this.actors.get(paneId);
    if (actor) {
      if (actor.debounceTimer) clearTimeout(actor.debounceTimer);
      if (actor.highlightTimer) clearTimeout(actor.highlightTimer);
      this.releaseBlockedSlot(actor);
      this.releaseBeachSpot(actor);
      actor.atBeachSpot = false;
      actor.moving = false;
      actor.door = null;
      actor.traveler.visible = false;
      actor.fade.dispose();
      actor.ring.removeFromParent();
      actor.ring.geometry.dispose();
      (actor.ring.material as THREE.Material).dispose();
      actor.tag.sprite.removeFromParent();
      actor.tag.dispose();
      this.actors.delete(paneId);
    }
    const sign = this.homeSigns.get(paneId);
    if (sign) {
      sign.dispose();
      this.homeSigns.delete(paneId);
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

  private createActor(
    paneId: string,
    row: { name: string | null; display_name?: string | null; terminal_title_stripped?: string | null; agent: string | null },
  ): Actor | null {
    const slot = this.travellerSlot(paneId);
    if (slot === null) return null;
    const role = TRAVELLERS[slot];
    const displayName = resolveDisplayName({ ...row, pane_id: paneId });
    this.travelers[slot].visible = true;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.26, 0.36, 32),
      new THREE.MeshBasicMaterial({
        color: ACCENTS[role],
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    ring.visible = false;

    const tag = createNameTag(role);

    const actor: Actor = {
      paneId,
      name: row.name,
      displayName,
      agent: row.agent,
      traveler: this.travelers[slot],
      reportedStatus: null,
      stableStatus: null,
      node: "S",
      targetNode: null,
      moving: false,
      inside: false,
      door: null,
      blockedSlot: null,
      beachSpot: null,
      atBeachSpot: false,
      animator: null as unknown as RouteAnimator,
      fade: null as unknown as FadeController,
      ring,
      tag,
      highlightTimer: null,
      debounceTimer: null,
    };
    actor.animator = new RouteAnimator(actor.traveler, this.graph, this.groundY, (nodeId) => {
      this.onNodeReached(actor, nodeId);
    });
    actor.traveler.add(ring, tag.sprite);
    actor.fade = createFadeController(actor.traveler);
    actor.fade.set(1);
    this.actors.set(paneId, actor);
    this.placeAtNode(actor, "S");
    logLine(`${paneId} (${displayName}) first seen, placed at S as ${role}`);
    return actor;
  }

  private travellerSlot(paneId: string): number | null {
    const existing = this.travellerSlots[paneId];
    if (Number.isInteger(existing) && existing >= 0 && existing < this.travelers.length) {
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
    logLine(`${paneId} (${name ?? "agent"}) -> ${status} (not drawn beyond six)`);
  }

  private setStatus(actor: Actor, status: AgentStatus): void {
    if (actor.reportedStatus === status) return;
    actor.reportedStatus = status;
    this.syncSign(actor);
    if (actor.debounceTimer) {
      clearTimeout(actor.debounceTimer);
      actor.debounceTimer = null;
    }

    if (status !== "blocked") this.releaseBlockedSlot(actor);
    if (status === "unknown") {
      logLine(`${actor.paneId} unknown: hold position`);
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

    const wantsHome = status === "working" || status === "done";
    const wantsBeach = status === "idle";
    let target: string | null = null;
    if (wantsHome) {
      target = this.homeFor(actor.paneId);
    } else if (status === "blocked") {
      target = this.acquireBlockedSlot(actor);
    } else if (wantsBeach) {
      target = this.nearestBeach(actor.node);
      if (target) this.acquireBeachSpot(actor, target);
    }

    if (!target) {
      logLine(`${actor.paneId} ${status}: no reachable target`);
      return;
    }

    actor.targetNode = target;
    if (wantsHome) {
      this.ensureHomeSign(actor, target);
    } else if (actor.door?.kind === "door" && actor.door.phase === "entering") {
      this.abortEnter(actor);
    }
    if (!wantsBeach && actor.door?.kind === "beach" && actor.door.phase === "entering") {
      this.abortBeachApproach(actor);
    }

    if (actor.door) {
      logLine(`${actor.paneId} ${status}: new target ${target}; finishing current transition first`);
      return;
    }

    if (actor.inside) {
      if (wantsHome && target === this.getHome(actor.paneId)) return;
      this.beginExit(actor);
      return;
    }

    if (actor.atBeachSpot) {
      if (wantsBeach && target === this.nearestBeach(actor.node)) return;
      this.beginBeachReturn(actor);
      this.releaseBeachSpot(actor);
      return;
    }
    if (!wantsBeach) this.releaseBeachSpot(actor);

    if (wantsHome && actor.node === target && !actor.moving) {
      this.beginEnter(actor);
      return;
    }

    if (wantsBeach && actor.node === target && !actor.moving) {
      this.beginBeachApproach(actor);
      return;
    }

    if (actor.moving) {
      logLine(`${actor.paneId} ${status}: new target ${target}; rerouting at current edge end`);
      return;
    }

    logLine(`${actor.paneId} ${status}: heading to ${target}`);
    this.startRoute(actor);
  }

  private ensureHomeSign(actor: Actor, node: string): void {
    if (this.homeSigns.has(actor.paneId)) return;
    const spot = homeSpot(node);
    if (!spot) {
      logLine(`${actor.paneId}: home ${node} has no doorstep data`);
      return;
    }
    const sign = new HomeSign(
      spot,
      this.groundY,
      this.officeName(actor),
      actor.reportedStatus ?? "unknown",
    );
    this.homeSigns.set(actor.paneId, sign);
    this.signParent.add(sign.group);
    this.syncSign(actor);
  }

  private signName(actor: Actor): string {
    return this.getRole(actor.paneId) ?? actor.displayName;
  }

  private officeName(actor: Actor): string {
    return `${this.signName(actor)} Office`;
  }

  private syncSign(actor: Actor): void {
    const node = this.getHome(actor.paneId);
    if (!node) return;
    this.ensureHomeSign(actor, node);
    const sign = this.homeSigns.get(actor.paneId);
    if (!sign) return;
    sign.setContent(this.officeName(actor), actor.reportedStatus ?? "unknown");
    sign.setLit(actor.inside);
    sign.setDone(actor.reportedStatus === "done");
  }

  private beginEnter(actor: Actor): void {
    if (actor.inside || actor.door) return;
    const homeNode = this.getHome(actor.paneId);
    const spot = homeNode ? homeSpot(homeNode) : null;
    const node = homeNode ? this.graph.nodes.get(homeNode) : null;
    if (!homeNode || !spot || !node) return;
    actor.moving = false;
    actor.door = {
      kind: "door",
      phase: "entering",
      elapsed: 0,
      duration: DOORSTEP_SECONDS,
      fromX: node.worldX,
      fromZ: node.worldZ,
      toX: spot.x,
      toZ: spot.z,
    };
    actor.traveler.visible = true;
    actor.fade.set(1);
    logLine(`${actor.paneId} entering ${homeNode} -> doorstep`);
  }

  private beginExit(actor: Actor): void {
    if (!actor.inside || actor.door) return;
    const homeNode = this.getHome(actor.paneId);
    const spot = homeNode ? homeSpot(homeNode) : null;
    const node = homeNode ? this.graph.nodes.get(homeNode) : null;
    if (!homeNode || !spot || !node) return;
    actor.inside = false;
    actor.moving = false;
    actor.door = {
      kind: "door",
      phase: "exiting",
      elapsed: 0,
      duration: DOORSTEP_SECONDS,
      fromX: spot.x,
      fromZ: spot.z,
      toX: node.worldX,
      toZ: node.worldZ,
    };
    actor.traveler.position.set(spot.x, this.groundY, spot.z);
    actor.traveler.visible = true;
    actor.fade.set(0);
    this.syncSign(actor);
    logLine(`${actor.paneId} leaving ${homeNode} -> street`);
  }

  private abortEnter(actor: Actor): void {
    if (actor.door?.phase !== "entering") return;
    actor.door = null;
    actor.inside = false;
    actor.moving = false;
    actor.traveler.visible = true;
    actor.fade.set(1);
    this.placeAtNode(actor, actor.node);
    this.syncSign(actor);
    logLine(`${actor.paneId} entry aborted; visible again`);
  }

  private updateDoor(actor: Actor, dtSeconds: number): void {
    const door = actor.door;
    if (!door) return;
    door.elapsed += dtSeconds;
    const t = Math.min(1, door.elapsed / door.duration);
    actor.traveler.position.set(
      door.fromX + (door.toX - door.fromX) * t,
      this.groundY,
      door.fromZ + (door.toZ - door.fromZ) * t,
    );

    if (door.kind === "beach") {
      actor.traveler.visible = true;
      actor.fade.set(1);
    } else if (door.phase === "entering") {
      actor.fade.set(t < 0.35 ? 1 : 1 - (t - 0.35) / 0.65);
    } else {
      actor.fade.set(t < 0.65 ? t / 0.65 : 1);
    }

    if (t < 1) return;

    actor.door = null;
    if (door.kind === "beach") {
      if (door.phase === "entering") {
        actor.atBeachSpot = true;
        actor.moving = false;
        logLine(`${actor.paneId} at beach spot ${door.label ?? "?"}`);
      } else {
        actor.atBeachSpot = false;
        this.placeAtNode(actor, actor.node);
        logLine(`${actor.paneId} left beach spot ${door.label ?? "?"}`);
        if (this.isBeachTarget(actor)) this.beginBeachApproach(actor);
        else if (actor.targetNode) this.startRoute(actor);
      }
      return;
    }

    if (door.phase === "entering") {
      actor.inside = true;
      actor.traveler.visible = false;
      actor.fade.set(0);
      this.syncSign(actor);
      logLine(`${actor.paneId} inside home`);
      return;
    }

    actor.inside = false;
    actor.traveler.visible = true;
    actor.fade.set(1);
    this.placeAtNode(actor, actor.node);
    this.syncSign(actor);
    logLine(`${actor.paneId} back on street`);
    if (this.isHomeTarget(actor)) this.beginEnter(actor);
    else if (actor.targetNode) this.startRoute(actor);
  }

  private isHomeTarget(actor: Actor): boolean {
    const status = actor.stableStatus;
    return (status === "working" || status === "done") &&
      actor.targetNode === this.getHome(actor.paneId);
  }

  private isBeachTarget(actor: Actor): boolean {
    return actor.stableStatus === "idle" &&
      !!actor.targetNode &&
      (BEACH_NODES as readonly string[]).includes(actor.targetNode);
  }

  private acquireBeachSpot(actor: Actor, entrance: string): string | null {
    if (actor.beachSpot) {
      const existing = beachSpot(actor.beachSpot);
      if (existing && this.beachOccupancy.get(existing.id) === actor.paneId) return existing.id;
      actor.beachSpot = null;
    }
    const node = this.graph.nodes.get(entrance);
    if (!node) return null;
    const free = BEACH_SPOTS.filter((spot) => !this.beachOccupancy.has(spot.id)).sort((a, b) => {
      const da = Math.hypot(a.x - node.worldX, a.z - node.worldZ);
      const db = Math.hypot(b.x - node.worldX, b.z - node.worldZ);
      return da - db;
    });
    const chosen = free[0];
    if (!chosen) {
      logLine(`${actor.paneId}: no free beach spot`);
      return null;
    }
    this.beachOccupancy.set(chosen.id, actor.paneId);
    actor.beachSpot = chosen.id;
    logLine(`${actor.paneId}: beach spot ${chosen.id} assigned`);
    return chosen.id;
  }

  private releaseBeachSpot(actor: Actor): void {
    if (!actor.beachSpot) return;
    if (this.beachOccupancy.get(actor.beachSpot) === actor.paneId) {
      this.beachOccupancy.delete(actor.beachSpot);
    }
    actor.beachSpot = null;
  }

  private beginBeachApproach(actor: Actor): void {
    if (actor.atBeachSpot || actor.door) return;
    const spot = actor.beachSpot ? beachSpot(actor.beachSpot) : null;
    if (!spot) return;
    const node = this.graph.nodes.get(spot.entrance);
    if (!node) return;
    const distance = Math.hypot(spot.x - node.worldX, spot.z - node.worldZ);
    actor.moving = false;
    actor.door = {
      kind: "beach",
      phase: "entering",
      elapsed: 0,
      duration: Math.max(0.35, distance / 3),
      fromX: node.worldX,
      fromZ: node.worldZ,
      toX: spot.x,
      toZ: spot.z,
      label: spot.id,
    };
    actor.traveler.visible = true;
    actor.fade.set(1);
    logLine(`${actor.paneId} walking to beach spot ${spot.id}`);
  }

  private beginBeachReturn(actor: Actor): void {
    if (!actor.atBeachSpot || actor.door) return;
    const spot = actor.beachSpot ? beachSpot(actor.beachSpot) : null;
    if (!spot) return;
    const node = this.graph.nodes.get(spot.entrance);
    if (!node) return;
    const distance = Math.hypot(spot.x - node.worldX, spot.z - node.worldZ);
    actor.atBeachSpot = false;
    actor.moving = false;
    actor.door = {
      kind: "beach",
      phase: "exiting",
      elapsed: 0,
      duration: Math.max(0.35, distance / 3),
      fromX: spot.x,
      fromZ: spot.z,
      toX: node.worldX,
      toZ: node.worldZ,
      label: spot.id,
    };
    actor.traveler.visible = true;
    actor.fade.set(1);
    logLine(`${actor.paneId} leaving beach spot ${spot.id}`);
  }

  private abortBeachApproach(actor: Actor): void {
    if (actor.door?.kind !== "beach" || actor.door.phase !== "entering") return;
    actor.door = null;
    actor.atBeachSpot = false;
    actor.moving = false;
    actor.traveler.visible = true;
    actor.fade.set(1);
    this.placeAtNode(actor, actor.node);
    logLine(`${actor.paneId} beach approach aborted; back at entrance`);
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
    logLine(`${paneId} assigned home ${HOME_POOL[index]}`);
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
      logLine(`${actor.paneId}: ${actor.node} -> ${actor.targetNode} has no traversable route`);
      actor.moving = false;
      return;
    }
    if (steps.length === 0) {
      actor.node = actor.targetNode;
      actor.moving = false;
      if (this.isHomeTarget(actor)) this.beginEnter(actor);
      else if (this.isBeachTarget(actor)) this.beginBeachApproach(actor);
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
    logLine(`${actor.paneId} arrived at ${nodeId}`);
    if (this.isHomeTarget(actor)) this.beginEnter(actor);
    else if (this.isBeachTarget(actor)) this.beginBeachApproach(actor);
  }

  private placeAtNode(actor: Actor, nodeId: string): void {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return;
    actor.traveler.position.set(node.worldX, this.groundY, node.worldZ);
  }
}
