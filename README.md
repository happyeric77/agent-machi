# agent-machi — Milestone 1

Herdr agent statuses drive two travellers (Amber, Teal) around the
station-to-sea Kamakura scene. The game flow and HUD are not loaded.

## Layout

- `station-to-sea/` — read-only submodule pinned to `a7f589e7` (G3 v0.8).
- `tools/herdr-bridge/index.mjs` — Node stdlib bridge, no dependencies.
- `src/` — Vite + Three town app.

## Run

```sh
npm install
npm run bridge         # real Herdr socket
npm run dev            # http://localhost:5173

npm run bridge:fake    # scripted working -> blocked -> working -> done -> idle
```

Override the bridge in the app with `?bridge=http://host:port`.
When the bridge is unreachable the page shows `bridge: 未連線` instead of a
blank screen.

Bridge endpoints (127.0.0.1 only):

- `GET /snapshot` — array of `{pane_id,name,agent,agent_status,status_since,last_change_seq}`
- `GET /events` — SSE; each `data:` is `{source,pane_id,name,agent,status,at}`
- `GET /health`

Every event is appended to `tools/herdr-bridge/events.jsonl`.

## State mapping

| Herdr status | Town target |
| --- | --- |
| `working` | assigned home |
| `done` | assigned home |
| `blocked` | first free station slot: `S`, `S-2`, `S-3` |
| `idle` | nearer beach by route length: `F-W` or `F-E` |
| `unknown` | no move |

Home pool order is `P4, P2, P1, P3, P5, R1, R2`. Assignments are keyed by
`pane_id` and persisted in localStorage, so a reconnect does not change home.
Amber/Teal assignment is also persisted by `pane_id`; agents after the second
are only logged to the console and `window.__agentMachi.log()`.

A new agent is placed on `S`. A status must stay unchanged for 3 seconds before
it moves. If the target changes during a walk, the traveller finishes the
current edge and replans from the next node (mid-route turn, not a snap).

## Notes

- Pathfinding is a new Dijkstra in `src/planner.ts` over the submodule's
  `getTraversableEdges()` using `worldLength`.
- Animation is a thin new `src/animator.ts` on `samplePathAlongEdge`
  (3.0 WU/s, yaw, `MAP_GROUND_Y`).
- The submodule is not modified.
