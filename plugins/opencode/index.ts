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
    const dispatch = (input: Input): void => {
      try {
        const actions = reduce(state, input);
        for (const action of actions) send(action);
      } catch {
        // A reducer fault must never surface in the host's event loop.
      }
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
        dispatch({ kind: "discovered", sessions: views });
      }
      // Pending prompts outlive a turn, so read them for every live resident,
      // not just the ones executing right now. Permission requests have a read
      // endpoint on the plugin context; forms do not on 2.2.6, so form state is
      // event-only and a form that opens and clears between two checks can be
      // missed (see README).
      const permissions = await readPermissions(liveSessions(state));
      dispatch({ kind: "reconcile", active, permissions });
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

    const onEvent = (event: any): void => {
      const data = event?.data;
      if (!data) return;
      switch (event?.type) {
        case "session.created":
          if (typeof data.sessionID === "string") void discover(data.sessionID);
          return;
        case "session.execution.started":
          if (typeof data.sessionID === "string") {
            void discover(data.sessionID).then(() => dispatch({ kind: "execution-started", sessionID: data.sessionID }));
          }
          return;
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          if (typeof data.sessionID === "string") dispatch({ kind: "execution-ended", sessionID: data.sessionID });
          return;
        case "permission.asked":
          if (typeof data.sessionID === "string" && typeof data.id === "string") {
            const { sessionID, id } = data;
            // A prompt can arrive before any execution event for its session;
            // resolve the session first so the prompt is not dropped.
            void discover(sessionID).then(() => dispatch({ kind: "permission-asked", sessionID, requestID: id }));
          }
          return;
        case "permission.replied":
          if (typeof data.sessionID === "string" && typeof data.requestID === "string") {
            dispatch({ kind: "permission-replied", sessionID: data.sessionID, requestID: data.requestID });
          }
          return;
        case "form.created": {
          const formID = data?.form?.id;
          const sessionID = data?.form?.sessionID;
          if (typeof sessionID === "string" && typeof formID === "string") {
            const { sessionID: sid, id } = data.form;
            void discover(sid).then(() => dispatch({ kind: "form-created", sessionID: sid, formID: id }));
          }
          return;
        }
        case "form.replied":
        case "form.cancelled":
          if (typeof data.sessionID === "string" && typeof data.id === "string") {
            dispatch({
              kind: event.type === "form.replied" ? "form-replied" : "form-cancelled",
              sessionID: data.sessionID,
              formID: data.id,
            });
          }
          return;
        case "session.deleted":
        case "session.archived":
          if (typeof data.sessionID === "string") dispatch({ kind: "deleted", sessionID: data.sessionID });
          return;
        default:
          return;
      }
    };

    const controller = new AbortController();
    const stream = (async () => {
      try {
        // Subscribe before reconciling so no event lands between the two.
        const events = ctx?.event?.subscribe?.({ signal: controller.signal });
        // Kick the bootstrap off after the subscription is established.
        void reconcile(true);
        for await (const event of events ?? []) onEvent(event);
      } catch {
        // The stream ended (server shutdown or reload); cleanup follows.
      }
    })();

    const heartbeat = setInterval(() => {
      void reconcile(false).then(() => dispatch({ kind: "tick" }));
    }, HEARTBEAT_MS);
    (heartbeat as unknown as { unref?: () => void }).unref?.();

    return () => {
      controller.abort();
      clearInterval(heartbeat);
      void delivery.drain().catch(() => undefined);
      void stream;
    };
  },
};

export default AgentMachiReporter;
