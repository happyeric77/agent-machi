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
   slug for this machine: printable ASCII, at most 100 bytes, no colons or
   spaces.
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

- One resident per top-level session. Child (subagent) sessions never get one,
  on any path: a create event, a metadata read, or a list read.
- `source` is `opencode`, `agent` is `opencode`, and the resident id is
  `<machineId>-<sessionID>`. A session whose id would break the bridge's limits
  is skipped and logged instead of being altered.
- The display name is the session title, falling back to the directory name. A
  rename alone reports nothing (the bridge ignores a name on an unchanged
  status); the cached name lands on the next status change the bridge accepts.
  A later metadata read can also correct it.
- Every live resident has its renewal attempted every 5 minutes, on its own
  clock: renewal never waits for a metadata read. A same-status report only
  renews the lease, so a renewal carries whatever state was last known and is
  not a correction. It is an attempt, not a guarantee: the write can be queued,
  superseded by newer state, or dropped after its retry budget.
  The same heartbeat also starts a reconcile pass that re-reads, per session,
  whether it is executing and which permission requests are pending; that is
  what corrects a missed event. Because the pass is serial and bounded, how
  soon a correction lands depends on how many sessions are tracked and whether
  reads are failing — treat five minutes as the idle case, not a guarantee.
  Reads for one session never discard another session's.
- A session's latest state always wins over one still queued: a session that
  comes back after a delete is reported again. Writes go out one at a time and
  the queue is short, but delivery is best-effort: a write can be dropped after
  its retry budget, and outage backoff is shared by the whole endpoint.
- Write ordering is not guaranteed across a proxy. An unload aborts anything
  still on the wire, but a proxy that already buffered an earlier POST can
  still forward it after a newer DELETE reaches the bridge, and the bridge has
  no sequence check. If a stale write must never win, that needs a write
  generation enforced at the bridge; aborting the client is not enough.
- For a resident this reporter is tracking, a `Session.NotFoundError`, an
  archived read, or an archived list row queues a `DELETE` instead of waiting
  out the bridge's TTL; it does not require a delete or archive event. A session it never tracked is not
  read at all, so the earlier instance's resident waits for `DELETE` on the next
  archive/delete event or for the TTL. A failed or timed-out
  read never counts as "gone". An archived session is treated the same way: it
  still answers reads and still appears in the list, and the only trace is
  `time.archived`, so it is excluded wherever rows are read.
- A session confirmed gone stays gone until a fresh, non-archived read proves
  it is live again; a bare start event does not revive it. Prompt events that
  arrive while it is gone are dropped, so a later revival cannot inherit a
  stale form or permission.
- A delete or archive event for a session this reporter never tracked still
  sends `DELETE`: after a plugin reload the resident from the earlier instance
  must be cleared now, not at TTL. Deleting an absent row is a no-op on the
  bridge. An untracked session that is merely observed to be absent (a
  not-found on a lifecycle read) sends nothing.
- Closing a tab or quitting the TUI reports nothing, and it does not stop
  renewals while the server that owns that session is still running. The
  resident expires only after renewals stop: 15 minutes of silence at the
  bridge's default TTL. `DELETE` is sent for a delete event, an archive event,
  or an authoritative absence (a not-found or archived read of a tracked
  session); those are queued like any other write, not sent instantly.
- A reload only reseeds sessions that are executing. A resident that was
  tracked and then went idle is not re-added by the replacement reporter; it
  returns when an event for that session arrives, and until then it keeps
  whatever the bridge last held and expires at TTL.

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
  event-only, and because there is no read to repair it the recovery is one
  event, not a timer: a `form.created` that is answered entirely while the
  stream is down is never seen, and a missed terminal (`form.replied` /
  `form.cancelled`) leaves that resident `blocked` until the session is
  deleted or archived, or until a reporter that lost the state stops (a
  reload with no other setup). A later form event for the same session clears
  only that form's id, not an orphaned one. A failed prompt read never counts
  as "no prompts pending", and neither does a response that is not a list.
- Prompt reads (`permission.list`) are **location-scoped**, while the event
  stream spans every location. Each setup registers the directory it was
  loaded for, and a session's prompts are read through the setup for its own
  directory. A session in a location with no live setup is reconciled from
  events only: its pending-permission set is never replaced by a read from
  elsewhere, because that read would describe different prompts.
- Plugin setup runs once per location, so reporter state cannot belong to a
  setup. Setups for the same report endpoint share one reporter keyed by the
  canonical `/report` URL, the machine id and the source — not by how
  `bridgeUrl` was spelled and not by the token. Delivery pacing is shared by
  the `/report` URL itself, so two machine ids aimed at one bridge do not open
  two request lanes. That keeps another location's
  residents renewing, and the remaining setup takes over the event stream when
  the one that owned it unloads. A new setup does not preempt the owner. The
  reporter stops only when the last setup unloads; the process itself may
  still be running.

## Uninstall

Remove the entry from `opencode.json`. Residents already reported expire by
TTL; no `DELETE` is sent on plugin unload. A reload keeps the reporter alive
while another setup remains, so it removes nothing by itself — but a
replacement reporter can still send `DELETE` for a row it observes as archived
or absent, exactly as a first one would.

## Troubleshooting

- Nothing appears: check that the server process has `AGENT_MACHI_INGEST_TOKEN`
  and that the bridge was started with the same token. Test the bridge directly
  with `agent-machi report --id probe --status working`.
- `bridgeUrl` must be `https://` unless it is loopback, because the token is
  sent as a bearer header.

## Tests

```sh
node --experimental-strip-types --test plugins/opencode/*.test.ts
npm run typecheck:plugin
```

`reducer.ts` is pure: it takes normalized observations and returns report
actions, so the state model is tested without OpenCode or a bridge.
`delivery.ts` is tested against a fake `fetch`. `setup.test.ts` goes through
`setup()` with a fake context and asserts on bridge writes and live
subscription counts, so handoff, bootstrap retry and removal are exercised in
the shape the plugin actually runs in.
