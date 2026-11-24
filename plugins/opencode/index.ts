/**
 * Agent Machi reporter for OpenCode (V2 native plugin shape).
 *
 * Normalized events go into the pure reducer in reducer.ts; the actions it
 * emits are queued in delivery.ts, which talks to the bridge off the hook
 * path. This file is only the wiring: read options, subscribe, reconcile.
 */
import { createDelivery, type Write } from "./delivery.ts";
import {
  createState,
  liveSessions,
  reduce,
  type Action,
  type Input,
  type SessionView,
} from "./reducer.ts";

const HEARTBEAT_MS = 5 * 60 * 1000;
const RECONNECT_MS = 2_000;

export interface ReporterOptions {
  readonly bridgeUrl?: unknown;
  readonly machineId?: unknown;
}

interface SessionRow {
  id?: string;
  parentID?: string | null;
  title?: string | null;
  location?: { directory?: string | null } | null;
  time?: { busy?: number; idle?: number } | null;
}

/** The plugin runs inside the OpenCode server, which has a process env. */
function serverEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
}

function parseOptions(options: unknown, token: string | undefined) {
  if (!token) return null;
  const raw = (options ?? {}) as ReporterOptions;
  if (typeof raw.bridgeUrl !== "string" || typeof raw.machineId !== "string") return null;
  let bridgeUrl: URL;
  try {
    bridgeUrl = new URL(raw.bridgeUrl);
  } catch {
    return null;
  }
  if (bridgeUrl.protocol !== "http:" && bridgeUrl.protocol !== "https:") return null;
  // The bearer token travels in a header; never send it in the clear off-box.
  if (bridgeUrl.protocol !== "https:" && !isLoopback(bridgeUrl)) return null;
  // An id the bridge cannot accept is a configuration error, not a session
  // error: reject it before anything is tracked or logged.
  if (!/^[!-~]+$/.test(raw.machineId) || raw.machineId.includes(":")) return null;
  if (new TextEncoder().encode(raw.machineId).length > 100) return null;
  return {
    bridgeUrl,
    machineId: raw.machineId,
    token,
    source: "opencode",
    agent: "opencode",
  };
}

/** How long this server process has been up, in milliseconds. */
function uptimeMs(): number {
  const proc = (globalThis as { process?: { uptime?: () => number } }).process;
  const seconds = typeof proc?.uptime === "function" ? proc.uptime() : Number.NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

/**
 * A session is executing while its busy stamp is newer than its idle stamp and
 * it started inside this server process. The second condition matters after a
 * crash: a server killed mid-run leaves busy > idle forever, and without it
 * bootstrap would resurrect that session as working.
 */
function isExecuting(row: SessionRow, since: number): boolean {
  const busy = row.time?.busy;
  const idle = row.time?.idle;
  if (typeof busy !== "number" || typeof idle !== "number" || busy <= idle) return false;
  return busy >= since;
}

export const AgentMachiReporter = {
  id: "agent-machi-reporter",
  async setup(ctx: any) {
    const config = parseOptions(ctx?.options, serverEnv("AGENT_MACHI_INGEST_TOKEN"));
    // Missing or invalid config disables reporting without touching the host.
    if (!config) return;

    const state = createState();
    const delivery = createDelivery(config);
    const send = (action: Action): void => {
      const write: Write =
        action.type === "delete"
          ? { type: "delete", sessionID: action.sessionID }
          : { type: "post", sessionID: action.sessionID, status: action.status, name: action.name };
      delivery.enqueue(write);
    };
    // Every event bumps this. A reconcile read takes time, so a value that
    // changed underneath it is stale and must not overwrite the newer event.
    let mutations = 0;
    let unloaded = false;
    const dispatch = (input: Input, fromRead = false): void => {
      if (unloaded) return;
      if (!fromRead) mutations += 1;
      try {
        const actions = reduce(state, input);
        for (const action of actions) send(action);
      } catch {
        // A reducer fault must never surface in the host's event loop.
      }
    };

    // Events and metadata lookups for one session run in arrival order, so a
    // deferred lookup can never land after the terminal event it precedes.
    const chains = new Map<string, Promise<void>>();
    const enqueueFor = (sessionID: string, work: () => Promise<void> | void): void => {
      const previous = chains.get(sessionID) ?? Promise.resolve();
      const next = previous.then(work).catch(() => undefined);
      chains.set(sessionID, next);
      void next.then(() => {
        if (chains.get(sessionID) === next) chains.delete(sessionID);
      });
    };

    const bootSince = Date.now() - uptimeMs();

    const listRows = async (): Promise<SessionRow[]> => {
      const listed: any = await ctx?.session?.list?.({});
      const rows = listed?.data ?? listed;
      return Array.isArray(rows) ? rows : [];
    };

    /** Read each live session's pending permissions; failures stay null. */
    const readPermissions = async (ids: readonly string[]) => {
      const reads: Record<string, readonly string[] | null> = {};
      for (const sessionID of ids) {
        try {
          const pending: any = await ctx?.permission?.list?.({ sessionID });
          const rows: any[] = Array.isArray(pending) ? pending : (pending?.data ?? []);
          reads[sessionID] = rows.map((row: any) => String(row?.id ?? "")).filter((id) => id !== "");
        } catch {
          reads[sessionID] = null; // a failed read is never an empty set
        }
      }
      return reads;
    };

    const reconcile = async (seed: boolean): Promise<void> => {
      const at = mutations;
      let rows: SessionRow[];
      try {
        rows = await listRows();
      } catch {
        return; // a failed membership read changes nothing
      }
      const active = rows.filter((row) => row.id && isExecuting(row, bootSince)).map((row) => row.id as string);
      if (seed) {
        // Bootstrap only seeds what is executing now, never saved history.
        const views: SessionView[] = rows
          .filter((row) => row.id && isExecuting(row, bootSince))
          .map((row) => ({
            id: row.id as string,
            parentID: row.parentID ?? null,
            title: row.title ?? null,
            directory: row.location?.directory ?? null,
            executing: true,
          }));
        // Our own seeding is not a newer event, so it must not invalidate the
        // membership snapshot taken just above it.
        dispatch({ kind: "discovered", sessions: views }, true);
      }
      // Pending prompts outlive a turn, so read them for every live resident,
      // not just the ones executing right now. Permission requests have a read
      // endpoint on the plugin context; forms do not on 2.2.6, so form state is
      // event-only and a form that opens and clears between two checks can be
      // missed (see README).
      // A delete or archive event that never arrived would let a dead resident
      // renew forever. One authoritative read per tracked session settles it;
      // a failed read changes nothing.
      const gone: string[] = [];
      for (const sessionID of liveSessions(state)) {
        try {
          const got: any = await ctx?.session?.get?.({ sessionID });
          const info = got?.data ?? got;
          if (!info?.id) gone.push(sessionID);
        } catch {
          // Unknown outcome: keep the resident.
        }
      }
      const permissions = await readPermissions(liveSessions(state));
      // An event landed while reading; its state is newer than this snapshot.
      if (mutations !== at) return;
      dispatch({ kind: "reconcile", active, permissions }, true);
      for (const sessionID of gone) dispatch({ kind: "deleted", sessionID });
    };

    /** Resolve a session's metadata before reporting anything for it. */
    const discover = async (sessionID: string): Promise<void> => {
      try {
        const got: any = await ctx?.session?.get?.({ sessionID });
        const info = got?.data ?? got;
        if (!info?.id) return;
        dispatch({
          kind: "discovered",
          sessions: [
            {
              id: info.id,
              parentID: info.parentID ?? null,
              title: info.title ?? null,
              directory: info.location?.directory ?? null,
              executing: isExecuting(info, bootSince),
            },
          ],
        });
      } catch {
        // Unknown or vanished session: nothing to report.
      }
    };

    /** Resolve an unknown session before the event it carries is applied. */
    const ensure = async (sessionID: string): Promise<void> => {
      if (state.sessions.has(sessionID)) return;
      await discover(sessionID);
    };

    const onEvent = (event: any): void => {
      const data = event?.data;
      if (!data) return;
      switch (event?.type) {
        case "session.created":
          if (typeof data.sessionID === "string") {
            enqueueFor(data.sessionID, () => discover(data.sessionID));
          }
          return;
        case "session.execution.started":
          if (typeof data.sessionID === "string") {
            const { sessionID } = data;
            enqueueFor(sessionID, async () => {
              await ensure(sessionID);
              dispatch({ kind: "execution-started", sessionID });
            });
          }
          return;
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          if (typeof data.sessionID === "string") {
            const { sessionID } = data;
            enqueueFor(sessionID, async () => {
              // A start that never resolved must not swallow the end.
              await ensure(sessionID);
              dispatch({ kind: "execution-ended", sessionID });
            });
          }
          return;
        case "permission.asked":
          if (typeof data.sessionID === "string" && typeof data.id === "string") {
            const sessionID = data.sessionID;
            const requestID = data.id;
            enqueueFor(sessionID, async () => {
              await ensure(sessionID);
              dispatch({ kind: "permission-asked", sessionID, requestID });
            });
          }
          return;
        case "permission.replied":
          if (typeof data.sessionID === "string" && typeof data.requestID === "string") {
            const sessionID = data.sessionID;
            const requestID = data.requestID;
            enqueueFor(sessionID, () =>
              dispatch({ kind: "permission-replied", sessionID, requestID }),
            );
          }
          return;
        case "form.created": {
          const formID = data?.form?.id;
          const sessionID = data?.form?.sessionID;
          if (typeof sessionID === "string" && typeof formID === "string") {
            enqueueFor(sessionID, async () => {
              await ensure(sessionID);
              dispatch({ kind: "form-created", sessionID, formID });
            });
          }
          return;
        }
        case "form.replied":
        case "form.cancelled":
          if (typeof data.sessionID === "string" && typeof data.id === "string") {
            const sessionID = data.sessionID;
            const formID = data.id;
            const kind = event.type === "form.replied" ? "form-replied" : "form-cancelled";
            enqueueFor(sessionID, () => dispatch({ kind, sessionID, formID }));
          }
          return;
        case "session.deleted":
        case "session.archived":
          if (typeof data.sessionID === "string") {
            const { sessionID } = data;
            // Behind any pending lookup, so a delete always outranks the birth
            // that lookup was about to report.
            enqueueFor(sessionID, () => dispatch({ kind: "deleted", sessionID }));
          }
          return;
        default:
          return;
      }
    };

    const controller = new AbortController();
    let seeded = false;
    const stream = (async () => {
      // A dropped stream is retried, because events are the only live signal:
      // an ended stream must not leave the town frozen on stale state.
      while (!unloaded && !controller.signal.aborted) {
        try {
          const events = ctx?.event?.subscribe?.({ signal: controller.signal });
          if (!seeded) {
            // Subscribe before reconciling so no event lands between the two.
            seeded = true;
            void reconcile(true);
          } else {
            // Reconnect: events were missed, so re-read ground truth once.
            void reconcile(false);
          }
          for await (const event of events ?? []) onEvent(event);
        } catch {
          // Fall through to the backoff below.
        }
        if (unloaded || controller.signal.aborted) return;
        await new Promise((resolve) => {
          const retry = setTimeout(resolve, RECONNECT_MS);
          (retry as unknown as { unref?: () => void }).unref?.();
        });
      }
    })();

    // One reconcile at a time: a stalled read must not stack up behind the
    // heartbeat. It also catches up immediately after a suspend/resume where
    // the interval was overdue, so a renewal never waits a full period.
    let lastBeat = Date.now();
    let beating = false;
    const beat = async (): Promise<void> => {
      if (beating || unloaded) return;
      beating = true;
      lastBeat = Date.now();
      try {
        await reconcile(false);
        dispatch({ kind: "tick" });
      } catch {
        // A heartbeat fault must never surface; the next one retries.
      } finally {
        beating = false;
      }
    };
    const heartbeat = setInterval(() => {
      if (Date.now() - lastBeat >= HEARTBEAT_MS) void beat();
    }, Math.min(60_000, HEARTBEAT_MS));
    (heartbeat as unknown as { unref?: () => void }).unref?.();

    return () => {
      // Unload: stop producing events and drop queued writes. Late lookups are
      // fenced by `unloaded` so they cannot enqueue after cleanup returns.
      unloaded = true;
      controller.abort();
      clearInterval(heartbeat);
      delivery.close();
      chains.clear();
      void stream;
    };
  },
};

export default AgentMachiReporter;
