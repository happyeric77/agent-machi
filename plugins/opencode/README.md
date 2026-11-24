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
- The display name is the session title, falling back to the directory name.
- Every live resident is renewed every 5 minutes. A same-status report is a
  silent heartbeat on the bridge. Each heartbeat also re-reads who is executing
  and the pending permission requests for every live resident, so a missed event
  is corrected within five minutes.
- OpenCode 2.2.6 exposes no read endpoint for pending answer forms on the plugin
  context, so form state is event-only: a form that opens and is answered
  entirely between two heartbeats can be missed. A failed read never counts as
  "no prompts pending".
- Closing a tab or quitting the TUI reports nothing, and it does not stop
  renewals while the server that owns that session is still running. The
  resident expires only after renewals stop: 15 minutes of silence at the
  bridge's default TTL. Only deleting or archiving a session sends `DELETE`.

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
