/**
 * Pure state reducer for the Agent Machi reporter.
 *
 * Fresh observations go in, `/report` actions come out. No I/O, no timers, no
 * OpenCode types: the whole state model is testable on its own.
 *
 * The wiring applies one observation at a time, in arrival order, so this
 * reducer never has to decide which of two conflicting reads was fresher. It
 * only decides what the resulting resident status is.
 *
 * There are no tombstones. A session that is gone simply stops being a
 * resident, and the wiring never re-admits one from an event: every admission
 * is backed by a read that came back live and not archived. That is what makes
 * "a removed resident cannot come back on a stale event" true by construction
 * instead of by remembered state.
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
}

export interface State {
  readonly sessions: Map<string, Tracked>;
}

export type Input =
  | { kind: "discovered"; sessions: readonly SessionView[] }
  | {
      kind: "renamed";
      sessionID: string;
      title: string | null;
      /** Used when the title is cleared, so the name falls back like admission. */
      directory?: string | null;
    }
  | { kind: "execution-started"; sessionID: string }
  | { kind: "execution-ended"; sessionID: string }
  | { kind: "permission-asked"; sessionID: string; requestID: string }
  | { kind: "permission-replied"; sessionID: string; requestID: string }
  | { kind: "form-created"; sessionID: string; formID: string }
  | { kind: "form-replied"; sessionID: string; formID: string }
  | { kind: "form-cancelled"; sessionID: string; formID: string }
  | { kind: "permissions"; sessionID: string; permissions: readonly string[] }
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
      /**
       * The row proves the session exists after this reporter had recorded its
       * removal. Prompts from the ended incarnation are dropped, not carried.
       */
      revived?: boolean;
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
  if (!tracked) return;
  const status = effective(tracked);
  if (tracked.reported === status) return;
  tracked.reported = status;
  out.push({ type: "post", sessionID, status, ...(tracked.name ? { name: tracked.name } : {}) });
}

/**
 * Apply a fresh row: admit the session, or correct the resident in place.
 *
 * A row is a read result, so it is by definition the freshest thing applied.
 * It never touches the prompt sets: those belong to prompt events and to
 * prompt reads, and a metadata read knows nothing about them.
 */
function applyView(state: State, view: SessionView, out: Action[]): void {
  // Child sessions live inside their parent's work and get no resident.
  if (view.parentID) return;
  const tracked = state.sessions.get(view.id);
  const name = displayName(view);
  if (!tracked) {
    state.sessions.set(view.id, {
      underlying: view.executing ? "working" : "idle",
      permissions: new Set(),
      forms: new Set(),
      name,
      reported: null,
    });
  } else {
    if (name !== "") tracked.name = name;
    tracked.underlying = view.executing ? "working" : "idle";
  }
  sync(state, view.id, out);
}

/** Remove a resident, now that an observation proved it is not there. */
function remove(state: State, sessionID: string, out: Action[]): void {
  const tracked = state.sessions.get(sessionID);
  // Not tracked (a reload dropped it, or it predates this reporter) but the
  // resident may still exist from an earlier instance. A DELETE for an absent
  // row is a no-op, so it is always sent: that is what makes a delete after a
  // reload take effect now instead of at TTL.
  if (tracked) {
    tracked.permissions.clear();
    tracked.forms.clear();
    state.sessions.delete(sessionID);
  }
  out.push({ type: "delete", sessionID });
}

export function reduce(state: State, input: Input): Action[] {
  const out: Action[] = [];

  switch (input.kind) {
    case "discovered": {
      for (const view of input.sessions) applyView(state, view, out);
      return out;
    }

    case "renamed": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked) return out;
      const name = displayName({
        id: input.sessionID,
        title: input.title,
        directory: input.directory ?? null,
      });
      // The bridge refreshes metadata only when the status changes, so this
      // only caches the name: the next accepted transition carries it.
      if (name !== "") tracked.name = name;
      return out;
    }

    case "execution-started": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked) return out;
      tracked.underlying = "working";
      sync(state, input.sessionID, out);
      return out;
    }

    case "execution-ended": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked) return out;
      tracked.underlying = "idle";
      // Pending prompts are cleared only by their own terminal events or a
      // successful read: a prompt can outlive the turn that raised it.
      sync(state, input.sessionID, out);
      return out;
    }

    case "permission-asked": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked) return out;
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
      if (!tracked) return out;
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

    case "permissions": {
      // A successful prompt read is authoritative for the set, even when the
      // metadata read that accompanied it was inconclusive: the reply event for
      // a prompt is exactly what a missed event leaves stale.
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked) return out;
      tracked.permissions.clear();
      for (const id of input.permissions) tracked.permissions.add(id);
      sync(state, input.sessionID, out);
      return out;
    }

    case "deleted": {
      remove(state, input.sessionID, out);
      return out;
    }

    case "tick": {
      // Heartbeat: renew every live lease even when nothing changed.
      for (const [sessionID, tracked] of state.sessions) {
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
      if (input.missing) {
        // An authoritative absence removes the resident now instead of waiting
        // for the bridge's TTL. An unknown id is left alone: the passes only
        // walk residents, and an event's admission never needed to delete.
        if (!state.sessions.has(input.sessionID)) return out;
        remove(state, input.sessionID, out);
        return out;
      }
      if (!input.view) return out;
      // A revival is a different incarnation. Prompts belong to the one that
      // ended, and a permission read can never clear a form, so leaving them
      // would keep the new resident blocked by a question that was answered —
      // or abandoned — before it existed.
      if (input.revived) {
        const previous = state.sessions.get(input.sessionID);
        if (previous) {
          previous.permissions.clear();
          previous.forms.clear();
        }
      }
      applyView(state, input.view, out);
      // A set is replaced only on a successful read; a skipped read leaves the
      // event-derived set alone because prompt reads are location-scoped.
      const tracked = state.sessions.get(input.sessionID);
      if (tracked && input.permissions) {
        tracked.permissions.clear();
        for (const id of input.permissions) tracked.permissions.add(id);
        sync(state, input.sessionID, out);
      }
      return out;
    }
  }
}

/** Sessions the reporter currently owns, in insertion order. */
export function liveSessions(state: State): string[] {
  return [...state.sessions.keys()];
}
