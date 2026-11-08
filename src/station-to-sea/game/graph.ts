import rawNodes from "./data/graph-nodes.json" with { type: "json" };
import rawEdges from "./data/graph-edges.json" with { type: "json" };

export interface GraphNode {
  readonly id: string;
  readonly name: string;
  readonly worldX: number;
  readonly worldZ: number;
  readonly type: string;
  readonly placementStatus: string;
  readonly runtimeCollisionStatus: string;
  readonly ownerApprovalStatus: "ACCEPTED" | "CANDIDATE_NEEDS_OWNER" | "BLOCKED";
}

export interface GraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly centerline: readonly [number, number][];
  readonly worldLength: number;
  readonly bidirectional: boolean;
  readonly runtimeCollisionStatus: string;
  readonly ownerApprovalStatus: string;
  readonly isBlocked: boolean;
  readonly isCandidateOnly: boolean;
}

export interface OutgoingEdgeOption {
  readonly edge: GraphEdge;
  readonly targetNodeId: string;
  readonly direction: "FORWARD" | "REVERSE";
}

export interface Point2DWithYaw {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

export class Graph {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly edges: ReadonlyMap<string, GraphEdge>;
  readonly enableCandidateOnariLink: boolean;

  constructor(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>, enableCandidateOnariLink: boolean = false) {
    this.nodes = nodes;
    this.edges = edges;
    this.enableCandidateOnariLink = enableCandidateOnariLink;
  }

  getTraversableEdges(): GraphEdge[] {
    return Array.from(this.edges.values()).filter(edge => {
      if (edge.isBlocked) return false;
      if (edge.id === "link-Onari-north-road-1-N" && !this.enableCandidateOnariLink) {
        return false;
      }
      return edge.runtimeCollisionStatus === "FINITE_SAMPLE_PASS";
    });
  }

  getOutgoingEdges(currentNodeId: string): OutgoingEdgeOption[] {
    const traversable = this.getTraversableEdges();
    const options: OutgoingEdgeOption[] = [];

    for (const edge of traversable) {
      if (edge.from === currentNodeId) {
        options.push({ edge, targetNodeId: edge.to, direction: "FORWARD" });
      } else if (edge.to === currentNodeId && edge.bidirectional) {
        options.push({ edge, targetNodeId: edge.from, direction: "REVERSE" });
      }
    }

    return options;
  }

  /**
   * Samples a point and tangent yaw along the centerline polyline of an edge.
   * distanceWU is measured along the edge in the specified direction from 0 to edge.worldLength.
   */
  samplePointAlongEdge(edge: GraphEdge, direction: "FORWARD" | "REVERSE", distanceWU: number): Point2DWithYaw {
    const rawPoints = edge.centerline;
    if (rawPoints.length === 0) {
      return { x: 0, z: 0, yaw: 0 };
    }
    if (rawPoints.length === 1) {
      return { x: rawPoints[0][0], z: rawPoints[0][1], yaw: 0 };
    }

    const points = direction === "FORWARD" ? rawPoints : [...rawPoints].reverse();
    const clampedDist = Math.max(0, Math.min(distanceWU, edge.worldLength));

    // Calculate segment lengths
    let cumulative = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const dx = p2[0] - p1[0];
      const dz = p2[1] - p1[1];
      const segLen = Math.hypot(dx, dz);

      if (cumulative + segLen >= clampedDist || i === points.length - 2) {
        const segRemain = clampedDist - cumulative;
        const t = segLen > 1e-6 ? Math.max(0, Math.min(1, segRemain / segLen)) : 0;
        const x = p1[0] + dx * t;
        const z = p1[1] + dz * t;
        // Yaw in 3D: angle on XZ plane where angle = Math.atan2(dx, dz)
        const yaw = Math.atan2(dx, dz);
        return { x, z, yaw };
      }
      cumulative += segLen;
    }

    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    return {
      x: last[0],
      z: last[1],
      yaw: Math.atan2(last[0] - prev[0], last[1] - prev[1]),
    };
  }
  /**
   * Samples a continuous path of waypoints along an edge between fromDistanceWU and toDistanceWU,
   * including every single centerline curve bend vertex in between.
   */
  samplePathAlongEdge(
    edge: GraphEdge,
    direction: "FORWARD" | "REVERSE",
    fromDistanceWU: number,
    toDistanceWU: number,
  ): Point2DWithYaw[] {
    const rawPoints = edge.centerline;
    if (rawPoints.length === 0) return [];
    if (rawPoints.length === 1) return [{ x: rawPoints[0][0], z: rawPoints[0][1], yaw: 0 }];

    const points = direction === "FORWARD" ? rawPoints : [...rawPoints].reverse();
    const startDist = Math.max(0, Math.min(fromDistanceWU, edge.worldLength));
    const endDist = Math.max(0, Math.min(toDistanceWU, edge.worldLength));

    if (Math.abs(endDist - startDist) < 1e-6) {
      return [this.samplePointAlongEdge(edge, direction, startDist)];
    }

    const waypoints: Point2DWithYaw[] = [];
    waypoints.push(this.samplePointAlongEdge(edge, direction, startDist));

    // Compute cumulative distance to each vertex
    let cumulative = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const dx = p2[0] - p1[0];
      const dz = p2[1] - p1[1];
      const segLen = Math.hypot(dx, dz);
      const nextCum = cumulative + segLen;

      if (startDist < endDist) {
        // Forward along chosen direction
        if (nextCum > startDist + 1e-6 && nextCum < endDist - 1e-6) {
          const yaw = Math.atan2(dx, dz);
          waypoints.push({ x: p2[0], z: p2[1], yaw });
        }
      } else {
        // Backward along chosen direction
        if (nextCum > endDist + 1e-6 && nextCum < startDist - 1e-6) {
          const yaw = Math.atan2(-dx, -dz);
          waypoints.push({ x: p2[0], z: p2[1], yaw });
        }
      }
      cumulative = nextCum;
    }

    waypoints.push(this.samplePointAlongEdge(edge, direction, endDist));
    return waypoints;
  }
}

export function loadGraph(options: { enableCandidateOnariLink?: boolean } = {}): Graph {
  const nodesMap = new Map<string, GraphNode>();
  const edgesMap = new Map<string, GraphEdge>();

  // Explicit Owner Acceptances superseding old candidate metadata
  const ownerAcceptedNodeIds = new Set(["P2", "F-W", "F-E"]);

  for (const raw of (rawNodes as unknown as Array<Record<string, unknown>>)) {
    const id = String(raw.id);
    const isOwnerAccepted = ownerAcceptedNodeIds.has(id);
    const node: GraphNode = {
      id,
      name: String(raw.name || id),
      worldX: Number(raw.worldX),
      worldZ: Number(raw.worldZ),
      type: String(raw.type),
      placementStatus: isOwnerAccepted ? "OWNER_ACCEPTED" : String(raw.placementStatus),
      runtimeCollisionStatus: String(raw.runtimeCollisionStatus),
      ownerApprovalStatus: isOwnerAccepted ? "ACCEPTED" : "CANDIDATE_NEEDS_OWNER",
    };
    nodesMap.set(id, node);
  }

  for (const raw of (rawEdges as unknown as Array<Record<string, unknown>>)) {
    const id = String(raw.id);
    const rawCollision = String(raw.runtimeCollisionStatus || "UNKNOWN");
    const isBlocked = id === "road-6-1" || id === "road-6-2" || rawCollision === "BLOCKED";
    const isCandidateOnly = id === "link-Onari-north-road-1-N" || raw.ownerApprovalStatus === "NEEDS_OWNER_APPROVAL";

    const edge: GraphEdge = {
      id,
      from: String(raw.from),
      to: String(raw.to),
      centerline: (raw.centerline as [number, number][]) || [],
      worldLength: Number(raw.worldLength),
      bidirectional: Boolean(raw.bidirectional),
      // Preserve exact non-pass / UNKNOWN evidence status; never auto-upgrade
      runtimeCollisionStatus: isBlocked ? "BLOCKED" : rawCollision,
      ownerApprovalStatus: String(raw.ownerApprovalStatus || "NEEDS_OWNER_APPROVAL"),
      isBlocked,
      isCandidateOnly,
    };
    edgesMap.set(id, edge);
  }

  return new Graph(nodesMap, edgesMap, Boolean(options.enableCandidateOnariLink));
}
