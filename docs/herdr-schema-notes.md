# Herdr 0.9.5 schema notes (step 0)

Captured on the Mac mini on 2026-11-08 with:

```sh
herdr status --json
herdr api schema --json > /tmp/herdr-schema.json   # 272,578 bytes
herdr api snapshot
herdr session list --json
```

## Request / response

One JSON object per NDJSON line.

```json
{"id":"agent-machi-1","method":"session.snapshot","params":{}}
```

Success: `{id, result:{type, ...}}`. Error: `{id, error:{code,message}}`.
Events arrive on the same socket with no `id` and no `result` wrapper.

## session.snapshot

```json
{
  "id": "...",
  "result": {
    "type": "session_snapshot",
    "snapshot": {
      "version": 0,
      "protocol": 22,
      "workspaces": [],
      "tabs": [],
      "panes": [],
      "layouts": [],
      "agents": []
    }
  }
}
```

`snapshot.agents` is the `AgentInfo[]` table used by the bridge.

## agent.list / AgentInfo

`{type:"agent_list", agents:[...]}`. Fields seen in schema/live data:

`terminal_id`, `agent` (`string|null`), `agent_session` (`object|null`),
`agent_status`, `completion_seq`, `cwd`, `display_agent`, `focused`,
`foreground_cwd`, `interactive_ready`, `launch_pending`, `name`
(`string|null`), `pane_id`, `revision`, `screen_detection_skipped`,
`state_change_seq`, `state_labels`, `tab_id`, `terminal_title`,
`terminal_title_stripped`, `title`, `tokens`, `workspace_id`.

`agent_status` is exactly `idle | working | blocked | done | unknown`.
Live agents had no `name`; the readable title is `terminal_title_stripped`.

## events.subscribe

Params: `{subscriptions:[...]}`. The bundled schema type for `Subscription`
only lists `{type}` and is incomplete. On the live 0.9.5 server:

- `pane.agent_status_changed` **requires** `pane_id`; without it the server
  returns `invalid_request: missing field pane_id`.
- `agent_status` is an optional filter on that subscription.
- `pane.created`, `pane.agent_detected`, `pane.closed`, `pane.exited` are
  global and accepted together without `pane_id`.
- Success is `{id, result:{type:"subscription_started"}}`.
- Subscriptions do not replay and events are not persisted.

Verified subscription shapes:

```json
{"type":"pane.agent_status_changed","pane_id":"w7:p2"}
{"type":"pane.agent_status_changed","pane_id":"w7:p2","agent_status":"blocked"}
{"type":"pane.created"}
{"type":"pane.agent_detected"}
{"type":"pane.closed"}
{"type":"pane.exited"}
```

Live event lines:

```json
{"data":{"agent":"scratch","agent_status":"working","pane_id":"w1:p1","workspace_id":"w1"},"event":"pane.agent_status_changed"}
{"data":{"agent":"scratch","pane_id":"w1:p1","type":"pane_agent_detected","workspace_id":"w1"},"event":"pane_agent_detected"}
{"data":{"agent":"scratch","final_status":"unknown","pane_id":"w1:p1","released":true,"type":"pane_agent_detected","workspace_id":"w1"},"event":"pane_agent_detected"}
```

`pane.agent_status_changed` uses dots; `pane_agent_detected` uses underscores.
`events_lost` was not observed; the bridge treats any such event as a dropped
connection, reconnects, resubscribes, and reconciles with `session.snapshot`.

## Timestamps

The API has no time fields. The bridge stamps `at` / `status_since` when it
receives or snapshots the state.

## Sockets and named sessions

- `HERDR_SOCKET_PATH` wins.
- Named session: `HERDR_SESSION=<name>` →
  `~/.config/herdr/sessions/<name>/herdr.sock`.
- Default: `~/.config/herdr/herdr.sock`.

`herdr session list --json` returns
`{sessions:[{name,default,running,session_dir,socket_path}]}`.

## One request per connection

Herdr 0.9.5 accepts a single request on a socket connection. Reusing the
connection for a second request (for example `session.snapshot` followed by
`events.subscribe`) ends with `write EPIPE` and a closed socket. The bridge
therefore opens one short-lived connection per snapshot request and one
long-lived connection per subscription: one global subscription plus one
per-pane subscription.
