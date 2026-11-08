import assert from "node:assert/strict";
import test from "node:test";
import { loadGraph } from "../src/station-to-sea/game/graph.ts";
import { planRoute, routeLength } from "../src/planner.ts";

test("Dijkstra finds a traversable route from the station to both beaches", () => {
  const graph = loadGraph();

  for (const beach of ["F-W", "F-E"]) {
    const steps = planRoute(graph, "S", beach);
    assert.ok(steps, `no route S -> ${beach}`);
    assert.ok(steps.length > 0);
    assert.ok(Number.isFinite(routeLength(graph, "S", beach)));

    let cursor = "S";
    for (const step of steps) {
      assert.equal(step.fromNode, cursor);
      assert.equal(step.edge.isBlocked, false);
      assert.equal(step.edge.runtimeCollisionStatus, "FINITE_SAMPLE_PASS");
      assert.notEqual(step.edge.id, "link-Onari-north-road-1-N");
      cursor = step.toNode;
    }
    assert.equal(cursor, beach);
  }
});

test("home pool nodes are reachable and candidate link stays off", () => {
  const graph = loadGraph();
  for (const home of ["P4", "P2", "P1", "P3", "P5", "R1", "R2"]) {
    const steps = planRoute(graph, "S", home);
    assert.ok(steps, `no route S -> ${home}`);
    assert.equal(
      steps.some((step) => step.edge.id === "link-Onari-north-road-1-N"),
      false,
    );
  }
});
