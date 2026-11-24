/**
 * Pure state reducer for the Agent Machi reporter.
 *
 * Normalized OpenCode events go in, `/report` actions come out. No I/O, no
 * timers, no OpenCode types: the whole state model is testable on its own.
 */

export type Underlying = "working" | "idle";
export type Status = "working" | "blocked" | "idle";

/** What the reporter needs to know about a session to name and filter it. */
export interface SessionView {
  readonly id: string;
  readonly parentID?: string | null;
  readonly title?: string | null;
  readonly directory?: string | null;
  /** True when the session is executing right now (bootstrap only). */
  readonly executing?: boolean;
}

export interface Tracked {
  underlying: Underlying;
  readonly permissions: Set<string>;
  readonly forms: Set<string>;
  name: string;
  reported: Status | null;
  /** Deleted or archived: no resident until the session runs again. */
  removed: boolean;
}

export interface State {
  readonly sessions: Map<string, Tracked>;
}

/** Pending-prompt reads keyed by session id. A null value is a failed read. */
export type PromptReads = Readonly<Record<string, readonly string[] | null>>;

export type Input =
  | { kind: "discovered"; sessions: readonly SessionView[] }
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
      /** Executing session ids, or null when the read failed. */
      active: readonly string[] | null;
      permissions?: PromptReads;
      forms?: PromptReads;
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

export function reduce(state: State, input: Input): Action[] {
  const out: Action[] = [];

  switch (input.kind) {
    case "discovered": {
      for (const view of input.sessions) {
        // Child sessions live inside their parent's work and get no resident.
        if (view.parentID) continue;
        // A deleted resident stays gone until its own events revive it.
        if (state.sessions.has(view.id)) continue;
        state.sessions.set(view.id, {
          underlying: view.executing ? "working" : "idle",
          permissions: new Set(),
          forms: new Set(),
          name: displayName(view),
          reported: null,
          removed: false,
        });
        sync(state, view.id, out);
      }
      return out;
    }

    case "execution-started": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked) return out;
      tracked.removed = false;
      tracked.underlying = "working";
      sync(state, input.sessionID, out);
      return out;
    }

    case "execution-ended": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked) return out;
      tracked.underlying = "idle";
      // A turn cannot end while it is waiting on a prompt, so any prompt still
      // in the set died with it. This also self-heals a missed reply event,
      // which would otherwise leave the resident blocked forever.
      tracked.permissions.clear();
      tracked.forms.clear();
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

    case "deleted": {
      const tracked = state.sessions.get(input.sessionID);
      if (!tracked || tracked.removed) return out;
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
      // Ground truth for execution membership. A failed read changes nothing.
      if (input.active) {
        const active = new Set(input.active);
        for (const [sessionID, tracked] of state.sessions) {
          if (tracked.removed) continue;
          tracked.underlying = active.has(sessionID) ? "working" : "idle";
        }
      }
      // Pending sets are replaced only per successful read.
      for (const [sessionID, ids] of Object.entries(input.permissions ?? {})) {
        if (ids === null) continue;
        const tracked = state.sessions.get(sessionID);
        if (!tracked) continue;
        tracked.permissions.clear();
        for (const id of ids) tracked.permissions.add(id);
      }
      for (const [sessionID, ids] of Object.entries(input.forms ?? {})) {
        if (ids === null) continue;
        const tracked = state.sessions.get(sessionID);
        if (!tracked) continue;
        tracked.forms.clear();
        for (const id of ids) tracked.forms.add(id);
      }
      for (const sessionID of state.sessions.keys()) sync(state, sessionID, out);
      return out;
    }
  }
}

/** Sessions the reporter currently owns, in insertion order. */
export function liveSessions(state: State): string[] {
  return [...state.sessions].filter(([, tracked]) => !tracked.removed).map(([id]) => id);
}
