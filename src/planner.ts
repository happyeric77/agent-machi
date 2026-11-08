import type { Graph, GraphEdge, OutgoingEdgeOption } from "./station-to-sea/game/graph.ts";

export type Direction = "FORWARD" | "REVERSE";

export interface RouteStep {
  edge: GraphEdge;
  direction: Direction;
  fromNode: string;
  toNode: string;
}

interface PreviousStep {
  via: OutgoingEdgeOption;
  node: string;
}

/**
 * Dijkstra over the submodule's traversable edges, weighted by worldLength.
 * Candidate-only links stay disabled because loadGraph() defaults them off.
 */
export function planRoute(graph: Graph, fromNode: string, toNode: string): RouteStep[] | null {
  if (fromNode === toNode) return [];
  if (!graph.nodes.has(fromNode) || !graph.nodes.has(toNode)) return null;

  const distance = new Map<string, number>();
  const previous = new Map<string, PreviousStep>();
  const unvisited = new Set<string>(graph.nodes.keys());

  for (const id of unvisited) distance.set(id, Number.POSITIVE_INFINITY);
  distance.set(fromNode, 0);

  while (unvisited.size > 0) {
    let current: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const id of unvisited) {
      const candidate = distance.get(id) ?? Number.POSITIVE_INFINITY;
      if (candidate < best) {
        best = candidate;
        current = id;
      }
    }
    if (current === null) break;
    if (current === toNode) break;
    unvisited.delete(current);

    for (const option of graph.getOutgoingEdges(current)) {
      if (!unvisited.has(option.targetNodeId)) continue;
      const candidate = best + option.edge.worldLength;
      if (candidate < (distance.get(option.targetNodeId) ?? Number.POSITIVE_INFINITY)) {
        distance.set(option.targetNodeId, candidate);
        previous.set(option.targetNodeId, { via: option, node: current });
      }
    }
  }

  if (!previous.has(toNode)) return null;

  const steps: RouteStep[] = [];
  let cursor = toNode;
  while (cursor !== fromNode) {
    const step = previous.get(cursor);
    if (!step) return null;
    steps.push({
      edge: step.via.edge,
      direction: step.via.direction,
      fromNode: step.node,
      toNode: cursor,
    });
    cursor = step.node;
  }
  steps.reverse();
  return steps;
}

export function routeLength(graph: Graph, fromNode: string, toNode: string): number {
  const steps = planRoute(graph, fromNode, toNode);
  if (!steps) return Number.POSITIVE_INFINITY;
  return steps.reduce((total, step) => total + step.edge.worldLength, 0);
}
