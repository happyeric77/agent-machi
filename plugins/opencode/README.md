# Agent Machi reporter for OpenCode

An OpenCode plugin that reports your sessions into an Agent Machi bridge over
the `report` API, so each session becomes a resident in the town.

Written for the OpenCode V2 plugin shape (`{ id, setup(ctx) }`), with no build
step. Tested against OpenCode 2.2.6.

## Install

1. Start a bridge in external mode, i.e. with an ingest token:

   ```sh
   export AGENT_MACHI_INGEST_TOKEN=choose-a-long-random-value
   agent-machi
   ```

2. Add one entry to your global OpenCode config
   (`~/.config/opencode/opencode.json`), pointing at this directory:

   ```json
   {
     "plugins": [
       {
         "package": "/absolute/path/to/agent-machi/plugins/opencode",
         "options": { "bridgeUrl": "http://127.0.0.1:8731", "machineId": "mac-mini" }
       }
     ]
   }
   ```

   `bridgeUrl` is the bridge root. `machineId` is any short, stable, unique
   slug for this machine (letters, digits, punctuation; no spaces or colons).
   It is part of every resident id, so do not copy it to a second machine.

3. The token must be in the environment of the **process that owns the
   sessions**, because that is where the plugin runs. A TUI started from a
   shell usually attaches to an already-running `opencode serve`, and exporting
   a variable in that shell does not reach it:

   ```sh
   # Start the server yourself, with the token in its environment.
   AGENT_MACHI_INGEST_TOKEN=choose-a-long-random-value opencode serve
   ```

   An OpenCode started by a desktop launcher needs the variable set in that
   launcher's environment. The plugin never reads the token from config, and
   never logs it.

4. Load the plugin. A config edit reloads it, or restart OpenCode. On 2.2.6
   `OPENCODE_CONFIG_CONTENT` does not load plugins, so this must be a real file.

Without a token, or with a missing/invalid `bridgeUrl` or `machineId`, the
plugin stays silent and the session works exactly as before.

## What it reports

| OpenCode state | Town status |
| --- | --- |
| Session executing | `working` |
| A permission request or a user-answer form is pending | `blocked` |
| Session idle | `idle` |
| `session.deleted` or `session.archived` | removed with `DELETE /report` |

- One resident per top-level session. Child (subagent) sessions never get one.
- `source` is `opencode`, `agent` is `opencode`, and the resident id is
  `<machineId>-<sessionID>`. A session whose id would break the bridge's limits
  is skipped and logged instead of being altered.
- The display name is the session title, falling back to the directory name. A
  rename alone reports nothing (the bridge ignores a name on an unchanged
  status); the new name lands with the session's next transition.
- Every live resident is renewed every 5 minutes. A same-status report is a
  silent heartbeat on the bridge. Each heartbeat also re-reads, per session,
  whether it is executing and which permission requests are pending, so a
  missed event is corrected within five minutes. Reads for one session never
  discard another session's: one session's activity cannot starve the rest.
- A write in flight is never replaced, and a session's latest state always
  wins: a session that comes back after a delete is reported again.
- Write ordering is not guaranteed across a proxy. An unload aborts anything
  still on the wire, but a proxy that already buffered an earlier POST can
  still forward it after a newer DELETE reaches the bridge, and the bridge has
  no sequence check. If a stale write must never win, that needs a write
  generation enforced at the bridge; aborting the client is not enough.
- A session the server answers `Session.NotFoundError` for is deleted at once
  instead of waiting out the bridge's TTL. A failed or timed-out read never
  counts as "gone". An archived session is treated the same way: it still
  answers reads and still appears in the list, and the only trace is
  `time.archived`, so it is excluded wherever rows are read.
- A delete for a session this reporter never tracked still sends `DELETE`:
  after a plugin reload the resident from the earlier instance must be cleared
  now, not at TTL. Deleting an absent row is a no-op on the bridge.
- Closing a tab or quitting the TUI reports nothing, and it does not stop
  renewals while the server that owns that session is still running. The
  resident expires only after renewals stop: 15 minutes of silence at the
  bridge's default TTL. Only deleting or archiving a session sends `DELETE`.

## What the plugin context cannot read

Two authoritative sources in the integration plan are out of reach on OpenCode
2.2.6, and this plugin does not pretend otherwise:

- `GET /api/session/active` has no counterpart on `ctx.session` (there is no
  `active()` call), and `ctx.rpc` is a typed in-process client, not an HTTP
  client. Execution membership is therefore read from each session's own
  `time.busy` / `time.idle` stamps, which is why it is checked per session
  rather than against a set. A session is treated as executing when `busy` is
  newer than `idle`, and `idle` is absent until the first turn ends; a session
  is ignored after a restart if its `busy` predates the server's boot.
- `GET /api/session/{id}/form` has no counterpart either. Form state is
  event-only, with two known failure modes: a form that opens and is answered
  entirely between two heartbeats is never seen, and a `form.replied` event
  missed across a reconnect leaves the resident `blocked` until the next form
  event or session deletion. A failed read never counts as "no prompts pending".
- Prompt reads (`permission.list`) are **location-scoped**, while the event
  stream spans every location. A session in another location is therefore
  reconciled from events only; its pending-permission set is never replaced by
  a read from this location, because that read would describe different
  prompts.
- Plugin setup runs once per location. Exactly one live setup reports: a new
  setup stops the previous one and takes over immediately, because the event
  stream already spans every location and a plugin reload may leave the old
  instance's cleanup unreachable.

## Uninstall

Remove the entry from `opencode.json`. Residents already reported expire by
TTL; no `DELETE` is sent on plugin unload, and a plugin reload never removes
anything.

## Troubleshooting

- Nothing appears: check that the server process has `AGENT_MACHI_INGEST_TOKEN`
  and that the bridge was started with the same token. Test the bridge directly
  with `agent-machi report --id probe --status working`.
- `bridgeUrl` must be `https://` unless it is loopback, because the token is
  sent as a bearer header.

## Tests

```sh
node --experimental-strip-types --test plugins/opencode/*.test.ts
```

`reducer.ts` is pure: it takes normalized events and returns report actions, so
the state model is tested without OpenCode or a bridge. `delivery.ts` is tested
against a fake `fetch`.
