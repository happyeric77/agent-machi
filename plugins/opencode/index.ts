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
/** Bound for one metadata read, so a stall can never hold a session's chain. */
const READ_TIMEOUT_MS = 5_000;
/** Sessions per listing page while seeding; the API returns 50 by default. */
const SEED_PAGE = 200;
/** Hard stop for bootstrap paging, so a huge history cannot delay seeding. */
const SEED_MAX_PAGES = 25;

export interface ReporterOptions {
  readonly bridgeUrl?: unknown;
  readonly machineId?: unknown;
}

interface SessionRow {
  id?: string;
  parentID?: string | null;
  title?: string | null;
  location?: { directory?: string | null } | null;
  time?: { busy?: number; idle?: number; archived?: number } | null;
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

/**
 * A session is executing while its busy stamp is newer than its idle stamp and
 * it started inside this server process. `time.idle` is absent until the first
 * turn completes, so a session in its first-ever turn counts as executing.
 * The process guard matters after a crash: a server killed mid-run leaves
 * busy > idle forever, and without it bootstrap would resurrect that session.
 */
function isExecuting(row: SessionRow, since: number): boolean {
  const busy = row.time?.busy;
  if (typeof busy !== "number" || busy < since) return false;
  const idle = row.time?.idle;
  return typeof idle !== "number" || busy > idle;
}

/** Returned when a read takes longer than the deadline. */
const TIMEOUT = Symbol("timeout");

/** Resolves to TIMEOUT on a stall; rejects exactly as the work rejects. */
async function within<T>(work: Promise<T>, ms = READ_TIMEOUT_MS): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Archived sessions still answer `get` and still appear in `list`; the only
 * trace is a stamp inside `time.archived` (verified on 2.2.6). An archived
 * session is not a resident, so it is excluded wherever rows are read, not
 * just where `session.archived` arrives — otherwise bootstrap and every
 * heartbeat would re-add a session the user archived.
 */
function isArchived(row: SessionRow): boolean {
  return typeof row.time?.archived === "number";
}

function isMissing(error: unknown): boolean {
  return (error as { _tag?: unknown })?._tag === "Session.NotFoundError";
}

/**
 * The event stream spans every location, but plugin setup runs once per
 * location and prompt reads are location-scoped. Exactly one live setup
 * reports.
 *
 * Ownership is claimed, not shared: a newer setup stops the previous one and
 * takes over. The registry lives on `globalThis` because a config reload may
 * re-evaluate this module, and a module-level variable would then forget the
 * reporter that is still running. Preemption is deliberate — if the previous
 * setup's cleanup never runs, waiting for it would leave the town silent, and
 * a stale reporter is the worse failure of the two.
 */
const REGISTRY = Symbol.for("agent-machi.reporter");

interface Slot {
  start: () => (() => void) | null;
  stop: (() => void) | null;
}

function registry(): { active: Slot | null } {
  const host = globalThis as unknown as Record<symbol, { active: Slot | null } | undefined>;
  return (host[REGISTRY] ??= { active: null });
}

export const AgentMachiReporter = {
  id: "agent-machi-reporter",
  async setup(ctx: any) {
    const config = parseOptions(ctx?.options, serverEnv("AGENT_MACHI_INGEST_TOKEN"));
    // Missing or invalid config disables reporting without touching the host.
    if (!config) return;

    const ownDirectory = typeof ctx?.location?.directory === "string" ? ctx.location.directory : null;
    const slot: Slot = {
      stop: null,
      start: () => {
        const state = createState();
        const delivery = createDelivery(config);
        const send = (action: Action): void => {
          const write: Write =
            action.type === "delete"
              ? { type: "delete", sessionID: action.sessionID }
              : { type: "post", sessionID: action.sessionID, status: action.status, name: action.name };
          delivery.enqueue(write);
        };
        // Events and metadata lookups for one session run in arrival order, so
        // a deferred lookup can never land after the terminal event it follows.
        const chains = new Map<string, Promise<void>>();
        let unloaded = false;
        // Every arrival for a session bumps its version. A read that started
        // earlier is then discarded for that session only, so one session's
        // activity can never starve another's reconciliation.
        const versions = new Map<string, number>();
        const bump = (sessionID: string): void => {
          versions.set(sessionID, (versions.get(sessionID) ?? 0) + 1);
        };
        const dispatch = (input: Input): void => {
          if (unloaded) return;
          try {
            for (const action of reduce(state, input)) send(action);
          } catch {
            // A reducer fault must never surface in the host's event loop.
          }
        };
        const enqueueFor = (sessionID: string, work: () => Promise<void> | void): void => {
          const previous = chains.get(sessionID) ?? Promise.resolve();
          const next = previous.then(work).catch(() => undefined);
          chains.set(sessionID, next);
          void next.then(() => {
            if (chains.get(sessionID) === next) chains.delete(sessionID);
          });
        };

        const bootSince = Date.now() - uptimeMs();

        const viewOf = (info: any): SessionView => ({
          id: String(info.id),
          parentID: info.parentID ?? null,
          title: info.title ?? null,
          directory: info.location?.directory ?? null,
          executing: isExecuting(info, bootSince),
        });

        /** Resolve one session's metadata unless a later arrival superseded it. */
        const discover = async (sessionID: string): Promise<void> => {
          const v = versions.get(sessionID) ?? 0;
          let info: any;
          try {
            info = await within(Promise.resolve(ctx?.session?.get?.({ sessionID })));
          } catch {
            return; // unknown or vanished: nothing to report
          }
          if (info === TIMEOUT || unloaded) return;
          const row = info?.data ?? info;
          if (!row?.id || !unchangedRow(versions, sessionID, v)) return;
          dispatch({ kind: "discovered", sessions: [viewOf(row)] });
        };

        const ensure = async (sessionID: string): Promise<void> => {
          if (state.sessions.has(sessionID)) return;
          await discover(sessionID);
        };

        /** Page the whole session list: the API returns 50 newest by default. */
        const allRows = async (): Promise<SessionRow[] | null> => {
          const rows: SessionRow[] = [];
          let cursor: string | null = null;
          for (let page = 0; page < SEED_MAX_PAGES; page += 1) {
            let listed: any;
            try {
              listed = await within(
                Promise.resolve(ctx?.session?.list?.({ limit: SEED_PAGE, ...(cursor ? { cursor } : {}) })),
              );
            } catch {
              return null;
            }
            if (listed === TIMEOUT) return null;
            const batch = listed?.data ?? listed;
            if (!Array.isArray(batch)) return null;
            rows.push(...batch);
            cursor = typeof listed?.cursor?.next === "string" ? listed.cursor.next : null;
            if (cursor === null || batch.length === 0) return rows;
          }
          return rows;
        };

        /** Seed sessions executing at load, and never one deleted meanwhile. */
        const seed = async (): Promise<void> => {
          const marks = new Map(versions);
          const rows = await allRows();
          if (rows === null || unloaded) return;
          const views: SessionView[] = [];
          for (const row of rows) {
            if (!row.id || row.parentID || isArchived(row) || !isExecuting(row, bootSince)) continue;
            // A newer event for this session already reported it: a seeded view
            // may be older than that event, so it must not overwrite it.
            if (!unchangedRow(versions, row.id, marks.get(row.id) ?? 0)) continue;
            views.push(viewOf(row));
          }
          if (views.length > 0) dispatch({ kind: "discovered", sessions: views });
        };

        /** One session's ground truth: gone, executing, name, pending prompts. */
        const check = async (sessionID: string): Promise<void> => {
          const v = versions.get(sessionID) ?? 0;
          let info: any;
          try {
            info = await within(ctx.session.get({ sessionID }));
          } catch (error) {
            // A specific not-found is authoritative; a failed or timed-out read
            // is not, so the resident stays until the next pass.
            if (isMissing(error) && unchangedRow(versions, sessionID, v)) {
              dispatch({ kind: "reconcile", sessionID, view: null, missing: true });
            }
            return;
          }
          if (info === TIMEOUT || unloaded || !unchangedRow(versions, sessionID, v)) return;
          const row = info?.data ?? info;
          if (!row?.id) return;
          // An archived session still answers reads. It is not a resident, and
          // archiving is only visible as a stamp inside `time`.
          if (isArchived(row)) {
            dispatch({ kind: "reconcile", sessionID, view: null, missing: true });
            return;
          }
          const view = viewOf(row);
          // Prompt reads are location-scoped: for a session in another
          // location the read would return that location's prompts, not this
          // session's. Without a known own location, guessing is worse than
          // staying event-only.
          let permissions: readonly string[] | null | undefined;
          if (ownDirectory !== null && view.directory === ownDirectory) {
            permissions = await readPermissions(ctx, sessionID);
            if (!unchangedRow(versions, sessionID, v)) return;
          }
          dispatch({ kind: "reconcile", sessionID, view, permissions });
        };

        /** A reconcile pass over everything this reporter owns. */
        const reconcile = async (first: boolean): Promise<void> => {
          if (unloaded) return;
          if (first) await seed();
          // Snapshot the ids before the loop: a session seeded above joins the
          // next pass rather than being skipped by a mutation here.
          for (const sessionID of liveSessions(state)) {
            if (unloaded) return;
            await check(sessionID);
          }
        };

        const onEvent = (event: any): void => {
          const data = event?.data;
          if (!data) return;
          switch (event?.type) {
            case "session.created":
              if (typeof data.sessionID === "string") {
                bump(data.sessionID);
                enqueueFor(data.sessionID, () => discover(data.sessionID));
              }
              return;
            case "session.renamed":
              if (typeof data.sessionID === "string" && "title" in data) {
                const sessionID = data.sessionID;
                const title = typeof data.title === "string" ? data.title : null;
                bump(sessionID);
                enqueueFor(sessionID, async () => {
                  await ensure(sessionID);
                  dispatch({ kind: "renamed", sessionID, title });
                });
              }
              return;
            case "session.execution.started":
              if (typeof data.sessionID === "string") {
                const sessionID = data.sessionID;
                bump(sessionID);
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
                const sessionID = data.sessionID;
                bump(sessionID);
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
                bump(sessionID);
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
                bump(sessionID);
                enqueueFor(sessionID, () => dispatch({ kind: "permission-replied", sessionID, requestID }));
              }
              return;
            case "form.created": {
              const formID = data?.form?.id;
              const sessionID = data?.form?.sessionID;
              if (typeof sessionID === "string" && typeof formID === "string") {
                bump(sessionID);
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
                bump(sessionID);
                enqueueFor(sessionID, () => dispatch({ kind, sessionID, formID }));
              }
              return;
            case "session.deleted":
            case "session.archived":
              if (typeof data.sessionID === "string") {
                const sessionID = data.sessionID;
                bump(sessionID);
                // Behind any pending lookup, so a delete always outranks the
                // birth that lookup was about to report.
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
          // A dropped stream is retried, because events are the only live
          // signal: an ended stream must not leave the town frozen on stale
          // state.
          while (!unloaded && !controller.signal.aborted) {
            try {
              const events = ctx?.event?.subscribe?.({ signal: controller.signal });
              // Start consuming before reconciling. An async generator is
              // pull-based: while seed() is awaiting, nothing is reading it and
              // every event in that window is lost.
              const reader = (async () => {
                for await (const event of events ?? []) onEvent(event);
              })();
              const first = !seeded;
              seeded = true;
              void reconcile(first);
              await reader;
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
        // heartbeat. It also catches up immediately after a suspend/resume
        // where the interval was overdue, so a renewal never waits a period.
        let lastBeat = Date.now();
        let beating = false;
        const beat = async (): Promise<void> => {
          if (beating || unloaded) return;
          beating = true;
          lastBeat = Date.now();
          try {
            await reconcile(false);
          } catch {
            // A heartbeat fault must never surface; the next one retries.
          } finally {
            beating = false;
          }
          // Renewal happens even when a read failed: the lease is the point.
          dispatch({ kind: "tick" });
        };
        const heartbeat = setInterval(() => {
          if (Date.now() - lastBeat >= HEARTBEAT_MS) void beat();
        }, Math.min(60_000, HEARTBEAT_MS));
        (heartbeat as unknown as { unref?: () => void }).unref?.();

        return () => {
          // Unload: stop producing events and drop queued writes. Late lookups
          // are fenced by `unloaded` so they cannot enqueue after cleanup.
          unloaded = true;
          controller.abort();
          clearInterval(heartbeat);
          delivery.close();
          chains.clear();
          void stream;
        };
      },
    };

    const host = registry();
    // Take over from any earlier live setup: a reload re-evaluates this module,
    // so the previous instance is not reachable any other way.
    host.active?.stop?.();
    slot.stop = slot.start();
    host.active = slot;

    return () => {
      // A superseded setup's cleanup must not stop its replacement.
      if (host.active !== slot) return;
      host.active = null;
      slot.stop?.();
      slot.stop = null;
    };
  },
};

function unchangedRow(versions: Map<string, number>, sessionID: string, mark: number): boolean {
  return (versions.get(sessionID) ?? 0) === mark;
}

/** Reads a session's pending permission ids; a failed read is `null`. */
async function readPermissions(ctx: any, sessionID: string): Promise<readonly string[] | null> {
  let pending: any;
  try {
    pending = await within(Promise.resolve(ctx?.permission?.list?.({ sessionID })));
  } catch {
    return null;
  }
  if (pending === TIMEOUT) return null; // a failed read is never an empty set
  const rows: any[] = Array.isArray(pending) ? pending : (pending?.data ?? []);
  return rows.map((row: any) => String(row?.id ?? "")).filter((id) => id !== "");
}

export default AgentMachiReporter;

/** How long this server process has been up, in milliseconds. */
function uptimeMs(): number {
  const proc = (globalThis as { process?: { uptime?: () => number } }).process;
  const seconds = typeof proc?.uptime === "function" ? proc.uptime() : Number.NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}
