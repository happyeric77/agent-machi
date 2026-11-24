/**
 * Agent Machi reporter for OpenCode (V2 native plugin shape).
 *
 * Normalized events go into the pure reducer in reducer.ts; the actions it
 * emits are queued in delivery.ts, which talks to the bridge off the hook
 * path. This file is only the wiring: read options, subscribe, reconcile.
 *
 * All context reads run through one serial queue. Reads are the only place a
 * stale answer could commit — a metadata lookup racing a delete, a seed racing
 * a rename — and the queue makes that impossible rather than guarded: work
 * applied in arrival order means the last thing observed is always the thing
 * applied last. Renewals do not go through the queue; they are on their own
 * clock so a slow read can never let a lease lapse.
 */
import { createDelivery, reportURL, type Delivery, type Write } from "./delivery.ts";
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
/** Bound for one context read, so a stalled call cannot hold the queue. */
const READ_TIMEOUT_MS = 5_000;
/** Sessions per listing page while seeding; the API returns 50 by default. */
const SEED_PAGE = 200;
/** Hard stop for bootstrap paging, so a huge history cannot delay seeding. */
const SEED_MAX_PAGES = 25;
/** Retry interval for a bootstrap list read that failed. */
const SEED_RETRY_MS = 5_000;

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
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1"
  );
}

interface Config {
  readonly bridgeUrl: URL;
  readonly machineId: string;
  readonly token: string;
  readonly source: string;
  readonly agent: string;
}

function parseOptions(options: unknown, token: string | undefined): Config | null {
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
  return { bridgeUrl, machineId: raw.machineId, token, source: "opencode", agent: "opencode" };
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

/** Archived sessions still answer reads; the only trace is a `time` stamp. */
function isArchived(row: SessionRow): boolean {
  return typeof row.time?.archived === "number";
}

/** Returned when a read takes longer than its deadline. */
const TIMEOUT = Symbol("timeout");

/**
 * What an admission attempt established:
 * - `admitted`: the session is a resident now.
 * - `refused`: a read proved it is absent/archived, or a prompt event tried to
 *   revive a removed resident. Nothing may be parked.
 * - `unknown`: the read failed or stalled. A prompt must be kept, because the
 *   session may well exist and the event has no other way back.
 */
type Admission =
  | "admitted"
  /** Admitted by this call's own read, so that row is the freshest truth. */
  | "admitted-fresh"
  | "refused"
  | "absent"
  | "unknown";

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

function isMissing(error: unknown): boolean {
  return (error as { _tag?: unknown })?._tag === "Session.NotFoundError";
}

/** How long this server process has been up, in milliseconds. */
function uptimeMs(): number {
  const proc = (globalThis as { process?: { uptime?: () => number } }).process;
  const seconds = typeof proc?.uptime === "function" ? proc.uptime() : Number.NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

/** A read's outcome: a row, an authoritative absence, or "no answer". */
type Read = { kind: "row"; row: SessionRow } | { kind: "absent" } | { kind: "unknown" };

/** A live plugin setup: the context it was handed, and where that lives. */
interface Registration {
  readonly directory: string | null;
  readonly ctx: any;
}

/**
 * One reporter per report endpoint, shared by every live setup.
 *
 * The event stream spans every location while plugin setup runs once per
 * location, so a reporter cannot belong to a setup: opening another location,
 * or unloading one, may not discard another location's residents, and a
 * surviving setup has to keep renewing them. Setups register their context
 * here; state and delivery belong to the reporter.
 *
 * The registry lives on `globalThis` because a config reload may re-evaluate
 * this module, which would otherwise forget a reporter that is still running.
 */
class Reporter {
  private readonly config: Config;
  private readonly state = createState();
  private readonly delivery: Delivery;
  private readonly setups: Registration[] = [];
  /** Where each known session lives; the reducer only holds resident state. */
  private readonly directories = new Map<string, string | null>();
  /**
   * Sessions this reporter has observed being removed.
   *
   * A prompt event may admit a session it has never seen — otherwise the very
   * first prompt of a new session is lost while it is still `working` — but it
   * must never admit one that was removed: a form that outlived its session
   * would bring the resident back already blocked. The mark is set from every
   * authoritative absence (an archived row, `Session.NotFoundError`, an archive
   * event), even for an id that was never admitted, and cleared by any live
   * observation of the same session.
   */
  private readonly removed = new Set<string>();
  /**
   * Prompt events whose admission read failed transiently. A prompt is the only
   * thing a form has to go on, and a failed read must not silently drop it: the
   * event is applied as soon as the session is really admitted, and discarded
   * when the session turns out not to exist.
   */
  private readonly held: Input[] = [];
  /**
   * Prompt ids answered or cancelled by a terminal event that arrived while the
   * open event's admission read was still in flight.
   *
   * The terminal event is queued behind that read, so it cannot drop the parked
   * prompt in time — but it has already been consumed from the stream, so the
   * answer is a fact. This set carries it across the gap: the open event skips
   * itself (and is not parked) once it sees its own id here.
   */
  private readonly answered = new Set<string>();
  /** Answered keys retained; older ones cannot still be replayed. */
  private static readonly ANSWERED_MAX = 512;
  /**
   * Sessions a create event named whose admission read failed. They are still
   * unknown to the reducer, so no pass enumerates them; a later list row that
   * proves one live is what admits it, even if it has already gone idle.
   */
  private readonly pendingCreate = new Set<string>();
  /**
   * Sessions whose lifecycle event could not be admitted because its read
   * failed, with the transition that event carried. A create is not the only
   * way a session appears: after a revival the only events may be a start and a
   * form, and losing both leaves the town with a session it has been told about
   * and cannot see. The kind is kept because the admission that eventually
   * happens must report the run the host actually told us about, not whatever
   * the row happens to say.
   */
  private readonly pendingLifecycle = new Map<string, { kind: "working" | "ended"; at: number }>();
  /** When the last metadata read for a session was applied. */
  /**
   * Monotonic observation counter, used to order reads against events.
   *
   * A read takes its number when it STARTS, not when it finishes. That is the
   * whole point: a slow read cannot claim to know about an event that arrived
   * while it was in flight. An event captures the counter when it ARRIVES, and
   * may not be overwritten by a read whose number is not greater than its own —
   * the read began before the event did.
   *
   * Taking the number at start also makes ties impossible in the useful
   * direction: the read increments the counter, so an event arriving later
   * always carries a strictly larger number and always wins.
   */
  private readonly observed = new Map<string, number>();
  /**
   * The same counter for the pending-prompt set. A successful `permission.list`
   * is an observation of its own: an ask captured before it began may not
   * restore a block it proved gone. It says nothing about forms, which have no
   * read at all, so `form.created` does not consult it.
   */
  private readonly promptsAt = new Map<string, number>();
  /**
   * The counter for titles. A list page is the only metadata source when a
   * session's `get` is failing, but a title is not execution state: it gets its
   * own stamp so a title-only read can never suppress a start or an end.
   */
  private readonly titleAt = new Map<string, number>();
  /**
   * Sessions with a recheck already queued. A burst of events that each lose to
   * a read must schedule one fresh read, not one per event: the read answers all
   * of them, and a queue full of identical rechecks would starve real work.
   */
  private readonly recheckQueued = new Set<string>();
  /**
   * Sessions with a metadata read in flight. An event that arrives while a read
   * is running cannot be ordered against it by any counter — the read may have
   * taken its snapshot before the event and still return after it. The event's
   * own handler consults this when it runs; it is never a session-wide flag for
   * some later event to consume.
   */
  private readonly reading = new Set<string>();
  /** Sessions with a prompt read in flight, for the same reason. */
  private readonly readingPrompts = new Set<string>();
  /**
   * Execution events that lost to an in-flight read: kept until a read answers
   * for them. If every recheck fails, the event is applied rather than dropped,
   * because an event cannot be re-derived and a missing transition is worse than
   * a possibly stale one.
   */
  private readonly pendingExec = new Map<string, { kind: "working" | "ended"; at: number }>();
  /**
   * Prompt opens that lost to an in-flight prompt read, kept per session until a
   * read answers for them. A failed read cannot disprove an ask the host told us
   * about, so the ask is applied instead of vanishing — a form has no read to
   * recover it at all.
   */
  private readonly pendingPrompts = new Map<string, { input: Input; at: number }[]>();
  /**
   * Prompt events that have reached the reporter but whose queued task has not
   * run yet.
   *
   * A prompt read cannot see an ask that arrived while it was open, and the
   * ask's own task may still be waiting behind that read. Publishing the
   * snapshot alone would briefly report `idle` for a resident the host already
   * says is waiting, so the snapshot is merged with these.
   */
  private readonly inbound = new Map<string, { input: Input; at: number }[]>();
  /**
   * The observation number of the newest execution event already received for a
   * session, applied or still queued. A parked event older than this must not be
   * published: the newer event is a fact even before its own task runs, and
   * publishing the older one would report a run that has already ended.
   */
  private readonly execAt = new Map<string, number>();
  /** What that newest received execution event says, applied or not. */
  private readonly execKind = new Map<string, "working" | "ended">();
  /**
   * When this reporter was told the session is gone.
   *
   * Recorded on arrival, not when the queued removal task runs: between those
   * two moments a fallback must not publish a block or a transition for an
   * incarnation the host has already ended.
   */
  private readonly goneAt = new Map<string, number>();
  private markGone(sessionID: string, at: number): void {
    this.goneAt.delete(sessionID);
    this.goneAt.set(sessionID, Math.max(this.goneAt.get(sessionID) ?? 0, at));
  }
  /**
   * Forget work parked for a session that is gone. A parked event describes a
   * resident; once the resident is removed, replaying it would attach an old
   * transition or an old prompt to whatever incarnation comes next.
   */
  private forget(sessionID: string): void {
    this.pendingExec.delete(sessionID);
    this.execAt.delete(sessionID);
    this.execKind.delete(sessionID);
    this.pendingPrompts.delete(sessionID);
    this.inbound.delete(sessionID);
    this.pendingCreate.delete(sessionID);
    this.pendingLifecycle.delete(sessionID);
    this.discardHeld(sessionID);
    // The ordering marks describe an incarnation that is over. Keeping them
    // would let a dead session's freshness suppress a later, genuine one, and
    // they would accumulate for every session ever seen.
    this.observed.delete(sessionID);
    this.promptsAt.delete(sessionID);
    this.titleAt.delete(sessionID);
    this.openAsks.delete(sessionID);
  }
  private observation = 0;

  private nextObservation(): number {
    this.observation += 1;
    return this.observation;
  }

  /**
   * Ask for one fresh read of a session.
   *
   * Used when an event loses to a newer observation. Dropping the event is not
   * enough: that observation may itself be a snapshot of unknown age, and a
   * dropped event can never be re-derived. Re-reading asks the host which state
   * is true, so the reporter converges instead of quietly keeping the older of
   * two answers.
   */
  /**
   * Apply an execution event that no read could settle.
   *
   * Called when a metadata read proves nothing (it failed or timed out) for a
   * session whose execution event is still waiting. The event is the only
   * evidence left, so it is published rather than dropped.
   */
  private flushPendingExec(sessionID: string): void {
    const parked = this.pendingExec.get(sessionID);
    if (!parked) return;
    this.pendingExec.delete(sessionID);
    // A newer observation has already spoken for this session's execution
    // state, so the parked event is older than the truth: keep the truth.
    if ((this.observed.get(sessionID) ?? 0) > parked.at) return;
    // A newer execution event was received after this one, even if its own task
    // has not run yet. Publishing this one first would briefly report a run that
    // the newer event already knows is over.
    if ((this.execAt.get(sessionID) ?? 0) > parked.at) return;
    // A removal that arrived after this transition was parked still wins.
    if ((this.goneAt.get(sessionID) ?? 0) > parked.at) return;
    // A resident that no longer exists has nothing to receive this event.
    if (!this.state.sessions.has(sessionID)) return;
    // The fallback is itself an observation: recording it keeps an older queued
    // event from overwriting what this one just published.
    this.observed.set(sessionID, parked.at);
    this.dispatch(
      parked.kind === "working"
        ? { kind: "execution-started", sessionID }
        : { kind: "execution-ended", sessionID },
    );
  }

  /**
   * Apply prompt opens that no read could settle, after the read failed.
   *
   * Called only when the prompt read proved nothing: a successful list is
   * authoritative and supersedes whatever was waiting, while a failed one leaves
   * the ask as the sole evidence that a prompt exists.
   */
  /**
   * Prompt asks this reporter knows are open, with the arrival number of the
   * event that announced them.
   *
   * A snapshot only describes the prompts that existed when its read was
   * issued, so an ask announced after that moment cannot be disproved by it —
   * and the ask's own queued task may already have finished by the time the
   * snapshot lands. This keeps the fact that it is open, without keeping the
   * event.
   */
  private readonly openAsks = new Map<string, Map<string, { at: number; permission: boolean }>>();

  private noteAsk(sessionID: string, promptID: string, at: number, permission: boolean): void {
    const entry = this.openAsks.get(sessionID);
    const value = { at, permission };
    if (entry) entry.set(promptID, value);
    else this.openAsks.set(sessionID, new Map([[promptID, value]]));
  }

  private closeAsk(sessionID: string, promptID: string): void {
    const entry = this.openAsks.get(sessionID);
    if (!entry) return;
    entry.delete(promptID);
    if (entry.size === 0) this.openAsks.delete(sessionID);
  }

  /**
   * A snapshot that could see an ask and does not list it has disproved it. The
   * reducer's set is replaced anyway; this drops the durable copies too, or a
   * long-lived resident would accumulate one record per missed reply.
   */
  private settleOpenAsks(
    sessionID: string,
    permissions: readonly string[],
    promptsStartedAt: number,
  ): void {
    const entry = this.openAsks.get(sessionID);
    if (!entry) return;
    const listed = new Set(permissions);
    for (const [id, { at, permission }] of [...entry]) {
      if (!permission) continue; // forms are not observable by a permission read
      if (at < promptsStartedAt && !listed.has(id)) entry.delete(id);
    }
    if (entry.size === 0) this.openAsks.delete(sessionID);
  }

  /** Note a prompt event the moment it reaches the reporter. */
  private noteInbound(input: Input, at: number): void {
    const sessionID = heldSession(input);
    if (sessionID === null) return;
    const waiting = this.inbound.get(sessionID);
    if (waiting) waiting.push({ input, at });
    else this.inbound.set(sessionID, [{ input, at }]);
  }

  /** The event's own task is done with it: it is no longer in flight. */
  private clearInbound(input: Input): void {
    const sessionID = heldSession(input);
    if (sessionID === null) return;
    const waiting = this.inbound.get(sessionID);
    if (!waiting) return;
    const rest = waiting.filter((entry) => entry.input !== input);
    if (rest.length > 0) this.inbound.set(sessionID, rest);
    else this.inbound.delete(sessionID);
  }

  private parkPrompt(input: Input, at: number): void {
    const sessionID = heldSession(input);
    if (sessionID === null) return;
    // Only a resident can receive a parked ask. An archive may have removed it
    // between the event's arrival and this task running, and parking for a gone
    // session would attach the old ask to its next incarnation.
    if (!this.state.sessions.has(sessionID)) return;
    // A removal that arrived before this ask still outranks it: the ask belongs
    // to an incarnation the host already ended.
    if ((this.goneAt.get(sessionID) ?? 0) > at) return;
    const waiting = this.pendingPrompts.get(sessionID);
    if (waiting) waiting.push({ input, at });
    else this.pendingPrompts.set(sessionID, [{ input, at }]);
  }

  /** A successful prompt read supersedes every ask parked behind an older one. */
  private dropPendingPrompts(sessionID: string): void {
    this.pendingPrompts.delete(sessionID);
  }

  private flushPendingPrompts(sessionID: string): void {
    const waiting = this.pendingPrompts.get(sessionID);
    if (!waiting) return;
    this.pendingPrompts.delete(sessionID);
    for (const { input, at } of waiting) {
      // A removal that arrived after this ask was parked still wins: the ask
      // describes an incarnation the host has already ended.
      if ((this.goneAt.get(sessionID) ?? 0) > at) continue;
      // The answer may already have arrived while this prompt was parked. Its
      // own reply task is queued behind unrelated work, but the answer is
      // already a fact: reporting the block here would be a status the user
      // already dismissed.
      const key = Reporter.heldKey(input);
      if (key !== null && this.isAnswered(key)) continue;
      if (!this.state.sessions.has(sessionID)) continue;
      this.dispatch(input);
    }
  }

  private recheck(sessionID: string): void {
    if (this.closed || !this.state.sessions.has(sessionID)) return;
    // One queued recheck per session: it reads the session once, which answers
    // every event that asked for it. Without this a burst of asks queues a full
    // read each, and unrelated work waits behind all of them.
    if (this.recheckQueued.has(sessionID)) return;
    this.recheckQueued.add(sessionID);
    this.enqueue(async () => {
      this.recheckQueued.delete(sessionID);
      await this.check(sessionID);
    });
  }

  private readonly bootSince = Date.now() - uptimeMs();
  /** Work applied in arrival order: the whole point of this class. */
  private readonly queue: Array<() => Promise<unknown>> = [];
  private draining = false;
  private stream: { controller: AbortController; owner: Registration } | null = null;
  private streamOwner: Registration | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** True while a pass is running, so a second request does not stack. */
  private passRunning = false;
  /** A pass was requested during the current one: exactly one follows. */
  private passWanted = false;
  /** Bumped to retire a pass whose work is now obsolete. */
  private passToken = 0;
  private seedRetry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(config: Config) {
    this.config = config;
    this.delivery = createDelivery(config);
  }

  get live(): boolean {
    return !this.closed;
  }

  register(registration: Registration): void {
    this.setups.push(registration);
    this.startStream();
    this.startHeartbeat();
  }

  /**
   * Drop one setup. Its state is untouched: another location may still be
   * reporting into it, and only the last unload may shut the reporter down.
   */
  unregister(registration: Registration): void {
    const index = this.setups.indexOf(registration);
    if (index < 0) return; // already unregistered: cleanup is idempotent
    this.setups.splice(index, 1);
    if (this.setups.length === 0) {
      this.stop();
      return;
    }
    if (this.streamOwner === registration) {
      // The owner is gone but others remain: re-elect against a survivor
      // instead of reporting nothing.
      this.stream?.controller.abort();
      this.stream = null;
      this.streamOwner = null;
      this.startStream();
    }
  }

  /** Shut down from outside (tests); the same path an unload takes. */
  stop(): void {
    this.setups.length = 0;
    this.closed = true;
    this.stream?.controller.abort();
    this.stream = null;
    this.streamOwner = null;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.seedRetry !== null) clearTimeout(this.seedRetry);
    this.seedRetry = null;
    this.delivery.close();
    this.queue.length = 0;
    this.directories.clear();
    this.passWanted = false;
    this.passRunning = false;
  }

  private send(action: Action): void {
    const write: Write =
      action.type === "delete"
        ? { type: "delete", sessionID: action.sessionID }
        : { type: "post", sessionID: action.sessionID, status: action.status, name: action.name };
    this.delivery.enqueue(write);
  }

  /** Remember a prompt event until its session is admitted or proved absent. */
  private holdPrompt(input: Input): void {
    // A form that is answered while parked would otherwise apply late and stay
    // blocked forever; matching terminal events drop their held counterpart.
    this.held.push(input);
  }

  /** A terminal event makes its parked prompt obsolete, admitted or not. */
  private dropHeld(sessionID: string, match: (input: Input) => boolean): void {
    for (let i = this.held.length - 1; i >= 0; i -= 1) {
      const input = this.held[i];
      if (heldSession(input) === sessionID && match(input)) this.held.splice(i, 1);
    }
    // The same prompt may be waiting on a prompt read instead; an answer makes
    // both copies obsolete.
    const waiting = this.pendingPrompts.get(sessionID);
    if (waiting) this.pendingPrompts.set(sessionID, waiting.filter(({ input }) => !match(input)));
  }

  /** A stable key for a prompt id, scoped by kind so ids cannot collide. */
  private static promptKey(kind: "permission" | "form", id: string): string {
    return `${kind}:${id}`;
  }

  private hasHeld(sessionID: string): boolean {
    return this.held.some((input) => heldSession(input) === sessionID);
  }

  private discardHeld(sessionID: string): void {
    for (let i = this.held.length - 1; i >= 0; i -= 1) {
      if (heldSession(this.held[i]) === sessionID) this.held.splice(i, 1);
    }
  }

  /**
   * Apply parked prompt events now that the session is really a resident.
   *
   * A parked prompt whose terminal event was already consumed is dropped, not
   * replayed: the answer is a fact even when the reply's own queued task has
   * not run yet, so a replay would report a block the user already cleared.
   */
  private releaseHeld(sessionID: string): void {
    for (let i = 0; i < this.held.length; ) {
      if (heldSession(this.held[i]) !== sessionID) {
        i += 1;
        continue;
      }
      const [input] = this.held.splice(i, 1);
      if (!this.state.sessions.has(sessionID)) return;
      const key = Reporter.heldKey(input);
      if (key !== null && this.isAnswered(key)) continue;
      this.dispatch(input);
    }
  }

  /**
   * Answers still waiting for their queued terminal task. These are not capped:
   * dropping one would let a parked copy of the prompt replay as `blocked`
   * after the user already answered it.
   */
  private readonly answering = new Map<string, number>();

  /** True when this prompt was answered, whether or not its task has run yet. */
  private isAnswered(key: string): boolean {
    return this.answering.has(key) || this.answered.has(key);
  }

  /** Record an answer, keeping the completed-answer cache bounded. */
  private rememberAnswered(key: string): void {
    this.answering.set(key, (this.answering.get(key) ?? 0) + 1);
  }

  /** The terminal task ran: the answer is final and the marker can age out. */
  private settleAnswered(key: string): void {
    // One terminal task consumes one answer: a second reply for the same prompt
    // (a duplicate or a race in the host) keeps the marker until its own task
    // has run, so a parked copy can never be replayed in between.
    const remaining = (this.answering.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.answering.set(key, remaining);
      return;
    }
    this.answering.delete(key);
    this.answered.add(key);
    // Insertion order is arrival order, so the first key is the oldest.
    while (this.answered.size > Reporter.ANSWERED_MAX) {
      const oldest = this.answered.values().next();
      if (oldest.done) break;
      this.answered.delete(oldest.value);
    }
  }

  /** The `answered` key for a parked prompt event, or null for anything else. */
  private static heldKey(input: Input): string | null {
    if (input.kind === "permission-asked") return Reporter.promptKey("permission", input.requestID);
    if (input.kind === "form-created") return Reporter.promptKey("form", input.formID);
    return null;
  }

  private dispatch(input: Input): void {
    if (this.closed) return;
    try {
      for (const action of reduce(this.state, input)) this.send(action);
    } catch {
      // A reducer fault must never surface in the host's event loop.
    }
  }

  /**
   * Append work and drain the queue. Tasks run strictly one at a time, so no
   * two reads can be in flight for the same state.
   */
  private enqueue(task: () => Promise<unknown>): void {
    if (this.closed) return;
    this.queue.push(task);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const task = this.queue.shift();
        if (!task || this.closed) return;
        try {
          await task();
        } catch {
          // One failed task must not stop the queue.
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** The context loaded for a directory, for location-scoped reads. */
  /** A context that unloaded while a call was in flight. */
  private retired(owner: Registration): boolean {
    return this.closed || !this.setups.includes(owner);
  }

  private registrationFor(directory: string | null): Registration | null {
    if (directory === null) return null;
    return this.setups.find((setup) => setup.directory === directory) ?? null;
  }

  private viewOf(row: SessionRow): SessionView {
    // Every field is normalized here, because one malformed row (a numeric
    // title, a non-string directory) must not make the reducer throw on the
    // whole batch and take every valid neighbour with it.
    const title = typeof row.title === "string" ? row.title : null;
    const directory = typeof row.location?.directory === "string" ? row.location.directory : null;
    return {
      id: String(row.id),
      parentID: typeof row.parentID === "string" ? row.parentID : null,
      title,
      directory,
      executing: isExecuting(row, this.bootSince),
    };
  }

  /**
   * Read one session, through the setup loaded for a directory when known.
   *
   * The owner is re-checked after the await on both paths: a context that
   * unloaded while its call was outstanding must not publish a row, and even
   * its not-found is not authoritative, because the reporter may already be
   * running on a survivor that knows better.
   */
  private async readSession(sessionID: string, directory: string | null): Promise<Read> {
    const owner = this.registrationFor(directory) ?? this.setups[0];
    if (!owner) return { kind: "unknown" };
    let info: any;
    try {
      info = await within(Promise.resolve(owner.ctx?.session?.get?.({ sessionID })));
    } catch (error) {
      // A specific not-found is authoritative; a failure or a stall is not.
      if (this.retired(owner)) return { kind: "unknown" };
      return isMissing(error) ? { kind: "absent" } : { kind: "unknown" };
    }
    if (info === TIMEOUT || this.retired(owner)) return { kind: "unknown" };
    const row = info?.data ?? info;
    if (!row?.id) return { kind: "unknown" };
    // Archiving leaves the row readable; it is not a resident either way.
    return isArchived(row) ? { kind: "absent" } : { kind: "row", row };
  }

  /**
   * Apply one session's current truth. An authoritative absence removes the
   * resident; a row admits it, or corrects it if it changed.
   */
  /**
   * Apply a read. `startedAt` is the counter value taken when the read was
   * issued, and it is what the session is stamped with — never a fresh value,
   * because the read knows nothing that happened after it began.
   *
   * A read that outlived the context that issued it is discarded *and* stamps
   * nothing: the survivor owns this state now, and its own pass will re-read it.
   * Letting a discarded read stamp would let it silently suppress a queued
   * event for a state it never supplied.
   */
  private applyRead(
    sessionID: string,
    read: Read,
    permissions: readonly string[] | null | undefined,
    owner: Registration | undefined,
    startedAt: number,
    promptsStartedAt?: number,
  ): void {
    if (read.kind === "unknown") return;
    if (owner && this.retired(owner)) {
      // The row is unusable, but a failed prompt read is not an answer either:
      // the parked ask is the only evidence left, so it is applied instead of
      // waiting for a reader that may never come back.
      if (permissions === null) this.flushPendingPrompts(sessionID);
      return;
    }
    // An event that arrived after this read began has answered for the session
    // more recently than the read could have seen, so the event wins: a missed
    // event cannot be re-derived, while a stale row is repaired by the next
    // pass. Events raise the watermark when they dispatch.
    if ((this.observed.get(sessionID) ?? 0) > startedAt) return;
    if (read.kind === "absent") {
      this.directories.delete(sessionID);
      // The read answered for everything: a parked event or prompt describes a
      // resident that no longer exists and must not survive to its revival.
      this.forget(sessionID);
      this.removed.add(sessionID);
      // No stamp: the session is gone, and a marker left behind would outlive
      // the resident it describes (a queued removal task is not waiting on it).
      this.dispatch({ kind: "reconcile", sessionID, view: null, missing: true });
      return;
    }
    // A live row proves the session exists again, so the removal mark — which
    // only exists to block stale prompts — is cleared. But only by a read that
    // began after the removal: a row captured before it describes the
    // incarnation that ended, and clearing the mark with it would let a parked
    // ask publish a block for a session the host already archived.
    const goneBefore = (this.goneAt.get(sessionID) ?? 0) > startedAt;
    if (goneBefore) {
      // The row describes an incarnation the host has already ended. It cannot
      // revive it, rename it, or speak for its prompts: the queued removal task
      // owns this session, and a read that begins after it will settle whatever
      // comes next.
      return;
    }
    // This reporter had already recorded the session as gone: the row that
    // follows describes a new incarnation, not the one whose prompts are still
    // held.
    const revived = this.removed.has(sessionID) || this.goneAt.has(sessionID);
    // A live row proves the session exists again, so the removal mark — which
    // only exists to block stale prompts — is cleared.
    this.removed.delete(sessionID);
    this.goneAt.delete(sessionID);
    const view = this.viewOf(read.row);
    // A child is never a resident, so it never gets a directory entry either:
    // that entry is what routes its later prompt reads.
    if (view.parentID) return;
    this.directories.set(sessionID, view.directory ?? null);
    // Replaced, not merely filled in: a revival read is newer than whatever
    // admitted the session before, and an older queued archive must lose to it.
    this.observed.set(sessionID, startedAt);
    this.titleAt.set(sessionID, startedAt);
    // A row was read, so any execution event that was waiting on a read has
    // been answered by it and must not be applied on top.
    this.pendingExec.delete(sessionID);
    // A create whose admission read failed is answered by this row: it is the
    // session, live again. Leaving the marker would make a later not-found look
    // like a second failure of the same create.
    this.pendingCreate.delete(sessionID);
    this.pendingLifecycle.delete(sessionID);
    // The prompt stamp is published only with the set it describes, and only
    // forward: an ask that arrived after this read began is newer than the
    // snapshot, so the snapshot is dropped rather than applied over it. The next
    // pass reads a world that includes that ask.
    // A successful prompt read is authoritative: any ask parked behind an older
    // read is now either in this set or disproved by it.
    const promptsFresh =
      !goneBefore &&
      permissions !== undefined &&
      permissions !== null &&
      promptsStartedAt !== undefined &&
      promptsStartedAt > (this.promptsAt.get(sessionID) ?? 0);
    // An execution event that arrived after this read began knows more about
    // whether the session is running than the row does: the row is a snapshot
    // from before it. Its own queued task may still be waiting, so the state is
    // taken from the event here and the row keeps everything else.
    const newerExec = (this.execAt.get(sessionID) ?? 0) > startedAt;
    const executing = newerExec ? this.execKind.get(sessionID) === "working" : view.executing;
    let nextPermissions: readonly string[] | undefined;
    if (promptsFresh) {
      // Asks that arrived after this read began are newer than the snapshot, so
      // the snapshot cannot disprove them: publish the union, which keeps a real
      // block rather than briefly clearing it.
      nextPermissions = this.mergeParkedPrompts(
        sessionID,
        permissions as readonly string[],
        promptsStartedAt as number,
      );
      this.promptsAt.set(sessionID, promptsStartedAt as number);
      this.dropPendingPrompts(sessionID);
      this.settleOpenAsks(sessionID, permissions as readonly string[], promptsStartedAt as number);
    }
    this.dispatch({
      kind: "reconcile",
      sessionID,
      view: { ...view, executing },
      permissions: nextPermissions,
      ...(revived ? { revived: true } : {}),
    });
    // A revival may have been admitted before the archive task ran. The queued
    // removal still owns the old incarnation's prompt state, so dropping it is
    // that task's job: nothing is left here for it to clear.
    this.releaseHeld(sessionID);
    // The row answered execution; a prompt read that failed leaves the parked
    // asks as the only evidence, so they are applied rather than lost.
    if (permissions === null) this.flushPendingPrompts(sessionID);
  }

  /**
   * Admit a session an event mentions but this reporter has not seen.
   *
   * Admission is always backed by a fresh read, so an archived or absent row
   * admits nothing. `fromPrompt` marks the one difference between the two
   * callers: a prompt event may admit a brand-new session (its first prompt
   * would otherwise be lost, and a form that is answered between two passes has
   * no other way back), but it may not revive one this reporter removed, because
   * a form that outlived its session would bring the resident back blocked.
   */
  private async admit(sessionID: string, fromPrompt = false): Promise<Admission> {
    if (this.state.sessions.has(sessionID)) return "admitted";
    // A prompt event never revives a session this reporter already removed;
    // only a lifecycle event (which rereads the row) may. This is a refusal,
    // not a transient failure, so nothing may be parked for later. Removed
    // covers an id whose removal was observed before it was ever admitted,
    if (fromPrompt && this.removed.has(sessionID)) return "refused";
    const directory = this.directories.get(sessionID) ?? null;
    const owner = this.registrationFor(directory) ?? this.setups[0] ?? null;
    // Taken before the read starts: this read cannot know about anything that
    // happens while it is in flight.
    const startedAt = this.nextObservation();
    this.reading.add(sessionID);
    let read: Read;
    try {
      read = await this.readSession(sessionID, directory);
    } finally {
      this.reading.delete(sessionID);
    }
    if (read.kind === "unknown") {
      // No read answered: an execution event that was waiting on it is the only
      // evidence left, so it is applied rather than lost.
      this.flushPendingExec(sessionID);
      return "unknown";
    }
    // An absent row is not a resident, so nothing is admitted and nothing is
    // deleted on behalf of an event: only a pass removes a resident, and only
    // after a read proved it gone. Any parked prompt for it is dead too, even
    // when there is no tracked resident to remove.
    if (read.kind === "absent") {
      // Absence proves the session is gone, so a prompt that arrives later must
      // not be what brings it back — even though this reporter never admitted
      // it and therefore has no resident to delete.
      this.forget(sessionID);
      this.removed.add(sessionID);
      return "absent";
    }
    // The owner is passed on so a context that retired between the read and
    // this line cannot publish the row through the survivor.
    this.applyRead(sessionID, read, undefined, owner ?? undefined, startedAt);
    if (!this.state.sessions.has(sessionID)) return "refused";
    // The caller can tell that this call's own read is the freshest truth: an
    // execution event must not overwrite it with a state captured earlier.
    return "admitted-fresh";
  }

  /**
   * One page of the session list. Paging is a pass step of its own, so a
   * throttled page cannot hold events behind the rest of the list.
   */
  private async listPage(
    owner: Registration,
    cursor: string | null,
  ): Promise<{ rows: SessionRow[]; next: string | null } | null> {
    if (this.retired(owner)) return null;
    let listed: any;
    try {
      listed = await within(
        Promise.resolve(owner.ctx?.session?.list?.({ limit: SEED_PAGE, ...(cursor ? { cursor } : {}) })),
      );
    } catch {
      return null;
    }
    if (listed === TIMEOUT || this.retired(owner)) return null;
    const batch = listed?.data ?? listed;
    if (!Array.isArray(batch)) return null;
    // A malformed row is skipped, never thrown on: one bad row must not wedge
    // discovery for every other session.
    const rows = batch.filter(
      (row: any): row is SessionRow => row !== null && typeof row === "object" && typeof row.id === "string",
    );
    const next = typeof listed?.cursor?.next === "string" ? listed.cursor.next : null;
    return { rows, next };
  }

  /**
   * Apply one page of the session list.
   *
   * A page is weaker evidence than a `get`: it is a snapshot that may already
   * be stale, and it carries no prompts. It can still do three things that a
   * failing `get` cannot: notice that a tracked resident was archived, refresh
   * a known resident's title, and admit an executing session this reporter has
   * never seen.
   */
  private applyListRows(rows: readonly SessionRow[], pageAt: number): void {
    const views: SessionView[] = [];
    for (const row of rows) {
      if (!row.id || row.parentID) continue;
      const tracked = this.state.sessions.has(row.id);
      // Archiving is authoritative absence. A tracked resident whose `get` is
      // failing must not keep renewing because the list is the only source
      // left: that is exactly the state a delete would leave behind.
      if (isArchived(row)) {
        this.pendingCreate.delete(row.id);
        this.forget(row.id);
        this.removed.add(row.id);
        if (tracked) {
          if ((this.observed.get(row.id) ?? 0) > pageAt) continue;
          this.directories.delete(row.id);
          this.dispatch({ kind: "reconcile", sessionID: row.id, view: null, missing: true });
        }
        // An untracked archived row stamps nothing: it queues no DELETE, so it
        // must not be able to suppress the explicit removal event that would.
        continue;
      }
      const view = this.viewOf(row);
      if (tracked) {
        // A live resident's fresh title is taken before the executing filter:
        // the list is the only metadata source when its `get` is failing, and a
        // title is not a status change. It carries its own stamp so an older
        // queued rename loses, while execution state is left untouched.
        if ((this.titleAt.get(view.id) ?? 0) <= pageAt) this.titleAt.set(view.id, pageAt);
        this.dispatch({
          kind: "renamed",
          sessionID: view.id,
          title: view.title ?? null,
          directory: view.directory ?? null,
        });
        continue;
      }
      // The row is live, so the session exists: clear a removal mark taken
      // earlier. Otherwise a prompt arriving after a genuine revival would be
      // refused as stale, with no read to correct it.
      this.removed.delete(view.id);
      // A create or lifecycle event whose admission read failed is admitted by
      // this row. The lifecycle entry carries what the host said the session was
      // doing, which is newer evidence than the page's own snapshot.
      const lifecycle = this.pendingLifecycle.get(view.id);
      const awaitingCreate = this.pendingCreate.has(view.id);
      const awaitingRead = awaitingCreate || lifecycle !== undefined;
      // The page is a snapshot from before it was requested. An execution event
      // received since then knows better whether the session is running, so its
      // state is taken instead of the row's — otherwise a resident admitted from
      // an old page reports a run that already ended, or misses a run that has
      // started and cannot be seen yet because its own read failed.
      const newerExec = (this.execAt.get(view.id) ?? 0) > pageAt;
      const carried = lifecycle !== undefined && lifecycle.at > pageAt ? lifecycle : null;
      const executing = carried !== null
        ? carried.kind === "working"
        : newerExec
          ? this.execKind.get(view.id) === "working"
          : view.executing;
      // An idle row still has to reach admission when a prompt is parked for it,
      // or when an event named this session: a form has no read of its own, so
      // otherwise it is lost for good.
      if (!executing && !this.hasHeld(view.id) && !awaitingRead) continue;
      // The directory is recorded on admission so the very first `get` and
      // prompt read already go through the setup that owns that location.
      if (view.directory !== null && view.directory !== undefined) {
        this.directories.set(view.id, view.directory);
      }
      // The row is an observation like any read, stamped with the page's own
      // start: an event captured after the page was requested is newer, and the
      // row must not overwrite it.
      if ((this.observed.get(view.id) ?? 0) > pageAt) continue;
      // A removal that arrived after this page was requested is newer than it:
      // the page's live row describes the incarnation the host already ended, so
      // admitting it would replay that incarnation's parked prompt.
      if ((this.goneAt.get(view.id) ?? 0) > pageAt) continue;
      this.observed.set(view.id, pageAt);
      this.titleAt.set(view.id, pageAt);
      // The markers have done their work: this row is the admission they asked
      // for, and the transition it carried is in `executing`.
      this.pendingCreate.delete(view.id);
      this.pendingLifecycle.delete(view.id);
      // A removed resident is not in the map at all, so this readmits it: the
      // list row is a fresh, non-archived observation of a live session.
      views.push({ ...view, executing });
    }
    if (views.length === 0) return;
    this.dispatch({ kind: "discovered", sessions: views });
    // A prompt parked behind a failing `get` is released here: the list just
    // admitted the session, and for a form there is no read that could recover
    // the block later.
    for (const view of views) {
      this.releaseHeld(view.id);
      // A lifecycle event whose admission read failed is published through this
      // admission, so the session does not appear with no state at all.
      this.flushPendingExec(view.id);
    }
  }

  /** One session's ground truth: execution, name, pending prompts. */
  private async check(sessionID: string): Promise<void> {
    const directory = this.directories.get(sessionID) ?? null;
    const owner = this.registrationFor(directory) ?? this.setups[0];
    // Both reads are stamped before they start. A read that finished later is
    // still only as fresh as the moment it asked.
    const startedAt = this.nextObservation();
    this.reading.add(sessionID);
    let read: Read;
    try {
      read = await this.readSession(sessionID, directory);
    } finally {
      this.reading.delete(sessionID);
    }
    if (read.kind === "unknown") this.flushPendingExec(sessionID);
    // Prompt reads are location-scoped: only the setup for this session's own
    // directory can describe its prompts. Without one it stays event-only.
    //
    // A prompt read still runs when the metadata read was inconclusive: the
    // prompt list is what clears a block whose reply event was missed, and a
    // failing `get` says nothing about the prompts. It is skipped only when the
    // read proved the session gone, because then there is nothing to reconcile
    // and a stale answer could belong to a session that no longer exists.
    if (read.kind === "absent") {
      this.applyRead(sessionID, read, undefined, owner, startedAt);
      return;
    }
    const locationDirectory = read.kind === "row" ? (read.row.location?.directory ?? null) : directory;
    const location = this.registrationFor(locationDirectory);
    if (!location) {
      // No live setup serves this session's location: this reporter cannot read
      // its prompts at all. Waiting for a reader that may never come back would
      // strand a parked ask forever, so it is treated as an inconclusive prompt
      // read and the ask is applied. That must not depend on the metadata read
      // succeeding: an ask cannot be re-derived, and the resident is already
      // known here.
      this.applyRead(sessionID, read, null, owner, startedAt);
      if (read.kind === "unknown") this.flushPendingPrompts(sessionID);
      return;
    }
    const promptsStartedAt = this.nextObservation();
    this.readingPrompts.add(sessionID);
    let permissions: readonly string[] | null;
    try {
      permissions = await this.readPermissions(location, sessionID);
    } finally {
      this.readingPrompts.delete(sessionID);
    }
    if (read.kind === "unknown") {
      // The row read failed, but the prompt read did not: apply the set on its
      // own rather than discarding a good answer with a bad one. The stamp goes
      // with it, because this set is the newest prompt truth either way.
      // A removal is pending for this session, and the row read could not say
      // whether it still exists. A prompt list is no evidence of existence, so
      // the set is discarded and the parked asks decide instead.
      if (this.goneAt.has(sessionID)) {
        this.flushPendingPrompts(sessionID);
        return;
      }
      if (permissions && promptsStartedAt > (this.promptsAt.get(sessionID) ?? 0)) {
      const merged = this.mergeParkedPrompts(sessionID, permissions, promptsStartedAt);
        this.promptsAt.set(sessionID, promptsStartedAt);
        this.dropPendingPrompts(sessionID);
        this.settleOpenAsks(sessionID, permissions, promptsStartedAt);
        this.dispatch({ kind: "permissions", sessionID, permissions: merged });
      } else if (permissions === null) {
        // The read failed: the parked ask is the only evidence left.
        this.flushPendingPrompts(sessionID);
      }
      return;
    }
    // applyRead publishes the stamp only if it actually accepts the row: a read
    // discarded because its owner retired never answered for the prompts.
    this.applyRead(sessionID, read, permissions, owner, startedAt, promptsStartedAt);
  }

  /**
   * Drop ids whose answer already arrived. The reply's own queued task may not
   * have run yet, but the answer is a fact: applying the snapshot's copy would
   * report a block the user already dismissed.
   */
  /**
   * A snapshot plus the asks that arrived after it began.
   *
   * Those asks are newer than the read, so it cannot disprove them: dropping
   * them would publish `idle` for a resident the host already says is waiting.
   * An ask that predates the read is a different matter — the snapshot *can*
   * see it, so its absence from the set is the host saying it is closed.
   */
  private mergeParkedPrompts(
    sessionID: string,
    permissions: readonly string[],
    promptsStartedAt: number,
  ): string[] {
    const merged = this.answeredOnly(permissions);
    const seen = new Set(merged);
    // Both places an ask can be: parked behind an older read, or delivered but
    // not yet handled by its own queued task.
    const waiting = [
      ...(this.pendingPrompts.get(sessionID) ?? []),
      ...(this.inbound.get(sessionID) ?? []),
    ];
    for (const { input, at } of waiting) {
      if (input.kind !== "permission-asked") continue;
      // The read was issued after this ask arrived, so it could see it: an
      // absent id is the host's answer, not a gap in the snapshot.
      if (at < promptsStartedAt) continue;
      if ((this.goneAt.get(sessionID) ?? 0) > at) continue;
      if (seen.has(input.requestID)) continue;
      if (this.isAnswered(Reporter.promptKey("permission", input.requestID))) continue;
      seen.add(input.requestID);
      merged.push(input.requestID);
    }
    // An ask whose own task has already finished is still open, and still newer
    // than the snapshot: it is the state the reducer already holds.
    for (const [id, { at, permission }] of this.openAsks.get(sessionID) ?? []) {
      if (!permission) continue;
      if (at < promptsStartedAt) continue;
      if (seen.has(id)) continue;
      if (this.isAnswered(Reporter.promptKey("permission", id))) continue;
      seen.add(id);
      merged.push(id);
    }
    return merged;
  }

  private answeredOnly(permissions: readonly string[]): string[] {
    const live: string[] = [];
    for (const id of permissions) {
      if (this.isAnswered(Reporter.promptKey("permission", id))) continue;
      live.push(id);
    }
    return live;
  }

  private async readPermissions(
    owner: Registration,
    sessionID: string,
  ): Promise<readonly string[] | null> {
    let pending: any;
    try {
      pending = await within(Promise.resolve(owner.ctx?.permission?.list?.({ sessionID })));
    } catch {
      return null;
    }
    // Only an actual list is authoritative. A stall, a missing method or an
    // unexpected payload is an unknown answer, not "nothing pending".
    if (pending === TIMEOUT || pending === null || this.retired(owner)) return null;
    const rows = Array.isArray(pending) ? pending : pending?.data;
    if (!Array.isArray(rows)) return null;
    // A record without an id means this payload is not what it claims to be.
    // Treating it as an empty list would clear a real block.
    const ids: string[] = [];
    for (const row of rows as any[]) {
      if (typeof row?.id !== "string" || row.id === "") return null;
      ids.push(row.id);
    }
    return ids;
  }

  /**
   * A pass is a chain of small queued steps — one list page, then one session
   * check — so an event arriving mid-pass is queued ahead of the remaining
   * steps instead of waiting behind the whole sweep.
   *
   * A pass requested while one is running is coalesced into exactly one more
   * pass afterwards. That is what makes a reconnect during a slow sweep still
   * re-seed, without letting a flapping stream stack passes.
   */
  private runPass(): void {
    if (this.closed) return;
    if (this.passRunning) {
      this.passWanted = true;
      return;
    }
    const owner = this.setups[0];
    if (!owner) return;
    this.passRunning = true;
    this.passWanted = false;
    this.queueSeedPage(++this.passToken, owner, null, 0);
  }

  private finishPass(pass: number): void {
    if (pass !== this.passToken) return;
    this.passRunning = false;
    if (this.passWanted && !this.closed) {
      this.passWanted = false;
      this.runPass();
    }
  }

  /**
   * One list page, then either the next page or the first session check.
   *
   * The page owner is pinned for the whole cursor chain: a page fetched through
   * one location must never be continued through another, and its rows must not
   * be applied after that location unloaded.
   */
  private queueSeedPage(pass: number, owner: Registration, cursor: string | null, page: number): void {
    this.enqueue(async () => {
      if (!this.alive(pass)) return this.finishPass(pass);
      // Taken immediately before the request, inside the task: the page cannot
      // know about an archive or rename that arrives while it is in flight, so
      // those events must outrank it. Taking it when the step was queued would
      // make the page claim to be older than work that ran before it ever asked,
      // and an archived row it returned would then be dismissed as stale.
      const pageAt = this.nextObservation();
      const listed = await this.listPage(owner, cursor);
      if (!this.alive(pass) || this.retired(owner)) return this.finishPass(pass);
      if (listed === null) {
        // A failed list read must not cancel the sweep: the residents already
        // tracked still need their own checks, which is the only path that can
        // notice a session that is gone.
        this.scheduleSeedRetry();
        return this.queueCheck(pass, liveSessions(this.state), 0);
      }
      this.clearSeedRetry();
      this.applyListRows(listed.rows, pageAt);
      if (listed.next !== null && page + 1 < SEED_MAX_PAGES) {
        return this.queueSeedPage(pass, owner, listed.next, page + 1);
      }
      this.queueCheck(pass, liveSessions(this.state), 0);
    });
  }

  /** One session's check, then the next, so events interleave with the sweep. */
  private queueCheck(pass: number, ids: readonly string[], index: number): void {
    this.enqueue(async () => {
      if (!this.alive(pass)) return this.finishPass(pass);
      const sessionID = ids[index];
      // The pass snapshot may name a resident an interim event removed.
      if (sessionID !== undefined && this.state.sessions.has(sessionID)) await this.check(sessionID);
      if (!this.alive(pass)) return this.finishPass(pass);
      if (index + 1 < ids.length) return this.queueCheck(pass, ids, index + 1);
      this.finishPass(pass);
    });
  }

  private alive(pass: number): boolean {
    return !this.closed && pass === this.passToken;
  }

  private scheduleSeedRetry(): void {
    // Retry is owed for the failed list read itself, so a disconnect whose seed
    // failed is still retried after a startup that succeeded.
    if (this.closed || this.seedRetry !== null) return;
    this.seedRetry = setTimeout(() => {
      this.seedRetry = null;
      this.runPass();
    }, SEED_RETRY_MS);
    (this.seedRetry as unknown as { unref?: () => void }).unref?.();
  }

  private clearSeedRetry(): void {
    if (this.seedRetry !== null) clearTimeout(this.seedRetry);
    this.seedRetry = null;
  }

  private onEvent(event: any): void {
    const data = event?.data;
    if (!data) return;
    switch (event?.type) {
      case "session.created":
        if (typeof data.sessionID === "string") {
          const sessionID = data.sessionID;
          this.enqueue(async () => {
            const admission = await this.admit(sessionID);
            // A transient read failure leaves nothing to enumerate, so the id
            // is kept: the next list page is a second chance to admit it.
            if (admission === "unknown") this.pendingCreate.add(sessionID);
            else this.pendingCreate.delete(sessionID);
          });
        }
        return;
      case "session.renamed":
        if (typeof data.sessionID === "string" && "title" in data) {
          const sessionID = data.sessionID;
          const title = typeof data.title === "string" ? data.title : null;
          // A rename carries the new name itself, but a session that was never
          // seen still has to be admitted before the reducer knows it.
          const at = this.nextObservation();
          const raced = this.readingPrompts.has(sessionID);
          this.enqueue(async () => {
            const admission = await this.admit(sessionID);
            // The admission read just fetched the current title, which is newer
            // than this event's: replaying the older one would undo it.
            if (admission === "admitted-fresh") return;
            // Same for any read that landed in the meantime: its title is newer.
            if ((this.observed.get(sessionID) ?? 0) > at) {
              this.recheck(sessionID);
              return;
            }
            if ((this.titleAt.get(sessionID) ?? 0) > at) return;
            this.dispatch({
              kind: "renamed",
              sessionID,
              title,
              directory: this.directories.get(sessionID) ?? null,
            });
          });
        }
        return;
      case "session.execution.started":
        if (typeof data.sessionID === "string") {
          const sessionID = data.sessionID;
          // The observation counter when this event reached us. A read applied
          // after this point carries a larger number, whatever order the queue
          // runs in, and two observations never share one.
          //
          // This is the whole ordering rule, and it is enough: a read that
          // begins after this event wins, because it saw a later world; a read
          // that began before it loses, because its own guard refuses to apply
          // over this event's number. No session-wide "contested" flag is
          // needed, and having one was a bug: it let a rename's contention be
          // consumed by an unrelated start.
          const at = this.nextObservation();
          // A read already running when this event arrived cannot be ordered
          // against it: it may have taken its snapshot before the event and
          // still answer after it. That is a property of THIS event, so it is
          // captured here rather than left as a flag for a later event to eat.
          const raced = this.reading.has(sessionID);
          this.execAt.set(sessionID, Math.max(this.execAt.get(sessionID) ?? 0, at));
          this.execKind.set(sessionID, "working");
          this.enqueue(async () => {
            const admission = await this.admit(sessionID);
            // A failed admission read is not a refusal: the session may exist
            // and only the read failed. The id is kept so a later live list row
            // admits it, and the transition is parked so that admission reports
            // it rather than the session appearing with no state at all.
            if (admission === "unknown") {
              this.pendingLifecycle.set(sessionID, { kind: "working", at });
            }
            // The admission read may already have seen this session idle again,
            // which is newer than the event that queued this task. Applying the
            // event would report a run that is over.
            if (admission === "admitted-fresh") return;
            // Not a resident (a child, an absent row, or a refusal): the event
            // describes something the town never shows, so nothing is stamped.
            if (!this.state.sessions.has(sessionID)) {
              this.execAt.delete(sessionID);
              this.execKind.delete(sessionID);
              return;
            }
            if ((this.observed.get(sessionID) ?? 0) > at) {
              this.recheck(sessionID);
              return;
            }
            if (raced) {
              // Only a resident can receive a parked transition. A child or an
              // absent row was refused above, and parking for it would leak an
              // entry nothing will ever apply.
              if (!this.state.sessions.has(sessionID)) {
                this.execAt.delete(sessionID);
                this.execKind.delete(sessionID);
                return;
              }
              // Hold the event until a read answers for the session. If every
              // recheck fails, flushPendingExec applies it: a lost transition is
              // worse than a possibly stale one.
              this.pendingExec.set(sessionID, { kind: "working", at });
              this.recheck(sessionID);
              return;
            }
            // A newer execution event has already arrived, even if its own task
            // is still queued behind unrelated work. Publishing this older
            // transition would report a run the host has already ended, so the
            // newer event publishes instead.
            if ((this.execAt.get(sessionID) ?? 0) > at) return;
            // A removal already received outranks this transition: publishing it
            // would report activity for an incarnation the host has ended.
            if ((this.goneAt.get(sessionID) ?? 0) > at) return;
            this.observed.set(sessionID, at);
            this.dispatch({ kind: "execution-started", sessionID });
          });
        }
        return;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        if (typeof data.sessionID === "string") {
          const sessionID = data.sessionID;
          const at = this.nextObservation();
          const raced = this.reading.has(sessionID);
          this.execAt.set(sessionID, Math.max(this.execAt.get(sessionID) ?? 0, at));
          this.execKind.set(sessionID, "ended");
          this.enqueue(async () => {
            // A start that was never admitted must not swallow the end.
            const admission = await this.admit(sessionID);
            if (admission === "unknown") {
              this.pendingLifecycle.set(sessionID, { kind: "ended", at });
            }
            if (admission === "admitted-fresh") return;
            // Not a resident (a child, an absent row, or a refusal): the event
            // describes something the town never shows, so nothing is stamped.
            if (!this.state.sessions.has(sessionID)) {
              this.execAt.delete(sessionID);
              this.execKind.delete(sessionID);
              return;
            }
            if ((this.observed.get(sessionID) ?? 0) > at) {
              this.recheck(sessionID);
              return;
            }
            if (raced) {
              if (!this.state.sessions.has(sessionID)) {
                this.execAt.delete(sessionID);
                this.execKind.delete(sessionID);
                return;
              }
              this.pendingExec.set(sessionID, { kind: "ended", at });
              this.recheck(sessionID);
              return;
            }
            // Same rule for the other direction: a newer start that already
            // arrived outranks this end.
            if ((this.execAt.get(sessionID) ?? 0) > at) return;
            if ((this.goneAt.get(sessionID) ?? 0) > at) return;
            this.observed.set(sessionID, at);
            this.dispatch({ kind: "execution-ended", sessionID });
          });
        }
        return;
      case "permission.asked":
        if (typeof data.sessionID === "string" && typeof data.id === "string") {
          const sessionID = data.sessionID;
          const requestID = data.id;
          const at = this.nextObservation();
          const raced = this.readingPrompts.has(sessionID);
          const input: Input = { kind: "permission-asked", sessionID, requestID };
          this.noteInbound(input, at);
          this.noteAsk(sessionID, requestID, at, true);
          this.enqueue(async () => {
            try {
            // Same reasoning as a form: without admission the newest resident's
            // very first prompt would be dropped. A fresh read decides whether
            // the session exists at all; a read that merely failed keeps the
            // event for the next pass instead of losing it.
            // Not consumed here: a duplicate open must leave the marker for the
            // terminal task, which is the only place a parked copy is dropped.
            if (this.isAnswered(Reporter.promptKey("permission", requestID))) return;
            // An ask older than the newest read is exactly what that read
            // disproved: a reply was missed or it never existed.
            if ((this.promptsAt.get(sessionID) ?? 0) > at) return;
            // A read running when this ask arrived may have snapshotted before
            // it: a fresh read decides. The ask is parked, not dropped, because a
            // failed read cannot disprove something the host just told us.
            if (raced) {
              this.parkPrompt(input, at);
              this.recheck(sessionID);
              return;
            }
            const admission = await this.admit(sessionID, true);
            // Answered while the admission read was in flight: the reply was
            // already consumed, so this open event is stale by definition.
            if (this.isAnswered(Reporter.promptKey("permission", requestID))) return;
            if (admission === "unknown") {
              this.holdPrompt(input);
              return;
            }
            // Refused or absent: the ask belongs to no resident. Its durable
            // record would outlive every chance to clear it, so it goes with the
            // refusal rather than accumulating for a session that never exists.
            if (admission !== "admitted" && admission !== "admitted-fresh") {
              this.closeAsk(sessionID, requestID);
              return;
            }
            // A removal already received ends this incarnation: its ask must not
            // be reported as a block for whoever comes next.
            if ((this.goneAt.get(sessionID) ?? 0) > at) {
              this.closeAsk(sessionID, requestID);
              return;
            }
            // The ask is the newest prompt observation: a prompt read that began
            // before it arrived may not clear it.
            this.promptsAt.set(sessionID, at);
            this.dispatch(input);
          } finally {
            this.clearInbound(input);
          }
          });
        }
        return;
      case "permission.replied":
        if (typeof data.sessionID === "string" && typeof data.requestID === "string") {
          const sessionID = data.sessionID;
          const requestID = data.requestID;
          const at = this.nextObservation();
          // Recorded on arrival, so an open event whose admission read is still
          // in flight already knows it was answered and will not park itself.
          this.rememberAnswered(Reporter.promptKey("permission", requestID));
          this.closeAsk(sessionID, requestID);
          this.enqueue(async () => {
            this.dropHeld(
              sessionID,
              (input) => input.kind === "permission-asked" && input.requestID === requestID,
            );
            this.settleAnswered(Reporter.promptKey("permission", requestID));
            // No stamp here. A reply is one id leaving the set, not a snapshot
            // of the set: lowering the watermark with it would let an ask that
            // was captured before a later, successful list restore a block that
            // list had already proved gone.
            // A removal already received ends this incarnation. Its status
            // bookkeeping still runs above, but publishing an unblock for a
            // resident the host has archived would be a status for a session the
            // user already closed.
            if ((this.goneAt.get(sessionID) ?? 0) > at) return;
            if (!this.state.sessions.has(sessionID)) return;
            this.dispatch({ kind: "permission-replied", sessionID, requestID });
          });
        }
        return;
      case "form.created": {
        const formID = data?.form?.id;
        const sessionID = data?.form?.sessionID;
        if (typeof sessionID === "string" && typeof formID === "string") {
          // Arrival number: a removal expressed after this form opened must be
          // able to outrank it.
          const at = this.nextObservation();
          const input: Input = { kind: "form-created", sessionID, formID };
          this.noteInbound(input, at);
          this.noteAsk(sessionID, formID, at, false);
          this.enqueue(async () => {
            try {
            // A form for a session this reporter does not know yet still has to
            // be recorded, or the resident sits at `working` while a user is
            // being asked a question. Admission here is a fresh read, so it can
            // never revive a removed resident: `readSession` reports an
            // archived or absent row as absent, and absent admits nothing.
            if (this.isAnswered(Reporter.promptKey("form", formID))) {
              this.closeAsk(sessionID, formID);
              return;
            }
            // A permission read cannot observe a form, so it must never suppress
            // one. Only this form's own reply or its session's removal can.
            const admission = await this.admit(sessionID, true);
            if (this.isAnswered(Reporter.promptKey("form", formID))) {
              this.closeAsk(sessionID, formID);
              return;
            }
            if (admission === "unknown") {
              this.holdPrompt(input);
              return;
            }
            // Refused or absent: the form belongs to no resident, so its durable
            // record would outlive every chance to clear it.
            if (admission !== "admitted" && admission !== "admitted-fresh") {
              this.closeAsk(sessionID, formID);
              return;
            }
            if ((this.goneAt.get(sessionID) ?? 0) > at) {
              this.closeAsk(sessionID, formID);
              return;
            }
            this.dispatch(input);
          } finally {
            this.clearInbound(input);
          }
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
          const at = this.nextObservation();
          this.rememberAnswered(Reporter.promptKey("form", formID));
          this.closeAsk(sessionID, formID);
          this.enqueue(async () => {
            // Same ordering rule as a permission reply: a form answered before
            // its session was admitted leaves nothing to report, and the drop
            // must happen before the parked admission task can resume.
            this.dropHeld(sessionID, (input) => input.kind === "form-created" && input.formID === formID);
            this.settleAnswered(Reporter.promptKey("form", formID));
            // A removal already received ends this incarnation; publishing for
            // it would report a status for a session the user already closed.
            if ((this.goneAt.get(sessionID) ?? 0) > at) return;
            if (!this.state.sessions.has(sessionID)) return;
            this.dispatch({ kind, sessionID, formID });
          });
        }
        return;
      case "session.deleted":
      case "session.archived":
        if (typeof data.sessionID === "string") {
          const sessionID = data.sessionID;
          // A read applied after this event is newer than it: the row it saw
          // says whether the session is really gone, so the event defers.
          const at = this.nextObservation();
          // Recorded now, not when this task runs: until then a fallback could
          // still publish a block for the incarnation this event ended.
          this.markGone(sessionID, at);
          // Queued behind any pending admission, so a delete always outranks
          // the birth that admission was about to report.
          this.enqueue(async () => {
            // A newer read already answered for this session; this event says
            // nothing that read did not.
            if ((this.observed.get(sessionID) ?? 0) > at) {
              this.recheck(sessionID);
              return;
            }
            // The directory entry is what routes later reads; a removed session
            // must not keep one.
            this.directories.delete(sessionID);
            // Everything parked for this id is dead, including a failed create:
            // otherwise a later list row or revival would carry it forward.
            this.forget(sessionID);
            // Every task that could still hold a read from before this removal
            // has already run (the queue is serial), so the mark is done — but
            // only this removal's mark. A removal that arrived later owns its
            // own stamp, and deleting that would let a stale read through it.
            if (this.goneAt.get(sessionID) === at) this.goneAt.delete(sessionID);
            // Remembered even for an id this reporter never admitted: a later
            // stale prompt must not be the event that revives it.
            this.removed.add(sessionID);
            this.dispatch({ kind: "deleted", sessionID });
          });
        }
        return;
      default:
        return;
    }
  }

  private startStream(): void {
    if (this.closed || this.stream || this.setups.length === 0) return;
    const owner = this.setups[0];
    if (!owner) return;
    const controller = new AbortController();
    this.stream = { controller, owner };
    this.streamOwner = owner;
    // An abort is cooperative: a generator may still yield one last event, and
    // a retired stream must not publish it.
    const live = (): boolean =>
      !this.closed && !controller.signal.aborted && this.streamOwner === owner;
    void (async () => {
      while (live()) {
        try {
          const events = owner.ctx?.event?.subscribe?.({ signal: controller.signal });
          // Start consuming before the pass. An async generator is pull-based:
          // while a read is pending nothing pulls it, so events are dropped.
          const reader = (async () => {
            for await (const event of events ?? []) {
              if (!live()) return;
              this.onEvent(event);
            }
          })();
          // Every reconnect re-seeds: a session can have started and finished
          // entirely while the stream was down.
          this.runPass();
          await reader;
        } catch {
          // Fall through to the backoff below.
        }
        if (!live()) return;
        await new Promise((resolve) => {
          const retry = setTimeout(resolve, RECONNECT_MS);
          (retry as unknown as { unref?: () => void }).unref?.();
        });
      }
    })().finally(() => {
      if (this.stream?.controller === controller) {
        this.stream = null;
        this.streamOwner = null;
      }
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== null || this.closed) return;
    let lastBeat = Date.now();
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      // Catch up immediately after a suspend/resume where it is overdue.
      if (Date.now() - lastBeat < HEARTBEAT_MS) return;
      lastBeat = Date.now();
      // Renewal is independent of reading: a stalled read must never let a
      // healthy resident's lease lapse.
      this.dispatch({ kind: "tick" });
      this.runPass();
    }, Math.min(60_000, HEARTBEAT_MS));
    (this.heartbeat as unknown as { unref?: () => void }).unref?.();
  }
}

const REGISTRY = Symbol.for("agent-machi.reporter");

function reporters(): Map<string, Reporter> {
  const host = globalThis as unknown as Record<symbol, Map<string, Reporter> | undefined>;
  return (host[REGISTRY] ??= new Map());
}

/**
 * Keyed by where writes actually go, not by how the option was spelled: two
 * setups that land on the same report endpoint for the same resident namespace
 * must share one writer, or their requests are not serialised at all. The token
 * decides credentials, not destination, so it is not part of the key.
 */
function keyOf(config: Config): string {
  return [reportURL(config.bridgeUrl).toString(), config.machineId, config.source].join("\n");
}

/** Shut every live reporter down. Tests use this; nothing in the plugin does. */
export function stopAllReporters(): void {
  for (const reporter of reporters().values()) reporter.stop();
  reporters().clear();
}

export const AgentMachiReporter = {
  id: "agent-machi-reporter",
  async setup(ctx: any) {
    const config = parseOptions(ctx?.options, serverEnv("AGENT_MACHI_INGEST_TOKEN"));
    // Missing or invalid config disables reporting without touching the host.
    if (!config) return;

    const registry = reporters();
    const key = keyOf(config);
    let reporter = registry.get(key);
    if (!reporter || !reporter.live) {
      reporter = new Reporter(config);
      registry.set(key, reporter);
    }
    const owner = reporter;
    const registration: Registration = {
      directory: typeof ctx?.location?.directory === "string" ? ctx.location.directory : null,
      ctx,
    };
    owner.register(registration);

    return () => {
      owner.unregister(registration);
      // Remove the entry only if this reporter is the one still registered and
      // it is gone: a duplicate cleanup must not evict its replacement.
      if (!owner.live && registry.get(key) === owner) registry.delete(key);
    };
  },
};

export default AgentMachiReporter;

/** The session a parked prompt event belongs to. */
function heldSession(input: Input): string | null {
  switch (input.kind) {
    case "permission-asked":
    case "form-created":
      return input.sessionID;
    default:
      return null;
  }
}
