import * as THREE from "three";
import type { Object3D } from "three";
import type { Graph } from "./town/graph/graph.ts";
import { RouteAnimator } from "./animator.ts";
import { createCharacter, createNameTag, lookFor, stableHash, type Look, type NameTag } from "./characters.ts";
import { createFadeController, type FadeController } from "./fade.ts";
import { StatusBadgeSprite } from "./badge.ts";
import { HomeSign, homeSpot } from "./homes.ts";
import { pickAreaSpot, spotById, type AreaName, type AreaSpot } from "./areas.ts";
import { resolveDisplayName } from "./display.ts";
import { logLine } from "./log.ts";
import { planRoute, type RouteStep } from "./planner.ts";

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
const DEBOUNCE_MS = 3000;
const DOORSTEP_SECONDS = 0.9;

/** Residents drawn as characters. The Roster still lists everyone. */
export const VISIBLE_CAP = 24;

/**
 * Above this many residents the name tags are hidden: a tag is 1.75 world units
 * wide and area spots sit 0.55 apart, so a full town turns the tags into one
 * black band that hides the characters. The Roster and the highlight ring carry
 * the names instead. Below it the town looks exactly as it did with the cast.
 */
const TAG_LIMIT = 8;
/** Badge height with the tag shown, and the tag's clearance above it. */
const BADGE_Y = 1.52;
const TAG_GAP = 0.46;

/** Whether a resident's name tag is drawn at this town size. */
export function tagVisibleFor(actorCount: number, highlighted: boolean): boolean {
  return actorCount <= TAG_LIMIT || highlighted;
}

/**
 * Whether a status that wants a house should try to take one now. A resident
 * working from the work area keeps that spot through `working -> done`: the
 * green check belongs over the resident at its task, not on a door it was
 * handed by a vacancy that opened mid-task. A vacancy is taken on the next
 * task, when the resident is not already in place.
 */
export function claimsHomeFor(status: AgentStatus, housed: boolean, atWorkSpot: boolean): boolean {
  if (status !== "working" && status !== "done") return false;
  return housed || !atWorkSpot;
}

const HOMES_KEY = "agent-machi.homes";

interface DoorState {
  kind: "door" | "spot";
  phase: "entering" | "exiting";
  elapsed: number;
  duration: number;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  spotId?: string;
}

interface Actor {
  paneId: string;
  name: string | null;
  displayName: string;
  agent: string | null;
  look: Look;
  hash: number;
  traveler: THREE.Group;
  reportedStatus: AgentStatus | null;
  stableStatus: AgentStatus | null;
  node: string;
  targetNode: string | null;
  moving: boolean;
  inside: boolean;
  door: DoorState | null;
  areaSpot: string | null;
  atSpot: boolean;
  animator: RouteAnimator;
  fade: FadeController;
  ring: THREE.Mesh;
  tag: NameTag;
  showTag: boolean;
  badge: StatusBadgeSprite;
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

function disposeCharacter(character: Object3D): void {
  character.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const paint = mesh.material;
    if (Array.isArray(paint)) paint.forEach((entry) => entry.dispose());
    else paint?.dispose();
  });
  character.removeFromParent();
}

export class Director {
  private readonly graph: Graph;
  private readonly groundY: number;
  private readonly statusElement: HTMLElement;
  private readonly signParent: Object3D;

  private readonly actors = new Map<string, Actor>();
  private readonly extraStatuses = new Map<string, AgentStatus>();
  private readonly spotOccupancy = new Map<string, string>();
  private readonly roster = new Map<string, AgentRow>();
  private readonly homeSigns = new Map<string, HomeSign>();
  private readonly rosterListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: BridgeEvent) => void>();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  private homes: Record<string, number> = loadMap(HOMES_KEY);

  private bridgeUrl = `http://${location.hostname}:8731`;
  private eventSource: EventSource | null = null;

  constructor(
    graph: Graph,
    groundY: number,
    statusElement: HTMLElement,
    signParent: Object3D,
  ) {
    this.graph = graph;
    this.groundY = groundY;
    this.statusElement = statusElement;
    this.signParent = signParent;
  }

  getRoster(): AgentRow[] {
    return [...this.roster.values()];
  }

  /**
   * Drawn characters and where they stand, for the placement checks. `settled`
   * is false while a resident is mid-walk or mid-doorstep; residents queue
   * through shared graph nodes while walking, so only standings are asserted.
   */
  getPositions(): { paneId: string; x: number; z: number; settled: boolean }[] {
    const placed: { paneId: string; x: number; z: number; settled: boolean }[] = [];
    for (const actor of this.actors.values()) {
      if (!actor.traveler.visible) continue;
      placed.push({
        paneId: actor.paneId,
        x: actor.traveler.position.x,
        z: actor.traveler.position.z,
        settled: !actor.moving && !actor.door,
      });
    }
    return placed;
  }

  /** Colour name for a resident, derived from its pane_id alone. */
  getRole(paneId: string): string | null {
    return lookFor(paneId).torso.name;
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
    actor.showTag = true;
    if (actor.highlightTimer) clearTimeout(actor.highlightTimer);
    actor.highlightTimer = setTimeout(() => {
      actor.ring.visible = false;
      actor.showTag = false;
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
      this.syncHeadBadge(actor);
      this.syncTag(actor);
      actor.badge.update(dtSeconds);
    }
    for (const sign of this.homeSigns.values()) sign.update(dtSeconds);
  }

  /**
   * Name tags survive a small town but not a full one: at the cap they cover
   * each other and the characters. A highlighted resident always shows its tag.
   * A hidden tag takes its height with it, so the status badge drops to just
   * over the hat instead of hanging in the air where the tag used to be.
   */
  private syncTag(actor: Actor): void {
    const drawn = tagVisibleFor(this.actors.size, actor.showTag);
    actor.tag.sprite.visible = drawn && actor.traveler.visible && !actor.inside;
    actor.badge.sprite.position.y = drawn ? BADGE_Y : BADGE_Y - TAG_GAP;
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
    for (const paneId of new Set([...this.actors.keys(), ...Object.keys(this.homes)])) {
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
      this.releaseSpot(actor);
      actor.atSpot = false;
      actor.moving = false;
      actor.door = null;
      actor.fade.dispose();
      actor.ring.removeFromParent();
      actor.ring.geometry.dispose();
      (actor.ring.material as THREE.Material).dispose();
      actor.tag.sprite.removeFromParent();
      actor.tag.dispose();
      actor.badge.dispose();
      disposeCharacter(actor.traveler);
      this.actors.delete(paneId);
    }
    const sign = this.homeSigns.get(paneId);
    if (sign) {
      sign.dispose();
      this.homeSigns.delete(paneId);
    }
    if (paneId in this.homes) {
      delete this.homes[paneId];
      saveMap(HOMES_KEY, this.homes);
    }
    this.extraStatuses.delete(paneId);
  }

  private createActor(
    paneId: string,
    row: {
      name: string | null;
      display_name?: string | null;
      terminal_title_stripped?: string | null;
      agent: string | null;
    },
  ): Actor | null {
    if (this.actors.size >= VISIBLE_CAP) return null;
    const look = lookFor(paneId);
    const hash = stableHash(paneId);
    const displayName = resolveDisplayName({ ...row, pane_id: paneId });
    const traveler = createCharacter(look);
    this.signParent.add(traveler);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.26, 0.36, 32),
      new THREE.MeshBasicMaterial({
        color: look.torso.hex,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    ring.visible = false;

    const tag = createNameTag(look.torso.name);
    tag.sprite.position.y = 1.02;
    const badge = new StatusBadgeSprite(["!", "check", "work"], 0.36);
    badge.sprite.position.set(0, BADGE_Y, 0.02);
    badge.sprite.renderOrder = 4;

    const actor: Actor = {
      paneId,
      name: row.name,
      displayName,
      agent: row.agent,
      look,
      hash,
      traveler,
      reportedStatus: null,
      stableStatus: null,
      node: "S",
      targetNode: null,
      moving: false,
      inside: false,
      door: null,
      areaSpot: null,
      atSpot: false,
      animator: null as unknown as RouteAnimator,
      fade: null as unknown as FadeController,
      ring,
      tag,
      showTag: false,
      badge,
      highlightTimer: null,
      debounceTimer: null,
    };
    actor.animator = new RouteAnimator(traveler, this.graph, this.groundY, (nodeId) => {
      this.onNodeReached(actor, nodeId);
    });
    traveler.add(ring, tag.sprite);
    actor.fade = createFadeController(traveler);
    traveler.add(badge.sprite);
    actor.fade.set(1);
    this.actors.set(paneId, actor);
    this.placeAtNode(actor, "S");
    logLine(`${paneId} (${displayName}) first seen, placed at S as ${look.torso.name}`);
    return actor;
  }

  private logExtra(paneId: string, name: string | null, status: AgentStatus): void {
    if (this.extraStatuses.get(paneId) === status) return;
    this.extraStatuses.set(paneId, status);
    logLine(`${paneId} (${name ?? "agent"}) -> ${status} (not drawn beyond ${VISIBLE_CAP})`);
  }

  private setStatus(actor: Actor, status: AgentStatus): void {
    if (actor.reportedStatus === status) return;
    actor.reportedStatus = status;
    this.syncSign(actor);
    if (actor.debounceTimer) {
      clearTimeout(actor.debounceTimer);
      actor.debounceTimer = null;
    }

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
    const standing = actor.atSpot && actor.areaSpot ? spotById(actor.areaSpot) : null;
    let area: AreaName | null =
      status === "idle" ? "beach" : status === "blocked" ? "station" : null;

    const housed = this.getHome(actor.paneId) !== null;
    const held = actor.areaSpot ? spotById(actor.areaSpot) : null;
    const home = claimsHomeFor(status, housed, held?.area === "worksite")
      ? this.homeFor(actor.paneId)
      : null;
    let target: string | null = home;
    if (!target) {
      if (wantsHome) area = "worksite";
      if (!area) {
        logLine(`${actor.paneId} ${status}: no reachable target`);
        return;
      }
      // A resident standing in another area walks back first; its new spot is
      // chosen when the return finishes, so the old one is released cleanly
      // instead of being overwritten by the new assignment.
      if (standing && standing.area !== area) {
        this.releaseSpot(actor);
        actor.targetNode = actor.node;
        this.beginSpotReturn(actor, standing);
        logLine(`${actor.paneId} ${status}: leaving ${standing.id} for the ${area}`);
        return;
      }
      const spot = this.acquireSpot(actor, area);
      if (!spot) {
        logLine(`${actor.paneId} ${status}: no free ${area} spot`);
        return;
      }
      target = spot.entrance;
    } else {
      this.releaseSpot(actor);
    }

    actor.targetNode = target;
    if (home) {
      this.ensureHomeSign(actor, home);
    } else if (actor.door?.kind === "door" && actor.door.phase === "entering") {
      this.abortEnter(actor);
    }
    // An approach to a spot the resident no longer holds is abandoned, never
    // finished: finishing it would park the pawn on a spot another resident
    // may already own.
    if (actor.door?.kind === "spot" && actor.door.phase === "entering") {
      if (actor.door.spotId !== actor.areaSpot) this.abortSpotApproach(actor);
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

    if (actor.atSpot) {
      if (!standing) {
        actor.atSpot = false;
      } else if (
        area === standing.area &&
        actor.areaSpot === standing.id &&
        target === standing.entrance
      ) {
        // Already standing where this status wants it.
        return;
      } else {
        // Includes the case where a house happened to be reachable from the
        // entrance this resident is standing at: the spot is released, so it
        // still has to walk back before it can enter.
        this.beginSpotReturn(actor, standing);
        this.releaseSpot(actor);
        return;
      }
    }

    if (actor.node === target && !actor.moving) {
      if (home === target) this.beginEnter(actor);
      else if (actor.areaSpot) this.beginSpotApproach(actor);
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
    sign.setBadge(actor.reportedStatus ?? "");
  }

  private syncHeadBadge(actor: Actor): void {
    const enteringHome = actor.inside || actor.door?.kind === "door";
    const outdoors = actor.traveler.visible && !enteringHome;
    const status = actor.reportedStatus ?? "";
    // Housed residents show work by walking into their office; only the
    // houseless need a head badge to say "working".
    const housed = this.getHome(actor.paneId) !== null;
    actor.badge.setStatus(outdoors && !(housed && status === "working") ? status : "");
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

    if (door.kind === "spot") {
      actor.traveler.visible = true;
      actor.fade.set(1);
    } else if (door.phase === "entering") {
      actor.fade.set(t < 0.35 ? 1 : 1 - (t - 0.35) / 0.65);
    } else {
      actor.fade.set(t < 0.65 ? t / 0.65 : 1);
    }

    if (t < 1) return;

    actor.door = null;
    if (door.kind === "spot") {
      const spot = door.spotId ? spotById(door.spotId) : null;
      if (door.phase === "entering") {
        if (door.spotId !== actor.areaSpot) {
          // The status moved on while this walk was in flight. Do not settle
          // on a spot the resident no longer holds: another resident may own it.
          actor.moving = false;
          this.placeAtNode(actor, actor.node);
          logLine(`${actor.paneId} spot ${door.spotId ?? "?"} no longer wanted`);
          this.retarget(actor);
          return;
        }
        actor.atSpot = true;
        actor.moving = false;
        actor.traveler.position.set(spot?.x ?? door.toX, spot?.y ?? this.groundY, spot?.z ?? door.toZ);
        logLine(`${actor.paneId} at spot ${door.spotId ?? "?"}`);
      } else {
        actor.atSpot = false;
        this.placeAtNode(actor, actor.node);
        logLine(`${actor.paneId} left spot ${door.spotId ?? "?"}`);
        // Re-decide from the entrance: the resident may need a different area
        // now, and retarget is the one place that allocates spots.
        this.retarget(actor);
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

  private acquireSpot(actor: Actor, area: AreaName): ReturnType<typeof spotById> {
    if (actor.areaSpot) {
      const existing = spotById(actor.areaSpot);
      if (existing && existing.area === area && this.spotOccupancy.get(existing.id) === actor.paneId) {
        return existing;
      }
      this.releaseSpot(actor);
    }
    const taken = new Set(this.spotOccupancy.keys());
    const spot = pickAreaSpot(area, actor.hash, taken);
    if (!spot) return null;
    this.spotOccupancy.set(spot.id, actor.paneId);
    actor.areaSpot = spot.id;
    logLine(`${actor.paneId}: ${area} spot ${spot.id} assigned`);
    return spot;
  }

  private releaseSpot(actor: Actor): void {
    if (!actor.areaSpot) return;
    if (this.spotOccupancy.get(actor.areaSpot) === actor.paneId) {
      this.spotOccupancy.delete(actor.areaSpot);
    }
    actor.areaSpot = null;
  }

  private beginSpotApproach(actor: Actor): void {
    if (actor.atSpot || actor.door) return;
    const spot = actor.areaSpot ? spotById(actor.areaSpot) : null;
    if (!spot) return;
    const node = this.graph.nodes.get(spot.entrance);
    if (!node) return;
    const distance = Math.hypot(spot.x - node.worldX, spot.z - node.worldZ);
    actor.moving = false;
    actor.door = {
      kind: "spot",
      phase: "entering",
      elapsed: 0,
      duration: Math.max(0.35, distance / 3),
      fromX: node.worldX,
      fromZ: node.worldZ,
      toX: spot.x,
      toZ: spot.z,
      spotId: spot.id,
    };
    actor.traveler.visible = true;
    actor.fade.set(1);
    logLine(`${actor.paneId} walking to spot ${spot.id}`);
  }

  private beginSpotReturn(actor: Actor, from: AreaSpot): void {
    if (!actor.atSpot || actor.door) return;
    const spot = from;
    const node = this.graph.nodes.get(spot.entrance);
    if (!node) return;
    const distance = Math.hypot(spot.x - node.worldX, spot.z - node.worldZ);
    actor.atSpot = false;
    actor.moving = false;
    actor.door = {
      kind: "spot",
      phase: "exiting",
      elapsed: 0,
      duration: Math.max(0.35, distance / 3),
      fromX: spot.x,
      fromZ: spot.z,
      toX: node.worldX,
      toZ: node.worldZ,
      spotId: spot.id,
    };
    actor.traveler.visible = true;
    actor.fade.set(1);
    logLine(`${actor.paneId} leaving spot ${spot.id}`);
  }

  private abortSpotApproach(actor: Actor): void {
    if (actor.door?.kind !== "spot" || actor.door.phase !== "entering") return;
    actor.door = null;
    actor.atSpot = false;
    actor.moving = false;
    actor.traveler.visible = true;
    actor.fade.set(1);
    this.placeAtNode(actor, actor.node);
    logLine(`${actor.paneId} spot approach aborted; back at entrance`);
  }

  /**
   * A home, or null once the pool is exhausted. Owners are never evicted and
   * no resident wraps around onto an occupied home.
   */
  private homeFor(paneId: string): string | null {
    const existing = this.homes[paneId];
    if (Number.isInteger(existing) && existing >= 0 && existing < HOME_POOL.length) {
      return HOME_POOL[existing];
    }
    const taken = new Set(Object.values(this.homes));
    let index = 0;
    while (index < HOME_POOL.length && taken.has(index)) index += 1;
    if (index >= HOME_POOL.length) return null;
    this.homes[paneId] = index;
    saveMap(HOMES_KEY, this.homes);
    logLine(`${paneId} assigned home ${HOME_POOL[index]}`);
    return HOME_POOL[index];
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
      else if (actor.areaSpot) this.beginSpotApproach(actor);
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
    else if (actor.areaSpot) this.beginSpotApproach(actor);
  }

  private placeAtNode(actor: Actor, nodeId: string): void {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return;
    actor.traveler.position.set(node.worldX, this.groundY, node.worldZ);
  }
}
