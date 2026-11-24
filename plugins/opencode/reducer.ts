/**
 * Pure state reducer for the Agent Machi reporter.
 *
 * Normalized observations go in, `/report` actions come out. No I/O, no
 * timers, no OpenCode types: the whole state model is testable on its own.
 *
 * The wiring applies one observation at a time, in arrival order, so this
 * reducer never has to decide which of two conflicting reads was fresher. It
 * only decides what the resulting resident status is.
 */

export type Underlying = "working" | "idle";
export type Status = "working" | "blocked" | "idle";

/** What the reporter needs to know about a session to name and filter it. */
export interface SessionView {
  readonly id: string;
  readonly parentID?: string | null;
  readonly title?: string | null;
  readonly directory?: string | null;
  /** True when the session is executing right now. */
  readonly executing?: boolean;
}

export interface Tracked {
  underlying: Underlying;
  readonly permissions: Set<string>;
  readonly forms: Set<string>;
  name: string;
  reported: Status | null;
  /**
   * Deleted or archived: no resident until a fresh, non-archived read finds it
   * again. The row stays as the tombstone, because the reducer needs to
   * remember that a bare event may not bring it back.
   */
  removed: boolean;
}

export interface State {
  readonly sessions: Map<string, Tracked>;
}

export type Input =
  | { kind: "discovered"; sessions: readonly SessionView[] }
  | { kind: "renamed"; sessionID: string; title: string | null }
  | { kind: "execution-started"; sessionID: string }
  | { kind: "execution-ended"; sessionID: string }
  | { kind: "permission-asked"; sessionID: string; requestID: string }
  | { kind: "permission-replied"; sessionID: string; requestID: string }
  | { kind: "form-created"; sessionID: string; formID: string }
  | { kind: "form-replied"; sessionID: string; formID: string }
  | { kind: "form-cancelled"; sessionID: string; formID: string }
  | { kind: "deleted"; sessionID: string }
  | { kind: "tick" }
  | {
      kind: "reconcile";
      sessionID: string;
      /** Fresh metadata, or null when the session is confirmed gone. */
      view: SessionView | null;
      /** The server answered "no such session", or it is archived. */
      missing?: boolean;
      /**
       * Pending permission ids, null for a failed read, or absent when the
       * read was skipped. Neither clears the event-derived set.
       */
      permissions?: readonly string[] | null;
    };

export type Action =
  | { type: "post"; sessionID: string; status: Status; name?: string }
  | { type: "delete"; sessionID: string };

export function createState(): State {
  return { sessions: new Map() };
}

/**
 * A resident name from a session title, else the project directory's basename,
 * capped at 128 UTF-8 bytes without splitting a character.
 */
export function displayName(view: SessionView): string {
  const title = (view.title ?? "").trim();
  if (title !== "") return capBytes(title, 128);
  const directory = (view.directory ?? "").replace(/\/+$/, "");
  const base = directory.slice(directory.lastIndexOf("/") + 1).trim();
  return base === "" ? "" : capBytes(base, 128);
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function capBytes(value: string, limit: number): string {
  if (byteLength(value) <= limit) return value;
  let out = "";
  for (const char of value) {
    if (byteLength(out + char) > limit) break;
    out += char;
  }
  return out;
}

function effective(tracked: Tracked): Status {
  if (tracked.permissions.size > 0 || tracked.forms.size > 0) return "blocked";
  return tracked.underlying;
}

/** Emit a report only when the effective status changed since the last one. */
function sync(state: State, sessionID: string, out: Action[]): void {
  const tracked = state.sessions.get(sessionID);
  if (!tracked || tracked.removed) return;
  const status = effective(tracked);
  if (tracked.reported === status) return;
  tracked.reported = status;
  out.push({ type: "post", sessionID, status, ...(tracked.name ? { name: tracked.name } : {}) });
}

/** A session admitted for the first time. */
function admit(state: State, view: SessionView): Tracked {
  const tracked: Tracked = {
    underlying: view.executing ? "working" : "idle",
    permissions: new Set(),
    forms: new Set(),
    name: displayName(view),
    reported: null,
    removed: false,
  };
  state.sessions.set(view.id, tracked);
  return tracked;
}

export function reduce(state: State, input: Input): Action[] {
  const out: Action[] = [];

  switch (input.kind) {
    case "discovered": {
      for (const view of input.sessions) {
        // Child sessions live inside their parent's work and get no resident.
        if (view.parentID) continue;
        // Admission only. A resident that already exists is updated by the
        // observations that follow it, in order — never by a second admission.
        if (state.sessions.has(view.id)) continue;
        admit(state, view);
        sync(state, view.id, out);
      }
      return out;
    }

    case "renamed": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked || tracked.removed) return out;
      const name = displayName({ id: input.sessionID, title: input.title });
      // The bridge refreshes metadata only when the status changes, so this
      // only caches the name: the next real transition carries it.
      if (name !== "") tracked.name = name;
      return out;
    }

    case "execution-started": {
      const tracked = state.sessions.get(input.sessionID);
      // A start alone never undoes a confirmed removal: the row may still be
      // archived. Revival goes through a fresh read that proves otherwise.
      if (!tracked || tracked.removed) return out;
      tracked.underlying = "working";
      sync(state, input.sessionID, out);
      return out;
    }

    case "execution-ended": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked || tracked.removed) return out;
      tracked.underlying = "idle";
      // Pending prompts are cleared only by their own terminal events or a
      // successful read: a prompt can outlive the turn that raised it.
      sync(state, input.sessionID, out);
      return out;
    }

    case "permission-asked": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked || tracked.removed) return out;
      tracked.permissions.add(input.requestID);
      sync(state, input.sessionID, out);
      return out;
    }

    case "permission-replied": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked) return out;
      tracked.permissions.delete(input.requestID);
      sync(state, input.sessionID, out);
      return out;
    }

    case "form-created": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked || tracked.removed) return out;
      tracked.forms.add(input.formID);
      sync(state, input.sessionID, out);
      return out;
    }

    case "form-replied":
    case "form-cancelled": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked) return out;
      tracked.forms.delete(input.formID);
      sync(state, input.sessionID, out);
      return out;
    }

    case "deleted": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked) {
        // Not tracked here (a reload dropped it, or it predates this reporter).
        // Its resident may still exist from an earlier instance, and a DELETE
        // for an absent row is a no-op, so it is always sent: that is what
        // makes a delete after a reload take effect now instead of at TTL.
        out.push({ type: "delete", sessionID: input.sessionID });
        return out;
      }
      if (tracked.removed) return out;
      tracked.removed = true;
      tracked.reported = null;
      tracked.permissions.clear();
      tracked.forms.clear();
      out.push({ type: "delete", sessionID: input.sessionID });
      return out;
    }

    case "tick": {
      // Heartbeat: renew every live lease even when nothing changed.
      for (const [sessionID, tracked] of state.sessions) {
        if (tracked.removed) continue;
        const status = effective(tracked);
        tracked.reported = status;
        out.push({
          type: "post",
          sessionID,
          status,
          ...(tracked.name ? { name: tracked.name } : {}),
        });
      }
      return out;
    }

    case "reconcile": {
      const tracked = state.sessions.get(input.sessionID);
      // An authoritative absence removes the resident now instead of waiting for
      // the bridge's TTL. A failed read never reaches here.
      if (input.missing) {
        if (!tracked) {
          out.push({ type: "delete", sessionID: input.sessionID });
          return out;
        }
        if (tracked.removed) return out;
        tracked.removed = true;
        tracked.reported = null;
        tracked.permissions.clear();
        tracked.forms.clear();
        out.push({ type: "delete", sessionID: input.sessionID });
        return out;
      }
      if (!input.view) return out;
      if (!tracked) {
        admit(state, input.view);
      } else {
        // An observation is the freshest thing there is: it is applied in
        // arrival order, so it may correct the resident directly.
        const name = displayName(input.view);
        if (name !== "") tracked.name = name;
        if (tracked.removed) {
          // A read proved the session live again: it is a new run, and prompt
          // state from before its removal does not carry over.
          tracked.removed = false;
          tracked.reported = null;
          tracked.permissions.clear();
          tracked.forms.clear();
        }
        tracked.underlying = input.view.executing ? "working" : "idle";
      }
      // A set is replaced only on a successful read; a skipped read leaves the
      // event-derived set alone because prompt reads are location-scoped.
      if (input.permissions) {
        const current = state.sessions.get(input.sessionID);
        if (current) {
          current.permissions.clear();
          for (const id of input.permissions) current.permissions.add(id);
        }
      }
      sync(state, input.sessionID, out);
      return out;
    }
  }
}

/** Sessions the reporter currently owns, in insertion order. */
export function liveSessions(state: State): string[] {
  return [...state.sessions].filter(([, tracked]) => !tracked.removed).map(([id]) => id);
}
