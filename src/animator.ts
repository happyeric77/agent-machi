import type { Object3D } from "three";
import type { Graph, GraphEdge } from "./station-to-sea/game/graph.ts";
import type { Direction, RouteStep } from "./planner.ts";

interface PathPoint {
  x: number;
  z: number;
  yaw: number;
}

interface Segment {
  points: PathPoint[];
  cumulative: number[];
  length: number;
}

const SPEED_WU_PER_SEC = 3.0;

/** Thin centreline animator built on graph.samplePathAlongEdge. */
export class RouteAnimator {
  private readonly object: Object3D;
  private readonly graph: Graph;
  private readonly groundY: number;
  private readonly onNodeReached: (nodeId: string) => void;

  private steps: RouteStep[] = [];
  private stepIndex = 0;
  private segment: Segment | null = null;
  private distance = 0;

  constructor(
    object: Object3D,
    graph: Graph,
    groundY: number,
    onNodeReached: (nodeId: string) => void,
  ) {
    this.object = object;
    this.graph = graph;
    this.groundY = groundY;
    this.onNodeReached = onNodeReached;
  }

  get moving(): boolean {
    return this.stepIndex < this.steps.length;
  }

  start(steps: RouteStep[]): void {
    this.steps = steps;
    this.stepIndex = 0;
    this.segment = null;
    this.distance = 0;
    if (steps.length > 0) this.enterStep();
  }

  update(dtSeconds: number): void {
    let remaining = Math.max(0, dtSeconds) * SPEED_WU_PER_SEC;
    while (remaining > 0 && this.stepIndex < this.steps.length) {
      const segment = this.segment;
      if (!segment) break;
      const left = segment.length - this.distance;
      if (remaining < left) {
        this.distance += remaining;
        this.placeAt(segment, this.distance);
        return;
      }
      remaining -= left;
      this.distance = segment.length;
      this.placeAt(segment, this.distance);

      const finished = this.steps[this.stepIndex];
      this.stepIndex += 1;
      this.segment = null;
      this.distance = 0;
      this.onNodeReached(finished.toNode);
      if (this.stepIndex < this.steps.length && !this.segment) this.enterStep();
    }
  }

  private enterStep(): void {
    const step = this.steps[this.stepIndex];
    if (!step) return;
    const raw = this.graph.samplePathAlongEdge(
      step.edge as GraphEdge,
      step.direction as Direction,
      0,
      step.edge.worldLength,
    );
    const points = raw.length > 0 ? raw : [{ x: 0, z: 0, yaw: 0 }];
    const cumulative: number[] = [0];
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
      cumulative.push(total);
    }
    this.segment = { points, cumulative, length: total };
    this.distance = 0;
    this.placeAt(this.segment, 0);
  }

  private placeAt(segment: Segment, distance: number): void {
    const points = segment.points;
    if (points.length === 0) return;
    if (points.length === 1) {
      this.object.position.set(points[0].x, this.groundY, points[0].z);
      this.object.rotation.y = points[0].yaw;
      return;
    }

    let index = 0;
    while (index < segment.cumulative.length - 2 && segment.cumulative[index + 1] < distance) {
      index += 1;
    }
    const from = points[index];
    const to = points[index + 1];
    const span = segment.cumulative[index + 1] - segment.cumulative[index];
    const t = span > 1e-6 ? Math.max(0, Math.min(1, (distance - segment.cumulative[index]) / span)) : 0;
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    this.object.position.set(x, this.groundY, z);
    this.object.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);
  }
}
