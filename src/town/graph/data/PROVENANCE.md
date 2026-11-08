# Town graph data provenance

## Origin

- Derived from [station-to-sea](https://github.com/happyeric77/station-to-sea) at commit `a7f589e7` (G3 v0.8), vendored into agent-machi by PR #5.
- This copy is independent from the game repository from that point on. It is not synchronized with upstream.
- Refactor date: 2026-11-08 (branch `town-scene-refactor`).

## Retained fields

Only fields actually read by `graph.ts` are kept.

Nodes (39): `id`, `name`, `worldX`, `worldZ`, `type`, `placementStatus`, `runtimeCollisionStatus`.

Edges (42): `id`, `from`, `to`, `centerline`, `worldLength`, `bidirectional`, `runtimeCollisionStatus`, `ownerApprovalStatus`.

`ownerApprovalStatus` is still read to derive `isCandidateOnly`; node approval status is computed by the loader from the explicit P2/F-W/F-E allowlist, so the node field was removed.

## Routing data

- 39 traversable edges under the existing rules (`FINITE_SAMPLE_PASS`, not blocked, candidate link `link-Onari-north-road-1-N` default off).
- `worldLength` is left at its original value. It stays the planner cost, so routing decisions do not change.
- Centerlines were simplified with Douglas-Peucker at **0.02 WU** tolerance; endpoints are unchanged. No edge needed a tighter tolerance or original-point fallback. The largest geometric-length deviation is **0.1698%** (`road-7-1`), below the 1% gate.
- Centerline points: 7936 -> 114.

## Files

- `graph-nodes.json`: 20,414 -> 9,535 bytes.
- `graph-edges.json`: 501,106 -> 14,737 bytes.

## Reproduce

```sh
node tools/slim-town-graph.mjs   # reads the original payload from git commit 00edc46
node tools/make-graph-baseline.mjs
npm test                         # test/town-graph.test.ts compares against the baseline
```
