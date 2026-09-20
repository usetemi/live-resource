import { Client } from "pg";

const CHANNEL = "live_resource";
const RESOURCE_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export type LiveResourceLogEvent = {
  level: "info" | "warn";
  name: "listener_ready" | "listener_interrupted" | "slow_consumer" | "authorization_failed";
};

export type LiveResourceServerOptions = {
  /** A direct Postgres connection. LISTEN does not survive transaction pooling. */
  connectionString: string;
  /** Every resource name a browser may subscribe to. */
  resources: readonly string[];
  /**
   * Called when a stream opens, before invalidations are forwarded, and on every
   * heartbeat, with the resources that stream requested. Read current access, not
   * a cached session: this is what ends a stream after access is revoked.
   */
  authorize: (request: Request, resources: readonly string[]) => boolean | Promise<boolean>;
  log?: (event: LiveResourceLogEvent) => void;
};

type ListenerEvent =
  | { type: "ready" | "interrupted" | "closed" }
  | { type: "invalidate"; resource: string };

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
      if (ready && channel === CHANNEL && payload !== undefined && declared.has(payload)) {
        emit({ type: "invalidate", resource: payload });
      }
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

/**
 * Create one per process and route GET requests for the stream endpoint to
 * `handle`. `close` ends the listener and every open stream; afterwards `handle`
 * answers 503.
 */
export function createLiveResourceServer(options: LiveResourceServerOptions) {
  const declared = new Set(options.resources);
  for (const name of declared) {
    if (!RESOURCE_NAME.test(name)) throw new Error(`Invalid live resource name: ${name}`);
  }
  const log = options.log ?? (() => {});
  const listener = createListener(options.connectionString, declared, log);
  let closing: Promise<void> | undefined;

  async function handle(request: Request): Promise<Response> {
    if (closing) return new Response("Shutting down", { status: 503 });
    const values = new URL(request.url).searchParams.getAll("resource");
    if (values.length === 0 || values.length > 32 || !values.every((name) => declared.has(name))) {
      return new Response("Invalid resources", { status: 400 });
    }
    if (!(await options.authorize(request, values))) {
      return new Response("Not authorized", { status: 403 });
    }
    if (closing) return new Response("Shutting down", { status: 503 });
    const resources = new Set(values);
    let canceled = false;
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          let closed = false;
          let checking = false;
          let ready = false;
          let needsReady = false;
          const pending = new Set<string>();
          const encoder = new TextEncoder();
          let unsubscribe = () => {};
          const timer = setInterval(() => void flush(), 15_000);

          cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            unsubscribe();
            pending.clear();
            request.signal.removeEventListener("abort", cleanup);
            if (!canceled) controller.close();
          };
          function send(type: string, data: string = "") {
            if (closed) return;
            if ((controller.desiredSize ?? 0) <= 0) {
              log({ level: "warn", name: "slow_consumer" });
              cleanup();
              return;
            }
            controller.enqueue(encoder.encode(`event: ${type}\ndata: ${data}\n\n`));
          }
          async function flush() {
            if (closed || checking) return;
            checking = true;
            try {
              const authorized = await options.authorize(request, values);
              if (closed) return;
              if (!authorized) {
                send("unauthorized");
                cleanup();
                return;
              }
              if (ready) {
                if (needsReady) {
                  needsReady = false;
                  send("ready");
                }
                for (const resource of pending) send("invalidate", resource);
                pending.clear();
              }
              send("heartbeat");
            } catch {
              log({ level: "warn", name: "authorization_failed" });
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
              pending.clear();
              send("interrupted");
              return;
            }
            if (event.type === "ready") {
              ready = true;
              needsReady = true;
            }
            if (event.type === "invalidate" && resources.has(event.resource))
              pending.add(event.resource);
            if (needsReady || pending.size) void flush();
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
