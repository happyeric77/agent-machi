import * as THREE from "three";
import { applyAction, getAvailableJunctionOptions } from "./state.ts";
import type { GameState, GameAction, PlayerId, TraversalStep } from "./state.ts";
import type { OutgoingEdgeOption } from "./graph.ts";
import { MAP_GROUND_Y } from "../map/scene.ts";

export interface TraversalWaypoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface CachedFloorMesh {
  mesh: THREE.Mesh;
  box: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  triangles: Array<[[number, number, number], [number, number, number], [number, number, number]]>;
}

function getObjectPath(o: THREE.Object3D): string {
  if (!o.parent) return o.name || "Scene";
  const index = o.parent.children.indexOf(o);
  return getObjectPath(o.parent) + "/" + (o.name || o.type) + "[" + index + "]";
}

function isDescendantOf(obj: THREE.Object3D, target: THREE.Object3D): boolean {
  let curr: THREE.Object3D | null = obj;
  while (curr) {
    if (curr === target) return true;
    curr = curr.parent;
  }
  return false;
}

function isVisible(o: THREE.Object3D | null): boolean {
  return !o || (o.visible && isVisible(o.parent));
}

function isFloorMesh(mesh: THREE.Mesh, box: THREE.Box3, path: string): boolean {
  if (box.max.y > 0.650001 || box.max.y <= 0.3) return false;
  if (/rail|clearance/i.test(path)) return false;
  const leafName = (mesh.name || path.split("/").pop() || "").toLowerCase();
  if (/foam|water|sea surface/i.test(leafName)) return false;
  return true;
}

export class Presenter {
  private readonly state: GameState;
  private readonly meshes: Map<PlayerId, THREE.Group>;
  private readonly scene: THREE.Group;
  private readonly parentScene: THREE.Scene;
  private cachedFloors: CachedFloorMesh[] = [];
  private isAnimating: boolean = false;
  private onStateChange: ((state: GameState, isAnimating: boolean) => void) | null = null;
  private animationQueue: { playerId: PlayerId; waypoints: TraversalWaypoint[]; onComplete: () => void } | null = null;
  private currentWaypointIndex: number = 0;
  private lastAnimTime: number = 0;
  private processedTraceIndex: number = 0;
  public readonly recordedTrace: Array<{ playerId: PlayerId; waypoints: TraversalWaypoint[] }> = [];

  constructor(
    state: GameState,
    travelerMeshes: [THREE.Group, THREE.Group],
    parentScene: THREE.Scene,
    onStateChange: (state: GameState, isAnimating: boolean) => void,
  ) {
    this.state = state;
    this.parentScene = parentScene;
    this.onStateChange = onStateChange;
    this.meshes = new Map<PlayerId, THREE.Group>([
      ["Amber", travelerMeshes[0]],
      ["Teal", travelerMeshes[1]],
    ]);

    this.rebuildFloorCache();

    this.scene = new THREE.Group();
    this.scene.name = "StationToSea_GameplayLayer";
    parentScene.add(this.scene);

    this.createBoardWaypointMarkers();
    this.syncMeshesImmediate();
    this.notify();
  }

  public rebuildFloorCache(): void {
    this.cachedFloors = [];
    this.parentScene.updateMatrixWorld(true);

    const travelerMeshesList = Array.from(this.meshes.values());

    this.parentScene.traverse(obj => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (!isVisible(obj)) return;
      for (const tMesh of travelerMeshesList) {
        if (isDescendantOf(obj, tMesh)) return;
      }
      if (this.scene && isDescendantOf(obj, this.scene)) return;

      const path = getObjectPath(obj);
      const box = new THREE.Box3().setFromObject(obj, true);
      if (!isFloorMesh(obj, box, path)) return;

      const posAttr = obj.geometry?.getAttribute("position");
      if (!posAttr) return;

      const indexAttr = obj.geometry.getIndex();
      const matrix = obj.matrixWorld;
      const vA = new THREE.Vector3();
      const vB = new THREE.Vector3();
      const vC = new THREE.Vector3();
      const triangles: Array<[[number, number, number], [number, number, number], [number, number, number]]> = [];

      if (indexAttr) {
        for (let i = 0; i < indexAttr.count; i += 3) {
          const iA = indexAttr.getX(i);
          const iB = indexAttr.getX(i + 1);
          const iC = indexAttr.getX(i + 2);
          vA.fromBufferAttribute(posAttr, iA).applyMatrix4(matrix);
          vB.fromBufferAttribute(posAttr, iB).applyMatrix4(matrix);
          vC.fromBufferAttribute(posAttr, iC).applyMatrix4(matrix);
          triangles.push([
            [vA.x, vA.y, vA.z],
            [vB.x, vB.y, vB.z],
            [vC.x, vC.y, vC.z],
          ]);
        }
      } else {
        for (let i = 0; i < posAttr.count; i += 3) {
          vA.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
          vB.fromBufferAttribute(posAttr, i + 1).applyMatrix4(matrix);
          vC.fromBufferAttribute(posAttr, i + 2).applyMatrix4(matrix);
          triangles.push([
            [vA.x, vA.y, vA.z],
            [vB.x, vB.y, vB.z],
            [vC.x, vC.y, vC.z],
          ]);
        }
      }

      this.cachedFloors.push({
        mesh: obj,
        box: {
          min: { x: box.min.x, y: box.min.y, z: box.min.z },
          max: { x: box.max.x, y: box.max.y, z: box.max.z },
        },
        triangles,
      });
    });
  }

  public queryFloorHeightAt(x: number, z: number): number {
    let maxY = -Infinity;
    for (const floor of this.cachedFloors) {
      if (
        floor.box.min.x > x ||
        floor.box.max.x < x ||
        floor.box.min.z > z ||
        floor.box.max.z < z
      ) {
        continue;
      }

      for (const [a, b, c] of floor.triangles) {
        const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
        if (Math.abs(d) < 1e-10) continue;
        const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
        const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
        if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7) {
          const triY = u * a[1] + v * b[1] + (1 - u - v) * c[1];
          if (triY > maxY) {
            maxY = triY;
          }
        }
      }
    }
    return maxY;
  }

  public sampleFloorSupport(x: number, z: number): {
    supported: boolean;
    floorY: number | null;
    calibratedRootY: number;
    supportHeights: number[];
  } {
    const supportCoords: [number, number][] = [
      [x, z],
      ...Array.from({ length: 16 }, (_, i): [number, number] => [
        x + 0.205 * Math.cos((i * Math.PI) / 8),
        z + 0.205 * Math.sin((i * Math.PI) / 8),
      ]),
    ];

    const supportHeights = supportCoords.map(([sx, sz]) => this.queryFloorHeightAt(sx, sz));
    const floor = Math.max(...supportHeights);
    const supported = supportHeights.every(Number.isFinite);
    const floorY = Number.isFinite(floor) ? floor : null;
    const calibratedRootY = floorY !== null ? floorY - 0.011 : 0.589;

    return {
      supported,
      floorY,
      calibratedRootY,
      supportHeights,
    };
  }

  /**
   * Calibrates floor Y using the proven support policy:
   * 17 footprint samples at radius 0.205; highest rendered walkable floor <= 0.650001;
   * root Y = floor Y - 0.011.
   */
  public getCalibratedFloorY(x: number, z: number): number {
    return this.sampleFloorSupport(x, z).calibratedRootY;
  }

  private createBoardWaypointMarkers(): void {
    const markerGroup = new THREE.Group();
    markerGroup.name = "Board_Waypoints";

    const poiMat = new THREE.MeshStandardMaterial({
      color: "#d97736",
      roughness: 0.4,
      metalness: 0.1,
    });
    const shopMat = new THREE.MeshStandardMaterial({
      color: "#2b8a78",
      roughness: 0.4,
      metalness: 0.1,
    });
    const finishMat = new THREE.MeshStandardMaterial({
      color: "#2563eb",
      roughness: 0.3,
      metalness: 0.2,
    });

    const discGeom = new THREE.CylinderGeometry(0.18, 0.18, 0.02, 16);

    for (const [id, node] of this.state.graph.nodes) {
      let mat: THREE.Material | null = null;
      if (id.startsWith("P")) mat = poiMat;
      else if (id.startsWith("R")) mat = shopMat;
      else if (id.startsWith("F-")) mat = finishMat;

      if (mat) {
        const marker = new THREE.Mesh(discGeom, mat);
        const y = this.getCalibratedFloorY(node.worldX, node.worldZ) + 0.020;
        marker.position.set(node.worldX, y, node.worldZ);
        marker.receiveShadow = true;
        marker.name = `WaypointMarker_${id}`;
        markerGroup.add(marker);
      }
    }
    this.scene.add(markerGroup);
  }

  public syncMeshesImmediate(): void {
    for (const player of this.state.players) {
      const mesh = this.meshes.get(player.id);
      if (mesh) {
        const y = this.getCalibratedFloorY(player.position.x, player.position.z);
        mesh.position.set(player.position.x, y, player.position.z);
        mesh.rotation.y = player.position.yaw;
      }
    }
  }

  public getAvailableJunctionOptions(): OutgoingEdgeOption[] {
    return getAvailableJunctionOptions(this.state);
  }

  public dispatch(action: GameAction): void {
    if (this.isAnimating) return;

    const activePlayer = this.state.players[this.state.activePlayerIndex];
    const prevTraceLen = this.state.traversalTrace.length;

    try {
      applyAction(this.state, action);
    } catch (err) {
      console.error("Action error:", err);
      this.notify();
      throw err;
    }

    this.animateSteps(activePlayer.id, this.state.traversalTrace.slice(prevTraceLen));
  }

  public receiveSnapshot(snapshot: Omit<GameState, "graph" | "rng">, animate = true): void {
    const previousLength = this.state.traversalTrace.length;
    Object.assign(this.state, snapshot);
    if (!animate) {
      this.isAnimating = false;
      this.animationQueue = null;
      this.syncMeshesImmediate();
      this.notify();
      return;
    }
    const steps = snapshot.traversalTrace.slice(previousLength);
    this.animateSteps(steps[0]?.playerId ?? snapshot.players[snapshot.activePlayerIndex].id, steps);
  }

  private animateSteps(playerId: PlayerId, newSteps: TraversalStep[]): void {
    if (newSteps.length > 0) {
      const waypoints: TraversalWaypoint[] = [];

      for (const step of newSteps) {
        const edge = this.state.graph.edges.get(step.edgeId);
        if (!edge) continue;

        // Sample exact centerline path preserving all vertices and curve bends
        const sampled = this.state.graph.samplePathAlongEdge(
          edge,
          step.direction,
          step.fromWU,
          step.toWU,
        );

        for (const pt of sampled) {
          waypoints.push({
            x: pt.x,
            y: this.getCalibratedFloorY(pt.x, pt.z),
            z: pt.z,
            yaw: pt.yaw,
          });
        }
      }

      if (waypoints.length > 0) {
        this.recordedTrace.push({ playerId, waypoints });
        this.startAnimation(playerId, waypoints);
        return;
      }
    }

    this.syncMeshesImmediate();
    this.notify();
  }

  private startAnimation(playerId: PlayerId, waypoints: TraversalWaypoint[]): void {
    this.isAnimating = true;
    this.currentWaypointIndex = 0;
    this.animationQueue = {
      playerId,
      waypoints,
      onComplete: () => {
        this.isAnimating = false;
        this.animationQueue = null;
        this.syncMeshesImmediate();
        this.notify();
      },
    };
    this.lastAnimTime = performance.now();
    this.notify();
  }

  public update(now: number): boolean {
    if (!this.isAnimating || !this.animationQueue) return false;

    const deltaMs = Math.min(64, now - this.lastAnimTime);
    this.lastAnimTime = now;

    const { playerId, waypoints, onComplete } = this.animationQueue;
    const mesh = this.meshes.get(playerId);
    if (!mesh) {
      onComplete();
      return false;
    }

    // Animation speed: ~3.0 WU per second
    const speed = 3.0;
    const distToCover = (speed * deltaMs) / 1000;
    let covered = 0;

    while (covered < distToCover && this.currentWaypointIndex < waypoints.length) {
      const targetWp = waypoints[this.currentWaypointIndex];
      const dx = targetWp.x - mesh.position.x;
      const dz = targetWp.z - mesh.position.z;
      const stepDist = Math.hypot(dx, dz);

      if (stepDist <= (distToCover - covered)) {
        mesh.position.set(targetWp.x, targetWp.y, targetWp.z);
        mesh.rotation.y = targetWp.yaw;
        covered += stepDist;
        this.currentWaypointIndex++;
      } else {
        const t = (distToCover - covered) / stepDist;
        mesh.position.x += dx * t;
        mesh.position.z += dz * t;
        mesh.position.y = this.getCalibratedFloorY(mesh.position.x, mesh.position.z);
        mesh.rotation.y = targetWp.yaw;
        covered = distToCover;
      }
    }

    if (this.currentWaypointIndex >= waypoints.length) {
      onComplete();
    }
    return true;
  }

  public getAnimationStatus(): { isAnimating: boolean; currentWaypointIndex: number; totalWaypoints: number } {
    return {
      isAnimating: this.isAnimating,
      currentWaypointIndex: this.currentWaypointIndex,
      totalWaypoints: this.animationQueue ? this.animationQueue.waypoints.length : 0,
    };
  }

  public dispose(): void {
    this.isAnimating = false;
    this.animationQueue = null;
    this.cachedFloors = [];

    // Dispose all geometry and materials in this layer
    this.scene.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        if (obj.geometry) obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else if (obj.material) {
          obj.material.dispose();
        }
      }
    });

    this.parentScene.remove(this.scene);
  }

  public notify(): void {
    if (this.onStateChange) {
      this.onStateChange(this.state, this.isAnimating);
    }
  }

  public getState(): GameState {
    return this.state;
  }
}
