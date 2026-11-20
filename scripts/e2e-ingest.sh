#!/usr/bin/env bash
# Ingest E2E: the real binary, two external agents driven by `agent-machi
# report` through every status, then --remove and TTL expiry. Asserts on
# /snapshot, /events, /log and /health, plus the CLI's error exits.
#
# E2E_SCREENSHOT=1  capture the two residents and their office signs
# E2E_MIXED=1       run beside the real Herdr session and survive a reconcile
# E2E_REAL_TTL=1    wait out the default 15-minute expiry in real time
set -euo pipefail

PORT="${E2E_PORT:-8899}"
BASE="http://127.0.0.1:${PORT}"
TOKEN="e2e-token"
TTL="${E2E_TTL_SECONDS:-30}"
BIN="${E2E_BIN:-./agent-machi}"
tmp="$(mktemp -d)"
server_pid=""
proxy_pid=""
sse_pid=""
dom_pid=""

# A leftover bridge would silently receive every report in this run.
if command -v lsof >/dev/null && lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "FAIL: something already listens on $PORT; pick a free port with E2E_PORT" >&2
  exit 1
fi

cleanup() {
  if [[ -n "$sse_pid" ]]; then
    kill "$sse_pid" 2>/dev/null || true
    wait "$sse_pid" 2>/dev/null || true
    sse_pid=""
  fi
  if [[ -n "$dom_pid" ]]; then
    kill "$dom_pid" 2>/dev/null || true
    wait "$dom_pid" 2>/dev/null || true
    dom_pid=""
  fi
  if [[ -n "$proxy_pid" ]]; then
    kill "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
    proxy_pid=""
  fi
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    server_pid=""
  fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

wait_healthy() { # log-file
  for _ in $(seq 1 80); do
    kill -0 "$server_pid" 2>/dev/null || break
    curl -sf "$BASE/health" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  cat "$1" >&2 2>/dev/null || true
  fail "bridge did not become ready"
}

start_bridge() { # ttl
  HOST=127.0.0.1 PORT="$PORT" \
    AGENT_MACHI_INGEST_TOKEN="$TOKEN" \
    AGENT_MACHI_INGEST_TTL_SECONDS="$1" \
    FAKE= \
    FAKE_SCENARIO= \
    HERDR_SOCKET_PATH="$tmp/no-such-herdr.sock" \
    AGENT_MACHI_EVENTS_LOG="$tmp/events.jsonl" \
    AGENT_MACHI_NO_OPEN=1 \
    "$BIN" >"$tmp/server.log" 2>&1 &
  server_pid=$!
  wait_healthy "$tmp/server.log"
}

cli() { # token args... -> exit status, stderr kept in $tmp/cli.err
  local token="$1"
  shift
  AGENT_MACHI_INGEST_TOKEN="$token" "$BIN" report --url "$BASE" "$@" \
    >/dev/null 2>"$tmp/cli.err"
}

report() { # method source id [status] [token]
  local method="$1" source="$2" id="$3" status="${4:-}" token="${5:-$TOKEN}"
  if [[ "$method" == "POST" ]]; then
    cli "$token" --source "$source" --id "$id" --name "$id" --agent e2e --status "$status"
  else
    cli "$token" --source "$source" --id "$id" --remove
  fi
}

must_report() { # method source id [status] [token]
  report "$@" || fail "report $* failed (exit $?): $(cat "$tmp/cli.err")"
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

if report POST ci build working wrong-token; then fail "wrong token accepted"; fi
grep -q "rejected the token" "$tmp/cli.err" || fail "wrong token message: $(cat "$tmp/cli.err")"
if cli "" --source ci --id build --status working; then fail "missing token accepted"; fi
grep -q "rejected the token" "$tmp/cli.err" || fail "missing token message: $(cat "$tmp/cli.err")"
if report POST ci build gone; then fail "status 'gone' accepted"; fi
grep -q "must be working, blocked, done or idle" "$tmp/cli.err" || fail "bad status message: $(cat "$tmp/cli.err")"
# A valid status with an over-long name reaches the bridge and must surface its 400.
long_name="$(python3 -c 'print("n" * 129)')"
if cli "$TOKEN" --source ci --id build --status working --name "$long_name"; then fail "129-byte name accepted"; fi
grep -q "limited to 128 bytes" "$tmp/cli.err" || fail "bridge 400 message: $(cat "$tmp/cli.err")"

curl -sN --max-time 40 "$BASE/events" >"$tmp/sse.txt" &
sse_pid=$!
sleep 0.5

for agent_id in build test; do
  for status in working blocked done idle; do
    must_report POST ci "$agent_id" "$status"
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
must_report POST ci build idle
after_since="$(curl -s "$BASE/snapshot" | python3 -c '
import json,sys
print(next(r["status_since"] for r in json.load(sys.stdin) if r["pane_id"]=="ext:ci:build"))')"
[[ "$status_since" == "$after_since" ]] || fail "heartbeat moved status_since"
[[ "$(log_rows)" == "$rows_before" ]] || fail "heartbeat wrote a log row"
# A real transition after the heartbeat proves the stream was consumed up to
# this point, so "no heartbeat event" is an absence, not a late read.
must_report POST ci test working
wait_for_events "$tmp/sse.txt" 9

echo "== delete removes without an event"
must_report DELETE ci build
[[ "$(snapshot_status ci build)" == "absent" ]] || fail "deleted agent still in snapshot"
[[ "$(snapshot_status ci test)" == "working" ]] || fail "DELETE removed the wrong agent"
[[ "$(log_rows)" == "$((rows_before + 1))" ]] || fail "DELETE wrote a log row"
# Sentinel transition after the DELETE, same reasoning as the heartbeat.
must_report POST ci test idle
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
must_report POST ci shortlived working
[[ "$(snapshot_status ci shortlived)" == "working" ]] || fail "agent missing before expiry"
wait_for_events "$tmp/sse2.txt" 1
[[ "$(log_rows)" == "1" ]] || fail "create event missing from a fresh Log"
sleep 3
[[ "$(snapshot_status ci shortlived)" == "absent" ]] || fail "expired agent still in snapshot"
must_report POST ci sentinel working
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
  must_report POST ci build working
  must_report POST ci test working
  [[ "$(snapshot_status ci build)" == "working" ]] || fail "build missing before capture"
  [[ "$(snapshot_status ci test)" == "working" ]] || fail "test missing before capture"
  node "$(dirname "$0")/e2e-ingest-screenshot.mjs" \
    "http://127.0.0.1:${PORT}/" "${E2E_SCREENSHOT_PATH:-$tmp/ingest-town.png}" || fail "screenshot capture failed"
  echo "screenshot: ${E2E_SCREENSHOT_PATH:-$tmp/ingest-town.png}"
  cleanup
fi

echo "== phase 3: unreadable bridge states exit non-zero with a hint"
HOST=127.0.0.1 PORT="$PORT" \
  AGENT_MACHI_INGEST_TOKEN= \
  FAKE= \
  FAKE_SCENARIO= \
  HERDR_SOCKET_PATH="$tmp/no-such-herdr.sock" \
  AGENT_MACHI_EVENTS_LOG="$tmp/disabled.jsonl" \
  AGENT_MACHI_NO_OPEN=1 \
  "$BIN" >"$tmp/disabled.log" 2>&1 &
server_pid=$!
wait_healthy "$tmp/disabled.log"
if cli "$TOKEN" --source ci --id build --status working; then fail "ingest disabled accepted the report"; fi
grep -q "ingest is disabled" "$tmp/cli.err" || fail "disabled message: $(cat "$tmp/cli.err")"
cleanup

if cli "$TOKEN" --source ci --id build --status working; then fail "report succeeded with the bridge down"; fi
grep -q "cannot reach bridge" "$tmp/cli.err" || fail "unreachable message: $(cat "$tmp/cli.err")"

echo "== phase 4: the tokenless public demo refuses reports and still runs"
HOST=127.0.0.1 PORT="$PORT" \
  AGENT_MACHI_INGEST_TOKEN= \
  HERDR_SOCKET_PATH="$tmp/no-such-herdr.sock" \
  AGENT_MACHI_EVENTS_LOG="$tmp/demo.jsonl" \
  AGENT_MACHI_NO_OPEN=1 FAKE=1 FAKE_SCENARIO=demo \
  "$BIN" >"$tmp/demo.log" 2>&1 &
server_pid=$!
wait_healthy "$tmp/demo.log"
curl -sN --max-time 30 "$BASE/events" >"$tmp/sse-demo.txt" &
sse_pid=$!
sleep 0.5

code="$(curl -s -o "$tmp/demo-body.txt" -w '%{http_code}' -X POST "$BASE/report" \
  -H 'Content-Type: application/json' \
  -d '{"source":"ci","id":"demo","status":"working"}')"
[[ "$code" == "404" ]] || fail "tokenless POST /report returned $code, want 404"
code="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/report?source=ci&id=demo")"
[[ "$code" == "404" ]] || fail "tokenless DELETE /report returned $code, want 404"
[[ "$(snapshot_status ci demo)" == "absent" ]] || fail "a refused report created a resident"

# The scripted demo must still advance. The 1.5s cycle repeats the seeded
# idle states; the first real change is Amber working around 9.5s.
demo_event=0
for _ in $(seq 1 300); do
  if grep -q '"pane_id":"fake:p1","name":null.*"status":"working"' "$tmp/sse-demo.txt"; then
    demo_event=1
    break
  fi
  sleep 0.1
done
[[ "$demo_event" == "1" ]] || fail "the demo never reported Amber working"
python3 - "$tmp/sse-demo.txt" "$BASE" "$tmp/demo.jsonl" <<'PY' || fail "the demo story did not advance"
import json,sys,urllib.request
sse, base, log_path = sys.argv[1], sys.argv[2], sys.argv[3]
events=[json.loads(l[6:]) for l in open(sse) if l.startswith("data: ")]
event=next((e for e in events if e["pane_id"]=="fake:p1" and e["status"]=="working"), None)
assert event is not None, events
rows=json.load(urllib.request.urlopen(base+"/snapshot"))
row=next((r for r in rows if r["pane_id"]=="fake:p1"), None)
assert row is not None, rows
assert row["agent_status"]=="working", row
log=[json.loads(l) for l in open(log_path) if l.strip()]
assert any(e["pane_id"]=="fake:p1" and e["status"]=="working" for e in log), log
health=json.load(urllib.request.urlopen(base+"/health"))
assert health["fake"] is True and health["agents"]>=1, health
PY
cleanup

echo "== phase 4: a wrong token is rejected on an enabled bridge"
start_bridge "$TTL"
code="$(curl -s -o "$tmp/wrong-body.txt" -w '%{http_code}' -X POST "$BASE/report" \
  -H 'Authorization: Bearer not-the-token' \
  -H 'Content-Type: application/json' \
  -d '{"source":"ci","id":"demo","status":"working"}')"
[[ "$code" == "401" ]] || fail "wrong token returned $code, want 401"
[[ "$(cat "$tmp/wrong-body.txt")" == "unauthorized" ]] || fail "wrong-token body: $(cat "$tmp/wrong-body.txt")"
code="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
  "$BASE/report?source=ci&id=demo" -H 'Authorization: Bearer not-the-token')"
[[ "$code" == "401" ]] || fail "wrong-token DELETE returned $code, want 401"
[[ "$(snapshot_status ci demo)" == "absent" ]] || fail "a rejected report created a resident"
cleanup

if [[ "${E2E_MIXED:-0}" == "1" ]]; then
  echo "== phase 5: mixed mode with the real Herdr session"
  real_socket="${E2E_HERDR_SOCKET:-$HOME/.config/herdr/herdr.sock}"
  [[ -S "$real_socket" ]] || fail "no Herdr socket at $real_socket"
  proxy_sock="$tmp/herdr.sock"
  trace="$tmp/proxy.trace"

  # A forwarding socket lets the harness drop the bridge's subscription and
  # watch the reconcile that follows. Herdr itself is only read.
  cat >"$tmp/herdr-proxy.py" <<'PY'
import os, socket, sys, threading
listen_path, target_path, trace_path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    os.unlink(listen_path)
except FileNotFoundError:
    pass
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(listen_path)
server.listen(64)
trace_lock = threading.Lock()

def record(marker, line):
    with trace_lock:
        with open(trace_path, "ab") as trace:
            trace.write(marker + line + b"\n")

def pipe(src, dst, marker):
    buffer = b""
    try:
        while True:
            chunk = src.recv(65536)
            if not chunk:
                break
            buffer += chunk
            # Record before forwarding, so a reader of the trace never sees the
            # response before the request that caused it.
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                record(marker, line)
            dst.sendall(chunk)
    except OSError:
        pass
    finally:
        for sock in (src, dst):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

def handle(client):
    upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    upstream.connect(target_path)
    threading.Thread(target=pipe, args=(client, upstream, b"> "), daemon=True).start()
    threading.Thread(target=pipe, args=(upstream, client, b"< "), daemon=True).start()

while True:
    conn, _ = server.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
PY

  cat >"$tmp/trace-wait.py" <<'PY'
import sys
path, offset = sys.argv[1], int(sys.argv[2])
lines = open(path, errors="replace").read().splitlines()[offset:]
stage = 0
for line in lines:
    if stage == 0 and line.startswith("> ") and '"method":"session.snapshot"' in line:
        stage = 1
    elif stage == 1 and line.startswith("< ") and '"snapshot"' in line:
        stage = 2
    elif stage == 2 and line.startswith("> ") and 'pane.agent_detected' in line:
        sys.exit(0)
sys.exit(1)
PY

  python3 "$tmp/herdr-proxy.py" "$proxy_sock" "$real_socket" "$trace" &
  proxy_pid=$!
  for _ in $(seq 1 50); do [[ -S "$proxy_sock" ]] && break; sleep 0.1; done
  [[ -S "$proxy_sock" ]] || fail "Herdr proxy did not listen"

  rm -f "$tmp/mixed.jsonl"
  HOST=127.0.0.1 PORT="$PORT" \
    AGENT_MACHI_INGEST_TOKEN="$TOKEN" \
    AGENT_MACHI_INGEST_TTL_SECONDS= \
    FAKE= \
    FAKE_SCENARIO= \
    HERDR_SOCKET_PATH="$proxy_sock" \
    AGENT_MACHI_EVENTS_LOG="$tmp/mixed.jsonl" \
    AGENT_MACHI_NO_OPEN=1 \
    "$BIN" >"$tmp/mixed.log" 2>&1 &
  server_pid=$!
  wait_healthy "$tmp/mixed.log"

  ack=0
  for _ in $(seq 1 200); do
    if grep -q '^< .*"subscription_started"' "$trace"; then ack=1; break; fi
    sleep 0.1
  done
  [[ "$ack" == "1" ]] || fail "no initial Herdr subscription acknowledgment"

  herdr_rows=""
  for _ in $(seq 1 100); do
    herdr_rows="$(curl -s "$BASE/snapshot" | python3 -c '
import json,sys
print(sum(1 for r in json.load(sys.stdin) if not r["pane_id"].startswith("ext:")))')"
    [[ "$herdr_rows" -ge 1 ]] && break
    sleep 0.2
  done
  [[ "$herdr_rows" -ge 1 ]] || fail "real Herdr rows never appeared"

  must_report POST mixed radio working
  [[ "$(snapshot_status mixed radio)" == "working" ]] || fail "external agent missing in mixed mode"
  since_before="$(curl -s "$BASE/snapshot" | python3 -c '
import json,sys
print(next(r["status_since"] for r in json.load(sys.stdin) if r["pane_id"]=="ext:mixed:radio"))')"
  ext_log_before="$(curl -s "$BASE/log?limit=200" | python3 -c '
import json,sys
print(sum(1 for r in json.load(sys.stdin) if r["pane_id"]=="ext:mixed:radio"))')"

  echo "-- dropping the Herdr subscription to force a reconcile"
  fail_before="$(grep -c 'reconcile failed' "$tmp/mixed.log" || true)"
  kill "$proxy_pid" 2>/dev/null || true
  wait "$proxy_pid" 2>/dev/null || true
  proxy_pid=""
  failed="$fail_before"
  for _ in $(seq 1 100); do
    failed="$(grep -c 'reconcile failed' "$tmp/mixed.log" || true)"
    [[ "$failed" -gt "$fail_before" ]] && break
    sleep 0.1
  done
  [[ "$failed" -gt "$fail_before" ]] || fail "no new reconcile attempt while the socket was down"

  echo "-- restoring the socket; the retried reconcile must complete and keep the row"
  offset="$(wc -l < "$trace" | tr -d ' ')"
  python3 "$tmp/herdr-proxy.py" "$proxy_sock" "$real_socket" "$trace" &
  proxy_pid=$!
  for _ in $(seq 1 50); do [[ -S "$proxy_sock" ]] && break; sleep 0.1; done
  [[ -S "$proxy_sock" ]] || fail "Herdr proxy did not come back"
  after_restore="$(grep -c 'reconcile failed' "$tmp/mixed.log" || true)"
  reconciled=0
  for _ in $(seq 1 900); do
    if python3 "$tmp/trace-wait.py" "$trace" "$offset"; then reconciled=1; break; fi
    sleep 0.2
  done
  [[ "$reconciled" == "1" ]] || fail "no completed reconcile (snapshot response + global subscription) after reconnect"
  sleep 3
  still_failed="$(grep -c 'reconcile failed' "$tmp/mixed.log" || true)"
  [[ "$still_failed" == "$after_restore" ]] || fail "reconcile kept failing after the socket returned"

  python3 - "$BASE" "$since_before" "$ext_log_before" <<'PY' || fail "the completed reconcile changed the external resident"
import json,sys,urllib.request
base, since_before, log_before = sys.argv[1], sys.argv[2], int(sys.argv[3])
rows=json.load(urllib.request.urlopen(base+"/snapshot"))
herdr=[r for r in rows if not r["pane_id"].startswith("ext:")]
ext=[r for r in rows if r["pane_id"]=="ext:mixed:radio"]
assert herdr, rows
assert len(ext)==1, rows
assert ext[0]["agent_status"]=="working", ext
assert ext[0]["status_since"]==since_before, ext
log=json.load(urllib.request.urlopen(base+"/log?limit=200"))
rows_for_ext=[e for e in log if e["pane_id"]=="ext:mixed:radio"]
assert len(rows_for_ext)==log_before, rows_for_ext
print("mixed: reconcile completed with %d Herdr rows and the external row intact" % len(herdr))
PY

  cleanup
fi

if [[ "${E2E_REAL_TTL:-0}" == "1" ]]; then
  echo "== phase 6: expiry at the default 15-minute TTL"
  rm -f "$tmp/events.jsonl"
  start_bridge "" # empty -> the bridge's own 900s default
  curl -sN --max-time 1300 "$BASE/events" >"$tmp/sse-ttl.txt" &
  sse_pid=$!
  sleep 0.4

  # A live page proves the resident leaves the rendered Roster, not just /snapshot.
  node "$(dirname "$0")/e2e-ingest-dom.mjs" "$BASE/" ttl-agent 1200 \
    >"$tmp/dom.log" 2>&1 &
  dom_pid=$!

  report_at="$(python3 -c 'import time; print(time.monotonic())')"
  must_report POST ci ttl-agent working
  wait_for_events "$tmp/sse-ttl.txt" 1

  last_seen=0
  absent_at=-1
  while :; do
    elapsed="$(python3 -c "import time; print(int(time.monotonic() - $report_at))")"
    status="$(snapshot_status ci ttl-agent)"
    if [[ "$status" == "absent" ]]; then absent_at="$elapsed"; break; fi
    last_seen="$elapsed"
    [[ "$elapsed" -le 960 ]] || fail "ttl-agent still present after ${elapsed}s"
    sleep 5
  done
  [[ "$last_seen" -ge 890 ]] || fail "ttl-agent vanished early (last seen ${last_seen}s)"
  [[ "$absent_at" -ge 900 && "$absent_at" -le 960 ]] || fail "absence observed at ${absent_at}s, want 900-960s"

  dom_status=0
  wait "$dom_pid" || dom_status=$?
  dom_pid=""
  [[ "$dom_status" == "0" ]] || { cat "$tmp/dom.log" >&2; fail "the rendered Roster did not drop the resident"; }

  must_report POST ci ttl-sentinel working
  wait_for_events "$tmp/sse-ttl.txt" 2
  kill "$sse_pid" 2>/dev/null || true
  wait "$sse_pid" 2>/dev/null || true
  sse_pid=""
  python3 - "$tmp/sse-ttl.txt" <<'PY' || fail "expiry emitted an SSE event"
import json,sys
events=[json.loads(line[6:]) for line in open(sys.argv[1]) if line.startswith("data: ")]
assert len(events)==2, events
assert events[0]["pane_id"]=="ext:ci:ttl-agent" and events[0]["status"]=="working", events
assert events[1]["pane_id"]=="ext:ci:ttl-sentinel", events
PY
  curl -s "$BASE/log?limit=200" | python3 -c '
import json,sys
rows=json.load(sys.stdin)
got=[(r["pane_id"],r["status"]) for r in rows]
want=[("ext:ci:ttl-agent","working"),("ext:ci:ttl-sentinel","working")]
assert got==want, got
' || fail "the fresh Log does not hold exactly the creation and sentinel rows"
  echo "ttl: last present ${last_seen}s, absent ${absent_at}s; Roster dropped it; no Log row; no SSE event"
  cleanup
fi

# Client mode must not be able to bind the bridge port: every call above ran
# while the bridge already owned $PORT, so a stray listener would have failed.
echo "PASS"
