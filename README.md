# agent-machi — Milestone 2

Herdr agent statuses drive up to six travellers (Amber, Teal, Moss, Plum,
Slate, Sand) around the station-to-sea Kamakura scene. The game flow and HUD
are not loaded.

## Layout

- `station-to-sea/` — read-only submodule pinned to `a7f589e7` (G3 v0.8).
- `tools/herdr-bridge/index.mjs` — Node stdlib bridge, no dependencies.
- `src/` — Vite + Three town app.

## Run

```sh
npm install
npm run bridge         # real Herdr socket
npm run dev            # http://<this-host>:5173

npm run bridge:fake    # scripted working -> blocked -> working -> done -> idle

FAKE_SCENARIO=flip npm run bridge       # working -> done 2s apart (debounce check)
FAKE_SCENARIO=blocked2 npm run bridge   # two agents claim S and S-2
FAKE_SCENARIO=roster npm run bridge     # three interleaved agents (third log only)
FAKE_SCENARIO=cast npm run bridge       # four agents use Amber/Teal/Moss/Plum
FAKE_SCENARIO=castreuse npm run bridge  # Moss pane leaves, a new agent inherits Moss
```

Override the bridge in the app with `?bridge=http://host:port`.
When the bridge is unreachable the page shows `bridge: 未連線` instead of a
blank screen.

Bridge endpoints (default `HOST=0.0.0.0:8731`; set `HOST=127.0.0.1` to
restrict to this machine):

- `GET /snapshot` — array of `{pane_id,name,terminal_title_stripped,agent,agent_status,status_since,last_change_seq}`
- `GET /events` — SSE; each `data:` is `{source,pane_id,name,terminal_title_stripped,agent,status,at}`
- `GET /log?limit=200` — last N events from `events.jsonl` in arrival order (default 200, max 2000); bad lines are skipped
- `GET /health`

Every event is appended to `tools/herdr-bridge/events.jsonl`.

The page also shows a collapsible roster (all bridge agents, with role, status,
duration, home) and a collapsible Log panel fed by `/log` plus the live SSE
stream. Roster rows for the first six agents highlight their role (Amber,
Teal, Moss, Plum, Slate or Sand) in the scene; agents after the sixth are
marked `log only`. Rows are removed when the bridge's snapshot no longer
contains that pane. The Log panel loads recent history from `/log` first, so
it survives a page reload, then appends live SSE events.

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
Amber/Teal/Moss/Plum/Slate/Sand assignment is also persisted by `pane_id`;
agents after the sixth are only logged to the console and
`window.__agentMachi.log()`.

A new agent is placed on `S`. A status must stay unchanged for 3 seconds before
it moves. If the target changes during a walk, the traveller finishes the
current edge and replans from the next node (mid-route turn, not a snap).

## Notes

- Pathfinding is a new Dijkstra in `src/planner.ts` over the submodule's
  `getTraversableEdges()` using `worldLength`.
- Animation is a thin new `src/animator.ts` on `samplePathAlongEdge`
  (3.0 WU/s, yaw, `MAP_GROUND_Y`).
- The submodule is not modified.
