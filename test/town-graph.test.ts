import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadGraph } from "../src/town/graph/graph.ts";
import { allPairs, polylineLength, traversableEdges } from "../tools/graph-lib.mjs";

const baseline = JSON.parse(readFileSync(new URL("./fixtures/graph-baseline.json", import.meta.url), "utf8"));
const rawNodes = JSON.parse(readFileSync(new URL("../src/town/graph/data/graph-nodes.json", import.meta.url), "utf8"));
const rawEdges = JSON.parse(readFileSync(new URL("../src/town/graph/data/graph-edges.json", import.meta.url), "utf8"));
const graph = loadGraph();
const nodes = Array.from(graph.nodes.values());
const edges = Array.from(graph.edges.values());

test("walkable edge set matches the pre-refactor baseline", () => {
  assert.deepEqual(
    traversableEdges(edges).map((edge) => edge.id).sort(),
    baseline.traversableEdgeIds,
  );
});

test("all-pairs Dijkstra costs and node sequences match the baseline", () => {
  const current = allPairs(nodes, edges);
  assert.equal(current.length, baseline.pairs.length);
  for (let i = 0; i < current.length; i++) {
    const before = baseline.pairs[i];
    const after = current[i];
    assert.equal(`${after.from}->${after.to}`, `${before.from}->${before.to}`);
    if (before.cost === null) {
      assert.equal(after.cost, null, `${before.from}->${before.to} should stay unreachable`);
      assert.equal(after.path, null);
      continue;
    }
    assert.ok(Math.abs(after.cost - before.cost) < 1e-9, `${before.from}->${before.to} cost drift`);
    assert.deepEqual(after.path, before.path, `${before.from}->${before.to} path drift`);
  }
});

test("every simplified centerline stays within 1% of its original geometric length", () => {
  const baselineById = new Map(baseline.edgeGeometry.map((edge) => [edge.id, edge]));
  let worst = { id: null, error: 0 };
  for (const edge of edges) {
    const before = baselineById.get(edge.id);
    assert.ok(before, `missing baseline for ${edge.id}`);
    const length = polylineLength(edge.centerline);
    const error = before.geometricLength > 0 ? Math.abs(length - before.geometricLength) / before.geometricLength : 0;
    if (error > worst.error) worst = { id: edge.id, error };
  }
  assert.ok(worst.error < 0.01, `worst centerline deviation ${worst.id}: ${(worst.error * 100).toFixed(4)}%`);
});

test("graph JSON only keeps fields read by the loader", () => {
  const nodeFields = ["id", "name", "placementStatus", "runtimeCollisionStatus", "type", "worldX", "worldZ"];
  const edgeFields = [
    "bidirectional",
    "centerline",
    "from",
    "id",
    "ownerApprovalStatus",
    "runtimeCollisionStatus",
    "to",
    "worldLength",
  ];
  for (const node of rawNodes) assert.deepEqual(Object.keys(node).sort(), nodeFields);
  for (const edge of rawEdges) assert.deepEqual(Object.keys(edge).sort(), edgeFields);
});
