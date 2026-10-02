import { Client } from "pg";

import {
  decodeTopic,
  encodeTopic,
  hears,
  isTopic,
  TOPIC_NAME,
  type LiveResourceTopic,
} from "./topic.js";

export type { LiveResourceTopic };

const CHANNEL = "live_resource";
const MAX_TOPICS = 256;

export type LiveResourceLogEvent = {
  level: "info" | "warn";
  name:
    | "listener_ready"
    | "listener_interrupted"
    | "slow_consumer"
    | "authorization_failed"
    | "trigger_mismatch";
  /** For `trigger_mismatch`: the declared topic or installed trigger that disagrees, and how. */
  detail?: string;
};

export type LiveResourceServerOptions = {
  /** A direct Postgres connection. LISTEN does not survive transaction pooling. */
  connectionString: string;
  /**
   * Every topic name a browser may join. Compared with the installed
   * `live_resource_notify` triggers each time the listener connects; a mismatch is
   * logged as `trigger_mismatch` and serving continues.
   */
  topics: readonly string[];
  /**
   * Called when a stream opens, before a hint is forwarded, and on every heartbeat,
   * with every declared topic the stream asked for; returns the ones it admits.
   * Every call receives the same Request, the one that opened the stream, with its
   * body consumed, so decide from its headers and from current access rather than
   * a cached session: this is what ends a join after access is revoked.
   */
  authorize: (
    request: Request,
    topics: readonly LiveResourceTopic[]
  ) => readonly LiveResourceTopic[] | Promise<readonly LiveResourceTopic[]>;
  log?: (event: LiveResourceLogEvent) => void;
};

type ListenerEvent =
  | { type: "ready" | "interrupted" | "closed" }
  | { type: "hint"; topic: LiveResourceTopic };

/**
 * Compare the declared names with the enabled triggers that publish on the channel.
 * A declared name nothing publishes, a trigger naming an undeclared topic, or a key
 * column the table lacks is a stale view waiting to happen, so each is logged.
 */
async function checkTriggers(
  connection: Client,
  declared: ReadonlySet<string>,
  log: (event: LiveResourceLogEvent) => void
) {
  const warn = (detail: string) => log({ level: "warn", name: "trigger_mismatch", detail });
  try {
    // attname is `name`, which pg hands back unparsed as an array; text parses.
    const { rows } = await connection.query<{ table: string; tgargs: Buffer; columns: string[] }>(
      `SELECT t.tgrelid::regclass::text AS "table", t.tgargs,
              array(SELECT a.attname::text FROM pg_attribute a
                    WHERE a.attrelid = t.tgrelid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
       FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE p.proname = 'live_resource_notify' AND NOT t.tgisinternal AND t.tgenabled <> 'D'`
    );
    const published = new Set<string>();
    for (const { table, tgargs, columns } of rows) {
      // tgargs is every argument NUL-terminated: "name\0" or "name\0key\0".
      const args = tgargs.toString("utf8").split("\0");
      args.pop();
      const [name = "", key] = args;
      if (!TOPIC_NAME.test(name)) {
        warn(`${table}: trigger publishes an invalid topic name ${JSON.stringify(name)}`);
        continue;
      }
      published.add(name);
      if (!declared.has(name)) warn(`${table}: trigger publishes undeclared topic ${name}`);
      if (key !== undefined && !columns.includes(key)) {
        warn(`${table}: trigger for ${name} names missing key column ${JSON.stringify(key)}`);
      }
    }
    for (const name of declared) {
      if (!published.has(name)) warn(`${name}: no live_resource_notify trigger publishes it`);
    }
  } catch (error) {
    warn(`could not read pg_trigger: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * One dedicated connection; subscribers receive ready only after LISTEN commits.
 * Every ready requires a fresh authorized read, including after an interruption.
 * Notifications are hints, not a durable log or a background-work queue.
 */
function createListener(
  connectionString: string,
  declared: ReadonlySet<string>,
  log: (event: LiveResourceLogEvent) => void
) {
  const subscribers = new Set<(event: ListenerEvent) => void>();
  let client: Client | undefined;
  let ready = false;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let attempt = 0;

  function emit(event: ListenerEvent) {
    for (const subscriber of subscribers) subscriber(event);
  }

  async function connect() {
    if (closed) return;
    const connection = new Client({
      connectionString,
      application_name: CHANNEL,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    client = connection;
    let failed = false;
    function disconnect() {
      if (failed || closed) return;
      failed = true;
      ready = false;
      clearInterval(heartbeat);
      emit({ type: "interrupted" });
      log({ level: "warn", name: "listener_interrupted" });
      void connection.end().catch(() => {});
      retry = setTimeout(() => void connect(), Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6)));
    }
    connection.on("error", disconnect);
    connection.on("end", disconnect);
    connection.on("notification", ({ channel, payload }) => {
      if (!ready || channel !== CHANNEL || payload === undefined) return;
      const topic = decodeTopic(payload);
      if (topic && declared.has(topic.name)) emit({ type: "hint", topic });
    });
    try {
      await connection.connect();
      await connection.query(`LISTEN ${CHANNEL}`);
      if (closed || failed) return;
      ready = true;
      attempt = 0;
      // Detect a half-open listener even while the browser's SSE socket is healthy.
      heartbeat = setInterval(() => {
        void connection.query("SELECT 1").catch(disconnect);
      }, 15_000);
      log({ level: "info", name: "listener_ready" });
      emit({ type: "ready" });
      await checkTriggers(connection, declared, log);
    } catch {
      disconnect();
    }
  }

  return {
    subscribe(subscriber: (event: ListenerEvent) => void) {
      subscribers.add(subscriber);
      if (ready) subscriber({ type: "ready" });
      else if (!client) void connect();
      return () => {
        subscribers.delete(subscriber);
      };
    },
    async close() {
      closed = true;
      ready = false;
      clearTimeout(retry);
      clearInterval(heartbeat);
      emit({ type: "closed" });
      subscribers.clear();
      await client?.end();
    },
  };
}

/** The distinct topics of an open request body, or undefined when the body is not one. */
function parseTopics(body: unknown): LiveResourceTopic[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { topics } = body as Record<string, unknown>;
  if (!Array.isArray(topics) || topics.length === 0 || topics.length > MAX_TOPICS) return undefined;
  const distinct = new Map<string, LiveResourceTopic>();
  for (const topic of topics) {
    if (!isTopic(topic)) return undefined;
    distinct.set(encodeTopic(topic), { name: topic.name, key: topic.key });
  }
  return [...distinct.values()];
}

type Join = {
  topic: LiveResourceTopic;
  encoded: string;
  admitted: boolean;
  /** The admission the browser last heard; undefined before the first `ready`. */
  told?: boolean;
  dirty: boolean;
};

/**
 * Create one per process and route POST requests for the stream endpoint to
 * `handle`. `close` ends the listener and every open stream; afterwards `handle`
 * answers 503.
 */
export function createLiveResourceServer(options: LiveResourceServerOptions) {
  const declared = new Set(options.topics);
  for (const name of declared) {
    if (!TOPIC_NAME.test(name)) throw new Error(`Invalid live resource topic name: ${name}`);
  }
  const log = options.log ?? (() => {});
  const listener = createListener(options.connectionString, declared, log);
  let closing: Promise<void> | undefined;

  /**
   * The requested topics `authorize` admits, by encoding. An undeclared name is
   * never offered to it, and anything it returns that was not asked for is ignored.
   */
  async function admit(request: Request, requested: readonly LiveResourceTopic[]) {
    const offered = requested.filter((topic) => declared.has(topic.name));
    const asked = new Set(offered.map(encodeTopic));
    const admitted = new Set<string>();
    if (offered.length === 0) return admitted;
    for (const topic of await options.authorize(request, offered)) {
      const encoded = encodeTopic(topic);
      if (asked.has(encoded)) admitted.add(encoded);
    }
    return admitted;
  }

  async function handle(request: Request): Promise<Response> {
    if (closing) return new Response("Shutting down", { status: 503 });
    // Also answers a GET from a tab still running an earlier client, which stops on 400.
    if (request.method !== "POST") return new Response("Open with POST", { status: 400 });
    const parsed = parseTopics(await request.json().catch(() => undefined));
    if (!parsed) return new Response("Invalid topics", { status: 400 });
    const requested: readonly LiveResourceTopic[] = parsed;
    let admitted: Set<string>;
    try {
      admitted = await admit(request, requested);
    } catch {
      log({ level: "warn", name: "authorization_failed" });
      return new Response("Authorization unavailable", { status: 503 });
    }
    if (admitted.size === 0) return new Response("Not authorized", { status: 403 });
    if (closing) return new Response("Shutting down", { status: 503 });
    const joins = requested.map((topic): Join => {
      const encoded = encodeTopic(topic);
      return { topic, encoded, admitted: admitted.has(encoded), dirty: false };
    });
    let canceled = false;
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          let closed = false;
          let checking = false;
          let ready = false;
          let needsReady = false;
          const encoder = new TextEncoder();
          let unsubscribe = () => {};
          const timer = setInterval(() => void flush(), 15_000);

          cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            unsubscribe();
            request.signal.removeEventListener("abort", cleanup);
            if (!canceled) controller.close();
          };
          const frame = (type: string, data: string = "") => `event: ${type}\ndata: ${data}\n\n`;
          // One enqueue per batch, so a flush with many joins counts once against the bound.
          function write(frames: string[]) {
            if (closed || frames.length === 0) return;
            if ((controller.desiredSize ?? 0) <= 0) {
              log({ level: "warn", name: "slow_consumer" });
              cleanup();
              return;
            }
            controller.enqueue(encoder.encode(frames.join("")));
          }
          // Admission changes go out before `ready` and before hints, so the browser
          // never catches up on a join whose own read would be refused.
          async function flush() {
            if (closed || checking) return;
            checking = true;
            try {
              const current = await admit(request, requested);
              if (closed) return;
              const frames: string[] = [];
              for (const join of joins) {
                join.admitted = current.has(join.encoded);
                if (!join.admitted) join.dirty = false;
                if (join.told === undefined ? !join.admitted : join.told !== join.admitted) {
                  frames.push(frame(join.admitted ? "admitted" : "denied", join.encoded));
                }
                join.told = join.admitted;
              }
              if (ready) {
                if (needsReady) {
                  needsReady = false;
                  frames.push(frame("ready"));
                }
                for (const join of joins) {
                  if (join.dirty) frames.push(frame("invalidate", join.encoded));
                  join.dirty = false;
                }
              }
              frames.push(frame("heartbeat"));
              write(frames);
            } catch {
              if (!closed) log({ level: "warn", name: "authorization_failed" });
              cleanup();
            } finally {
              checking = false;
            }
          }
          unsubscribe = listener.subscribe((event) => {
            if (closed) return;
            if (event.type === "closed") {
              cleanup();
              return;
            }
            if (event.type === "interrupted") {
              ready = false;
              needsReady = false;
              for (const join of joins) join.dirty = false;
              write([frame("interrupted")]);
              return;
            }
            if (event.type === "ready") {
              ready = true;
              needsReady = true;
            }
            if (event.type === "hint") {
              for (const join of joins) {
                if (join.admitted && hears(join.topic, event.topic)) join.dirty = true;
              }
            }
            if (needsReady || joins.some((join) => join.dirty)) void flush();
          });
          request.signal.addEventListener("abort", cleanup, { once: true });
          if (request.signal.aborted) cleanup();
        },
        cancel() {
          canceled = true;
          cleanup();
        },
      },
      { highWaterMark: 64 }
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  return {
    handle,
    close() {
      closing ??= listener.close();
      return closing;
    },
  };
}
