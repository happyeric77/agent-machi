#!/usr/bin/env bash
# Slice-1 E2E: the real binary, no Herdr socket, two external agents driven
# over raw HTTP through every status, then DELETE and TTL expiry. Asserts on
# /snapshot, /events, /log and /health. Set E2E_SCREENSHOT=1 to also capture
# the two residents at their offices.
set -euo pipefail

PORT="${E2E_PORT:-8899}"
BASE="http://127.0.0.1:${PORT}"
TOKEN="e2e-token"
TTL="${E2E_TTL_SECONDS:-30}"
BIN="${E2E_BIN:-./agent-machi}"
tmp="$(mktemp -d)"
server_pid=""

# A leftover bridge would silently receive every report in this run.
if command -v lsof >/dev/null && lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "FAIL: something already listens on $PORT; pick a free port with E2E_PORT" >&2
  exit 1
fi

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    server_pid=""
  fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

start_bridge() { # ttl
  HOST=127.0.0.1 PORT="$PORT" \
    AGENT_MACHI_INGEST_TOKEN="$TOKEN" \
    AGENT_MACHI_INGEST_TTL_SECONDS="$1" \
    HERDR_SOCKET_PATH="$tmp/no-such-herdr.sock" \
    AGENT_MACHI_EVENTS_LOG="$tmp/events.jsonl" \
    AGENT_MACHI_NO_OPEN=1 \
    "$BIN" >"$tmp/server.log" 2>&1 &
  server_pid=$!
  for _ in $(seq 1 60); do
    curl -sf "$BASE/health" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  cat "$tmp/server.log" >&2
  fail "bridge did not become ready"
}

cli() { # token args... -> exit code, stderr kept in $tmp/cli.err
  local token="$1"
  shift
  AGENT_MACHI_INGEST_TOKEN="$token" "$BIN" report --url "$BASE" "$@" \
    >/dev/null 2>"$tmp/cli.err" && echo 0 || echo $?
}

report() { # method source id [status] [token]
  local method="$1" source="$2" id="$3" status="${4:-}" token="${5:-$TOKEN}"
  if [[ "$method" == "POST" ]]; then
    cli "$token" --source "$source" --id "$id" --name "$id" --agent e2e --status "$status"
  else
    cli "$token" --source "$source" --id "$id" --remove
  fi
}

snapshot_status() { # source id -> status or absent
  local source="$1" id="$2"
  curl -s "$BASE/snapshot" | python3 -c '
import json,sys
want="ext:%s:%s" % (sys.argv[1], sys.argv[2])
for row in json.load(sys.stdin):
    if row["pane_id"]==want:
        print(row["agent_status"]); break
else:
    print("absent")
' "$source" "$id"
}

log_rows() { curl -s "$BASE/log?limit=200" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'; }

wait_for_events() { # file count
  local file="$1" want="$2" have=0
  for _ in $(seq 1 100); do
    have="$(grep -c '^data: ' "$file" || true)"
    [[ "$have" -ge "$want" ]] && return 0
    sleep 0.1
  done
  fail "expected at least $want SSE events, got $have"
}

echo "== phase 1: two external agents through all four statuses (TTL ${TTL}s)"
start_bridge "$TTL"

[[ "$(report POST ci build working wrong-token)" == "1" ]] || fail "wrong token accepted"
grep -q "rejected the token" "$tmp/cli.err" || fail "wrong token message: $(cat "$tmp/cli.err")"
[[ "$(report POST ci build gone)" == "2" ]] || fail "status 'gone' accepted"
grep -q "must be working, blocked, done or idle" "$tmp/cli.err" || fail "bad status message: $(cat "$tmp/cli.err")"

curl -sN --max-time 40 "$BASE/events" >"$tmp/sse.txt" &
sse_pid=$!
sleep 0.5

for agent_id in build test; do
  for status in working blocked done idle; do
    code="$(report POST ci "$agent_id" "$status")"
    [[ "$code" == "0" ]] || fail "POST $agent_id $status -> exit $code: $(cat "$tmp/cli.err")"
    got="$(snapshot_status ci "$agent_id")"
    [[ "$got" == "$status" ]] || fail "snapshot $agent_id = $got, want $status"
  done
done

wait_for_events "$tmp/sse.txt" 8

curl -s "$BASE/health" | python3 -c '
import json,sys
h=json.load(sys.stdin)
assert h["ok"] is True, h
assert h["agents"] == 2, h
' || fail "/health does not count both external agents"

rows_before="$(log_rows)"
[[ "$rows_before" -ge 8 ]] || fail "Log baseline is $rows_before, want at least 8 rows"

echo "== heartbeat is silent"
status_since="$(curl -s "$BASE/snapshot" | python3 -c '
import json,sys
print(next(r["status_since"] for r in json.load(sys.stdin) if r["pane_id"]=="ext:ci:build"))')"
report POST ci build idle >/dev/null
after_since="$(curl -s "$BASE/snapshot" | python3 -c '
import json,sys
print(next(r["status_since"] for r in json.load(sys.stdin) if r["pane_id"]=="ext:ci:build"))')"
[[ "$status_since" == "$after_since" ]] || fail "heartbeat moved status_since"
[[ "$(log_rows)" == "$rows_before" ]] || fail "heartbeat wrote a log row"
# A real transition after the heartbeat proves the stream was consumed up to
# this point, so "no heartbeat event" is an absence, not a late read.
report POST ci test working >/dev/null
wait_for_events "$tmp/sse.txt" 9

echo "== delete removes without an event"
[[ "$(report DELETE ci build)" == "0" ]] || fail "DELETE failed: $(cat "$tmp/cli.err")"
[[ "$(snapshot_status ci build)" == "absent" ]] || fail "deleted agent still in snapshot"
[[ "$(snapshot_status ci test)" == "working" ]] || fail "DELETE removed the wrong agent"
[[ "$(log_rows)" == "$((rows_before + 1))" ]] || fail "DELETE wrote a log row"
# Sentinel transition after the DELETE, same reasoning as the heartbeat.
report POST ci test idle >/dev/null
wait_for_events "$tmp/sse.txt" 10

kill "$sse_pid" 2>/dev/null || true
wait "$sse_pid" 2>/dev/null || true

python3 - "$tmp/sse.txt" <<'PY' || fail "SSE stream does not match the expected transitions"
import json,sys
events=[]
for line in open(sys.argv[1]):
    if line.startswith("data: "):
        events.append(json.loads(line[6:]))
assert len(events)==10, events
assert all(e["source"]=="ci" for e in events), events
want=[("build","working"),("build","blocked"),("build","done"),("build","idle"),
      ("test","working"),("test","blocked"),("test","done"),("test","idle"),
      ("test","working"),("test","idle")]
got=[(e["pane_id"].split(":")[2], e["status"]) for e in events]
assert got==want, got
PY

cleanup

echo "== phase 2: expiry on the same path (TTL 2s)"
rm -f "$tmp/events.jsonl"
start_bridge 2
curl -sN --max-time 12 "$BASE/events" >"$tmp/sse2.txt" &
sse_pid=$!
sleep 0.4
report POST ci shortlived working >/dev/null
[[ "$(snapshot_status ci shortlived)" == "working" ]] || fail "agent missing before expiry"
wait_for_events "$tmp/sse2.txt" 1
[[ "$(log_rows)" == "1" ]] || fail "create event missing from a fresh Log"
sleep 3
[[ "$(snapshot_status ci shortlived)" == "absent" ]] || fail "expired agent still in snapshot"
report POST ci sentinel working >/dev/null
wait_for_events "$tmp/sse2.txt" 2
[[ "$(log_rows)" == "2" ]] || fail "expiry wrote a log row"
kill "$sse_pid" 2>/dev/null || true
wait "$sse_pid" 2>/dev/null || true
python3 - "$tmp/sse2.txt" <<'PY' || fail "expiry emitted an event"
import json,sys
events=[json.loads(line[6:]) for line in open(sys.argv[1]) if line.startswith("data: ")]
assert len(events)==2, events
assert events[0]["pane_id"]=="ext:ci:shortlived" and events[0]["status"]=="working", events
assert events[1]["pane_id"]=="ext:ci:sentinel", events
PY
cleanup

if [[ "${E2E_SCREENSHOT:-0}" == "1" ]]; then
  echo "== screenshot: two external residents at their offices"
  rm -f "$tmp/events.jsonl"
  start_bridge "$TTL"
  report POST ci build working >/dev/null
  report POST ci test working >/dev/null
  [[ "$(snapshot_status ci build)" == "working" ]] || fail "build missing before capture"
  [[ "$(snapshot_status ci test)" == "working" ]] || fail "test missing before capture"
  node "$(dirname "$0")/e2e-ingest-screenshot.mjs" \
    "http://127.0.0.1:${PORT}/" "${E2E_SCREENSHOT_PATH:-$tmp/ingest-town.png}" || fail "screenshot capture failed"
  echo "screenshot: ${E2E_SCREENSHOT_PATH:-$tmp/ingest-town.png}"
  cleanup
fi

echo "== phase 3: unreadable bridge states exit non-zero with a hint"
HOST=127.0.0.1 PORT="$PORT" \
  HERDR_SOCKET_PATH="$tmp/no-such-herdr.sock" \
  AGENT_MACHI_EVENTS_LOG="$tmp/disabled.jsonl" \
  AGENT_MACHI_NO_OPEN=1 \
  "$BIN" >"$tmp/disabled.log" 2>&1 &
server_pid=$!
ready=0
for _ in $(seq 1 60); do
  if curl -sf "$BASE/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.1
done
[[ "$ready" == "1" ]] || fail "bridge without ingest did not start"
code="$(cli "$TOKEN" --source ci --id build --status working)"
[[ "$code" == "1" ]] || fail "ingest disabled exit $code"
grep -q "ingest is disabled" "$tmp/cli.err" || fail "disabled message: $(cat "$tmp/cli.err")"
cleanup

code="$(cli "$TOKEN" --source ci --id build --status working)"
[[ "$code" == "1" ]] || fail "bridge down exit $code"
grep -q "cannot reach bridge" "$tmp/cli.err" || fail "unreachable message: $(cat "$tmp/cli.err")"

# Client mode must not be able to bind the bridge port: every call above ran
# while the bridge already owned $PORT, so a stray listener would have failed.
echo "PASS"
