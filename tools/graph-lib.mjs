// Shared graph checks for the town graph data. Node stdlib only.
// Used by the baseline generator, the slimming script, and test/town-graph.test.ts.

export function isTraversable(edge) {
  if (edge.id === "road-6-1" || edge.id === "road-6-2") return false;
  if (edge.id === "link-Onari-north-road-1-N") return false;
  if (edge.runtimeCollisionStatus === "BLOCKED") return false;
  return edge.runtimeCollisionStatus === "FINITE_SAMPLE_PASS";
}

export function traversableEdges(edges) {
  return edges.filter(isTraversable);
}

export function buildAdjacency(edges) {
  const adjacency = new Map();
  const add = (from, to, edge) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push({ to, edgeId: edge.id, weight: edge.worldLength });
  };
  for (const edge of traversableEdges(edges)) {
    add(edge.from, edge.to, edge);
    if (edge.bidirectional) add(edge.to, edge.from, edge);
  }
  return adjacency;
}

// Deterministic O(V^2) Dijkstra: ties pick the lexicographically smallest node id.
export function dijkstra(nodes, edges, source) {
  const adjacency = buildAdjacency(edges);
  const ids = nodes.map((node) => node.id).sort();
  const dist = new Map(ids.map((id) => [id, Infinity]));
  const prev = new Map();
  const visited = new Set();
  dist.set(source, 0);

  while (visited.size < ids.length) {
    let current = null;
    for (const id of ids) {
      if (visited.has(id)) continue;
      if (current === null || dist.get(id) < dist.get(current)) current = id;
    }
    if (current === null || dist.get(current) === Infinity) break;
    visited.add(current);

    for (const option of adjacency.get(current) ?? []) {
      if (visited.has(option.to)) continue;
      const next = dist.get(current) + option.weight;
      if (next < dist.get(option.to) - 1e-12) {
        dist.set(option.to, next);
        prev.set(option.to, current);
      }
    }
  }

  return { dist, prev };
}

export function pathTo(prev, source, target) {
  if (source === target) return [source];
  const path = [];
  let cursor = target;
  const seen = new Set();
  while (cursor !== undefined && !seen.has(cursor)) {
    path.push(cursor);
    seen.add(cursor);
    if (cursor === source) return path.reverse();
    cursor = prev.get(cursor);
  }
  return null;
}

export function allPairs(nodes, edges) {
  const ids = nodes.map((node) => node.id).sort();
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    const { dist, prev } = dijkstra(nodes, edges, ids[i]);
    for (let j = i + 1; j < ids.length; j++) {
      const target = ids[j];
      const cost = dist.get(target);
      pairs.push({
        from: ids[i],
        to: target,
        cost: Number.isFinite(cost) ? Number(cost.toFixed(9)) : null,
        path: Number.isFinite(cost) ? pathTo(prev, ids[i], target) : null,
      });
    }
  }
  return pairs;
}

export function polylineLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return length;
}

function segmentDistance(point, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  let t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dz * t));
}

// Douglas-Peucker. Endpoints are returned exactly as supplied.
export function simplifyLine(points, tolerance) {
  if (points.length <= 2) return points.map((point) => [...point]);
  let worst = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const distance = segmentDistance(points[i], points[0], points[points.length - 1]);
    if (distance > worst) {
      worst = distance;
      index = i;
    }
  }
  if (worst <= tolerance) return [points[0], points[points.length - 1]];
  const left = simplifyLine(points.slice(0, index + 1), tolerance);
  const right = simplifyLine(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}
