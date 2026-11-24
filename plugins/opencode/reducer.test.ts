import assert from "node:assert/strict";
import test from "node:test";

import {
  createState,
  displayName,
  liveSessions,
  reduce,
  type Action,
  type SessionView,
} from "./reducer.ts";

const session = (id: string, extra: Partial<SessionView> = {}): SessionView => ({
  id,
  title: id,
  directory: "/tmp/project",
  ...extra,
});

function created(state = createState(), views: SessionView[] = [session("ses_a")]) {
  return { state, actions: reduce(state, { kind: "discovered", sessions: views }) };
}

test("a created session is born idle and named after its title", () => {
  const { actions } = created();
  assert.deepEqual(actions, [
    { type: "post", sessionID: "ses_a", status: "idle", name: "ses_a" },
  ]);
});

test("display names fall back to the project directory and cap at 128 bytes", () => {
  assert.equal(displayName({ id: "s", title: "  ", directory: "/tmp/project" }), "project");
  assert.equal(displayName({ id: "s", title: null, directory: "/tmp/project/" }), "project");
  assert.equal(displayName({ id: "s", title: "" }), "");
  const long = displayName({ id: "s", title: "漢".repeat(100) });
  assert.ok(Buffer.byteLength(long, "utf8") <= 128);
  assert.equal(long, "漢".repeat(42)); // 42 * 3 = 126 bytes, the 43rd would overflow
});

test("execution start works, repeated starts are idempotent, terminal ends idle", () => {
  const state = createState();
  created(state);
  const start = reduce(state, { kind: "execution-started", sessionID: "ses_a" });
  assert.deepEqual(start, [
    { type: "post", sessionID: "ses_a", status: "working", name: "ses_a" },
  ]);
  assert.deepEqual(reduce(state, { kind: "execution-started", sessionID: "ses_a" }), []);
  const end = reduce(state, { kind: "execution-ended", sessionID: "ses_a" });
  assert.deepEqual(end, [
    { type: "post", sessionID: "ses_a", status: "idle", name: "ses_a" },
  ]);
});

test("overlapping prompts stay blocked until the last one clears", () => {
  const state = createState();
  created(state);
  const first = reduce(state, { kind: "permission-asked", sessionID: "ses_a", requestID: "per_1" });
  assert.deepEqual(first, [
    { type: "post", sessionID: "ses_a", status: "blocked", name: "ses_a" },
  ]);
  assert.deepEqual(
    reduce(state, { kind: "form-created", sessionID: "ses_a", formID: "frm_1" }),
    [],
  );
  assert.deepEqual(
    reduce(state, { kind: "permission-replied", sessionID: "ses_a", requestID: "per_1" }),
    [],
  );
  const last = reduce(state, { kind: "form-cancelled", sessionID: "ses_a", formID: "frm_1" });
  assert.deepEqual(last, [
    { type: "post", sessionID: "ses_a", status: "idle", name: "ses_a" },
  ]);
});

test("a prompt that clears while work continues falls back to working", () => {
  const state = createState();
  created(state);
  reduce(state, { kind: "execution-started", sessionID: "ses_a" });
  reduce(state, { kind: "permission-asked", sessionID: "ses_a", requestID: "per_1" });
  const after = reduce(state, {
    kind: "permission-replied",
    sessionID: "ses_a",
    requestID: "per_1",
  });
  assert.deepEqual(after, [
    { type: "post", sessionID: "ses_a", status: "working", name: "ses_a" },
  ]);
});

test("reconciliation corrects a missed start per session", () => {
  const state = createState();
  created(state, [session("ses_a"), session("ses_b")]);
  reduce(state, { kind: "execution-started", sessionID: "ses_a" });
  // The start was missed for ses_b, so only a successful read can correct it.
  const actions = [
    ...reduce(state, { kind: "reconcile", sessionID: "ses_a", view: { ...session("ses_a"), executing: false } }),
    ...reduce(state, { kind: "reconcile", sessionID: "ses_b", view: { ...session("ses_b"), executing: true } }),
  ];
  assert.deepEqual(actions, [
    { type: "post", sessionID: "ses_a", status: "idle", name: "ses_a" },
    { type: "post", sessionID: "ses_b", status: "working", name: "ses_b" },
  ]);
});

test("a failed or skipped read changes nothing", () => {
  const state = createState();
  created(state);
  reduce(state, { kind: "execution-started", sessionID: "ses_a" });
  // A failed read never reaches the reducer; a skipped prompt read omits the
  // field, and neither may touch the resident's state.
  assert.deepEqual(reduce(state, { kind: "reconcile", sessionID: "ses_a", view: null }), []);
});

test("a failed prompt read never empties the pending set", () => {
  const state = createState();
  created(state);
  reduce(state, { kind: "permission-asked", sessionID: "ses_a", requestID: "per_1" });
  const failed = reduce(state, {
    kind: "reconcile",
    sessionID: "ses_a",
    view: { ...session("ses_a"), executing: false },
    permissions: null,
  });
  // Status is unchanged (still blocked), so a renew-only post is all it is.
  assert.deepEqual(failed, []);
  const ok = reduce(state, {
    kind: "reconcile",
    sessionID: "ses_a",
    view: { ...session("ses_a"), executing: false },
    permissions: [],
  });
  assert.deepEqual(ok, [
    { type: "post", sessionID: "ses_a", status: "idle", name: "ses_a" },
  ]);
});

test("reconciliation picks up a prompt whose events were missed", () => {
  const state = createState();
  created(state);
  const actions = reduce(state, {
    kind: "reconcile",
    sessionID: "ses_a",
    view: { ...session("ses_a"), executing: true },
    permissions: ["per_9"],
  });
  assert.deepEqual(actions, [
    { type: "post", sessionID: "ses_a", status: "blocked", name: "ses_a" },
  ]);
});

test("an authoritative not-found removes the resident at once", () => {
  const state = createState();
  created(state);
  const actions = reduce(state, { kind: "reconcile", sessionID: "ses_a", view: null, missing: true });
  assert.deepEqual(actions, [{ type: "delete", sessionID: "ses_a" }]);
  // And it stays gone: a later read cannot resurrect it.
  assert.deepEqual(reduce(state, { kind: "reconcile", sessionID: "ses_a", view: { ...session("ses_a"), executing: true } }), []);
});

test("a rename is cached so the next transition carries it", () => {
  const state = createState();
  created(state);
  // A rename alone posts nothing: the bridge ignores a name on an unchanged
  // status, so it lands with the next real transition.
  assert.deepEqual(reduce(state, { kind: "renamed", sessionID: "ses_a", title: "new name" }), []);
  const actions = reduce(state, { kind: "execution-started", sessionID: "ses_a" });
  assert.deepEqual(actions, [
    { type: "post", sessionID: "ses_a", status: "working", name: "new name" },
  ]);
});

test("child sessions never get a resident", () => {
  const state = createState();
  const actions = reduce(state, {
    kind: "discovered",
    sessions: [session("ses_parent"), session("ses_child", { parentID: "ses_parent" })],
  });
  assert.deepEqual(actions, [
    { type: "post", sessionID: "ses_parent", status: "idle", name: "ses_parent" },
  ]);
  assert.deepEqual(liveSessions(state), ["ses_parent"]);
});

test("a deleted session is removed once and stays gone", () => {
  const state = createState();
  created(state);
  reduce(state, { kind: "execution-started", sessionID: "ses_a" });
  const gone = reduce(state, { kind: "deleted", sessionID: "ses_a" });
  assert.deepEqual(gone, [{ type: "delete", sessionID: "ses_a" }]);
  assert.deepEqual(reduce(state, { kind: "deleted", sessionID: "ses_a" }), []);
  assert.deepEqual(reduce(state, { kind: "execution-ended", sessionID: "ses_a" }), []);
  assert.deepEqual(liveSessions(state), []);
});

test("deletion supersedes a queued write for the same session", () => {
  const state = createState();
  created(state);
  const queued: Action[] = reduce(state, {
    kind: "permission-asked",
    sessionID: "ses_a",
    requestID: "per_1",
  });
  const gone = reduce(state, { kind: "deleted", sessionID: "ses_a" });
  // The delivery layer applies actions in order, so the delete lands last.
  assert.deepEqual([...queued, ...gone].map((a) => a.type), ["post", "delete"]);
  assert.deepEqual(reduce(state, { kind: "tick" }), []);
});

test("a session that runs again after deletion is reported again", () => {
  const state = createState();
  created(state);
  reduce(state, { kind: "deleted", sessionID: "ses_a" });
  const again = reduce(state, { kind: "execution-started", sessionID: "ses_a" });
  assert.deepEqual(again, [
    { type: "post", sessionID: "ses_a", status: "working", name: "ses_a" },
  ]);
  assert.deepEqual(liveSessions(state), ["ses_a"]);
});

test("a heartbeat renews every live session even when nothing changed", () => {
  const state = createState();
  created(state, [session("ses_a"), session("ses_b")]);
  reduce(state, { kind: "execution-started", sessionID: "ses_b" });
  assert.deepEqual(reduce(state, { kind: "tick" }), [
    { type: "post", sessionID: "ses_a", status: "idle", name: "ses_a" },
    { type: "post", sessionID: "ses_b", status: "working", name: "ses_b" },
  ]);
});

test("events for an unknown session are ignored rather than inventing a resident", () => {
  const state = createState();
  assert.deepEqual(reduce(state, { kind: "execution-started", sessionID: "ses_x" }), []);
  assert.deepEqual(
    reduce(state, { kind: "permission-asked", sessionID: "ses_x", requestID: "per_1" }),
    [],
  );
  assert.deepEqual(liveSessions(state), []);
});

test("a prompt outliving its turn keeps the resident blocked", () => {
  const state = createState();
  created(state);
  reduce(state, { kind: "execution-started", sessionID: "ses_a" });
  reduce(state, { kind: "permission-asked", sessionID: "ses_a", requestID: "per_1" });
  const actions = reduce(state, { kind: "execution-ended", sessionID: "ses_a" });
  assert.deepEqual(actions, []);
  assert.equal(reduce(state, { kind: "tick" })[0].status, "blocked");
});

test("a later metadata read refreshes the name on the next transition", () => {
  const state = createState();
  created(state);
  reduce(state, {
    kind: "discovered",
    sessions: [{ id: "ses_a", title: "renamed", directory: null }],
  });
  assert.deepEqual(reduce(state, { kind: "execution-started", sessionID: "ses_a" }), [
    { type: "post", sessionID: "ses_a", status: "working", name: "renamed" },
  ]);
});

test("a delete for an untracked session still sends DELETE", () => {
  // After a reload this reporter never saw the session, but the resident it
  // left behind still exists: a DELETE is the only way to clear it now.
  const state = createState();
  assert.deepEqual(reduce(state, { kind: "deleted", sessionID: "ses_unknown" }), [
    { type: "delete", sessionID: "ses_unknown" },
  ]);
});
