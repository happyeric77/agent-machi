#!/usr/bin/env bash
# End-to-end check for slice 1 (generic ingest): a real binary on a scratch
# port, no Herdr socket, token set, two external agents driven over raw HTTP.
# Prints PASS at the end and exits non-zero on the first failed assertion.
set -euo pipefail

PORT="${E2E_PORT:-8899}"
BASE="http://127.0.0.1:${PORT}"
TOKEN="e2e-token"
TTL="${E2E_TTL_SECONDS:-30}"
BIN="${E2E_BIN:-./agent-machi}"
tmp="$(mktemp -d)"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*"; exit 1; }

start_bridge() {
  local ttl="$1"
  HOST=127.0.0.1 PORT="$PORT" \
    AGENT_MACHI_INGEST_TOKEN="$TOKEN" \
    AGENT_MACHI_INGEST_TTL_SECONDS="$ttl" \
    HERDR_SOCKET_PATH="$tmp/no-such-herdr.sock" \
    AGENT_MACHI_EVENTS_LOG="$tmp/events.jsonl" \
    AGENT_MACHI_NO_OPEN=1 \
    "$BIN" >"$tmp/server.log" 2>&1 &
  server_pid=$!
  for _ in $(seq 1 60); do
    if curl -sf "$BASE/health" >/dev/null 2>&1; then return; fi
    sleep 0.1
  done
  cat "$tmp/server.log" >&2
  fail "bridge did not become ready on $BASE"
}

report() { # method source id status [token]
  local method="$1" source="$2" id="$3" status="${4:-}" token="${5:-$TOKEN}"
  local body="{\"source\":\"$source\",\"id\":\"$id\",\"name\":\"$id\",\"agent\":\"e2e\",\"status\":\"$status\"}"
  if [[ "$method" == "POST" ]]; then
    curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/report" \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data "$body"
  else
    curl -s -o /dev/null -w '%{http_code}' -X DELETE \
      "$BASE/report?source=$source&id=$id" -H "Authorization: Bearer $token"
  fi
}

snapshot_status() { # source id -> status or absent
  local source="$1" id="$2"
  curl -s "$BASE/snapshot" | python3 -c '
import json,sys
src,agent_id=sys.argv[1],sys.argv[2]
rows=json.load(sys.stdin)
want="ext:%s:%s"%(src,agent_id)
for row in rows:
    if row["pane_id"]==want:
        print(row["agent_status"]); break
else:
    print("absent")
' "$source" "$id"
}

log_rows() { curl -s "$BASE/log?limit=200" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'; }

echo "== phase 1: two external agents through all four statuses (TTL ${TTL}s)"
start_bridge "$TTL"

[[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/report")" == "401" ]] \
  || fail "GET /report without a token should be 401: the route exists"
[[ "$(report POST ci build working wrong-token)" == "401" ]] || fail "wrong token accepted"
[[ "$(report POST ci build gone)" == "400" ]] || fail "status 'gone' accepted"

curl -sN --max-time 14 "$BASE/events" >"$tmp/sse.txt" &
sse_pid=$!
sleep 0.5

for agent_id in build test; do
  for status in working blocked done idle; do
    code="$(report POST ci "$agent_id" "$status")"
    [[ "$code" == "200" ]] || fail "POST $agent_id $status -> $code"
    got="$(snapshot_status ci "$agent_id")"
    [[ "$got" == "$status" ]] || fail "snapshot $agent_id = $got, want $status"
  done
done

curl -s "$BASE/health" | python3 -c '
import json,sys
h=json.load(sys.stdin)
assert h["ok"] is True, h
assert h["agents"] == 2, h
' || fail "/health does not count both external agents"

wait "$sse_pid" 2>/dev/null || true
events="$(grep -c '^data: ' "$tmp/sse.txt" || true)"
[[ "$events" == "8" ]] || fail "expected 8 SSE events, got $events"
rows_before="$(log_rows)"

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

echo "== delete removes without an event"
[[ "$(report DELETE ci build)" == "200" ]] || fail "DELETE failed"
[[ "$(snapshot_status ci build)" == "absent" ]] || fail "deleted agent still in snapshot"
[[ "$(snapshot_status ci test)" == "idle" ]] || fail "DELETE removed the wrong agent"
[[ "$(log_rows)" == "$rows_before" ]] || fail "DELETE wrote a log row"
cleanup; server_pid=""

echo "== phase 2: expiry on the same path (TTL 2s)"
start_bridge 2
report POST ci shortlived working >/dev/null
[[ "$(snapshot_status ci shortlived)" == "working" ]] || fail "agent missing before expiry"
log_before_expiry=$(log_rows)
sleep 3
[[ "$(snapshot_status ci shortlived)" == "absent" ]] || fail "expired agent still in snapshot"
[[ "$(log_rows)" == "$log_before_expiry" ]] || fail "expiry wrote a log row"

echo "PASS"
