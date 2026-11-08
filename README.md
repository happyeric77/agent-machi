# agent-machi — Milestone 2

Herdr agent statuses drive up to six travellers (Amber, Teal, Moss, Plum,
Slate, Sand) around the station-to-sea Kamakura scene. The game flow and HUD
are not loaded.

> **Scene provenance:** the town source under `src/town/` is derived from
> [happyeric77/station-to-sea](https://github.com/happyeric77/station-to-sea)
> at commit `a7f589e7` (2026-11-08). It develops independently inside
> agent-machi from that point; the two repositories are no longer synchronized.
> Its graph data is slimmed to the fields the loader reads and its centerlines
> are simplified at 0.02 WU; see `src/town/graph/data/PROVENANCE.md`.

## Layout

- `src/town/` — town scene and graph, derived from station-to-sea `a7f589e7`.
- `tools/herdr-bridge/index.mjs` — Node stdlib bridge, no dependencies.
- `tools/slim-town-graph.mjs` — repeatable graph JSON slimming script.
- `tools/make-graph-baseline.mjs` — rebuilds the pre-refactor comparison fixture.
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
FAKE_SCENARIO=home npm run bridge       # one agent loops working/blocked/done/idle
FAKE_SCENARIO=homeblock npm run bridge  # working, then blocked while entering home
FAKE_SCENARIO=home4 npm run bridge      # four agents go home; doorstep/sign check
FAKE_SCENARIO=signnames npm run bridge  # pane_id fallback + a long resident name
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

## Homes and signs

When the stable target is `working` or `done`, the traveller walks to the home
graph node, then a short straight doorstep segment (0.9s), fading out; arrival
sets `visible = false` and `inside = true`. Leaving home reverses it: appear at
the doorstep, fade in, walk back to the node, then continue the route. If the
stable target changes to a non-home while the traveller is entering, the entry
is aborted and the traveller is made visible at the home node before routing;
finishing an exit always completes before the next route. Invariant: a stable
non-home status can never leave a traveller invisible.

Each assigned home gets a sign with the resident name (`name`, else `pane_id`),
a status lamp using the same `STATUS_COLORS` as the roster, and a pulsing `!`
badge while `done`. The sign panel is bright while the resident is inside and
dim while they are away. It is redrawn only when the name or status changes.
Signs are removed when the pane disappears and the home assignment is released.

Doorsteps are kept in `src/homes.ts` (no graph changes). Each one is derived
from the nearest authored building: move toward the home graph node to the
rotated footprint boundary plus 0.16 WU, then put the sign on the road/camera
side. All sign yaw values are `0.46` so the panels face the camera.

| node | doorstep (x,z) | sign (x,z) | nearest building |
| --- | --- | --- | --- |
| P4 | -0.814, -3.452 | -0.05, -2.95 | B04 north courtyard house |
| P2 | -4.87, -1.496 | -4.75, -0.75 | B03 south rear household |
| P1 | -3.158, -3.948 | -2.72, -3.55 | B01 Onari craft frontage |
| P3 | 4.538, -4.924 | 3.95, -4.35 | B02 east-gate tea frontage |
| P5 | 4.557, 2.791 | 4.686, 3.101 | B08 south Wakamiya craft frontage |
| R1 | -3.037, -2.621 | -2.637, -2.221 | B03 Onari tea frontage |
| R2 | 4.538, -3.331 | 4.25, -2.9 | B02/B05 Wakamiya coffee frontage |

## Notes

- Pathfinding is a new Dijkstra in `src/planner.ts` over the submodule's
  `getTraversableEdges()` using `worldLength`.
- Animation is a thin new `src/animator.ts` on `samplePathAlongEdge`
  (3.0 WU/s, yaw, `MAP_GROUND_Y`).
- The submodule is not modified.
