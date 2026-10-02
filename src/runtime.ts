import { encodeTopic, type LiveResourceTopic } from "./topic.js";

export type LiveResourceStatus = "idle" | "connected" | "reconnecting" | "unauthorized";
export type LiveTopicStatus = "connected" | "reconnecting" | "unauthorized";

/** Apply the result before resolving, reject failures, and honor the signal before applying. */
export type LiveResourceRead = (signal: AbortSignal) => Promise<void>;

type Subscription = {
  topic: LiveResourceTopic;
  encoded: string;
  read: LiveResourceRead;
  interrupted: boolean;
  dirty: boolean;
  controller?: AbortController;
};

const DENIED = "denied";

/** The per-tab runtime: one shared stream, serialized reads, and recovery. */
export function createRuntime(endpoint: string) {
  const subscriptions = new Set<Subscription>();
  const statusListeners = new Set<() => void>();
  // Topics the open stream carries, and those it has refused since it opened.
  let carried = new Set<string>();
  const denied = new Set<string>();
  let source: AbortController | undefined;
  let opening = false;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  let lastFrame = 0;
  let attempt = 0;
  // Automatic retries stop on a refused open until retry().
  let halted = false;

  function getTopicStatus(topic: LiveResourceTopic): LiveTopicStatus {
    const encoded = encodeTopic(topic);
    if (halted || denied.has(encoded)) return "unauthorized";
    let joined = false;
    for (const subscription of subscriptions) {
      if (subscription.encoded !== encoded) continue;
      joined = true;
      if (subscription.interrupted) return "reconnecting";
    }
    return joined && ready ? "connected" : "reconnecting";
  }

  function getStatus(): LiveResourceStatus {
    if (!subscriptions.size) return "idle";
    if (halted) return "unauthorized";
    const statuses = [...subscriptions].map((subscription) => getTopicStatus(subscription.topic));
    if (statuses.every((status) => status === "unauthorized")) return "unauthorized";
    return statuses.some((status) => status === "reconnecting") ? "reconnecting" : "connected";
  }

  function publishStatus() {
    for (const listener of statusListeners) listener();
  }

  function interrupt() {
    ready = false;
    for (const subscription of subscriptions) {
      subscription.interrupted = true;
      subscription.dirty = true;
    }
    publishStatus();
  }

  async function reread(subscription: Subscription) {
    subscription.dirty = true;
    if (subscription.controller || !ready || denied.has(subscription.encoded)) return;
    let controller: AbortController | undefined;
    try {
      while (subscription.dirty && ready && subscriptions.has(subscription)) {
        subscription.dirty = false;
        controller = new AbortController();
        subscription.controller = controller;
        const timeout = setTimeout(() => {
          controller?.abort();
          if (subscriptions.has(subscription)) scheduleReconnect();
        }, 30_000);
        try {
          // Keep the read lock until the callback settles, even after cancellation.
          await subscription.read(controller.signal);
          controller.signal.throwIfAborted();
        } finally {
          clearTimeout(timeout);
        }
      }
      if (ready && subscriptions.has(subscription)) {
        // Backoff resets on a read that lands, not on a stream that opens, so a
        // route that keeps failing is retried slower and slower.
        attempt = 0;
        subscription.interrupted = false;
        publishStatus();
      }
    } catch {
      // A read the runtime aborted on a denial of its own join is not a broken stream.
      if (controller?.signal.reason === DENIED) {
        subscription.controller = undefined;
        if (!denied.has(subscription.encoded)) void reread(subscription);
        return;
      }
      if (subscriptions.has(subscription)) scheduleReconnect();
    } finally {
      if (subscription.controller === controller) subscription.controller = undefined;
    }
  }

  function scheduleReconnect() {
    source?.abort();
    source = undefined;
    clearTimeout(watchdog);
    interrupt();
    if (reconnect || !subscriptions.size || halted || document.visibilityState === "hidden") return;
    reconnect = setTimeout(
      () => {
        reconnect = undefined;
        connect();
      },
      Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6))
    );
  }

  function forEachJoin(encoded: string | undefined, apply: (subscription: Subscription) => void) {
    for (const subscription of subscriptions) {
      if (subscription.encoded === encoded) apply(subscription);
    }
  }

  // Joins made in one tick open one stream between them.
  function connect() {
    source?.abort();
    source = undefined;
    clearTimeout(reconnect);
    clearTimeout(watchdog);
    reconnect = undefined;
    carried = new Set();
    denied.clear();
    interrupt();
    if (opening) return;
    opening = true;
    queueMicrotask(() => {
      opening = false;
      open();
    });
  }

  function open() {
    if (!subscriptions.size || halted || document.visibilityState === "hidden") return;
    const connection = new AbortController();
    source = connection;
    const topics = new Map<string, LiveResourceTopic>();
    for (const subscription of subscriptions) topics.set(subscription.encoded, subscription.topic);
    carried = new Set(topics.keys());
    function alive() {
      lastFrame = Date.now();
      clearTimeout(watchdog);
      watchdog = setTimeout(scheduleReconnect, 45_000);
    }
    function halt() {
      halted = true;
      connection.abort();
      source = undefined;
      clearTimeout(watchdog);
      interrupt();
    }
    // Bound opening a connection as well as silence between received frames.
    alive();
    void (async () => {
      const response = await fetch(new URL(endpoint, window.location.href), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topics: [...topics.values()] }),
        signal: connection.signal,
      });
      if (source !== connection) return;
      if (response.status === 400) {
        console.error(`live-resource: ${endpoint} rejected the open: ${await response.text()}`);
      }
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        halt();
        return;
      }
      if (!response.ok || !response.body) throw new Error("Subscription failed");
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      try {
        while (source === connection) {
          const chunk = await reader.read();
          if (source !== connection || chunk.done) break;
          buffer += chunk.value;
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, boundary).split("\n");
            buffer = buffer.slice(boundary + 2);
            const type = frame.find((line) => line.startsWith("event: "))?.slice(7);
            const data = frame.find((line) => line.startsWith("data: "))?.slice(6);
            alive();
            if (type === "interrupted") interrupt();
            if (type === "ready") {
              ready = true;
              for (const subscription of subscriptions) void reread(subscription);
            }
            if (type === "invalidate")
              forEachJoin(data, (subscription) => void reread(subscription));
            if (type === "denied" && data !== undefined) {
              denied.add(data);
              forEachJoin(data, (subscription) => subscription.controller?.abort(DENIED));
              publishStatus();
            }
            if (type === "admitted" && data !== undefined) {
              denied.delete(data);
              forEachJoin(data, (subscription) => {
                subscription.interrupted = true;
                void reread(subscription);
              });
              publishStatus();
            }
          }
          // Whole frames are consumed above; only an unterminated one is bounded.
          if (buffer.length > 16_384) throw new Error("Oversized subscription frame");
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (source === connection) scheduleReconnect();
    })().catch(() => {
      if (source === connection) scheduleReconnect();
    });
  }

  // A broken connection waits while hidden and attempts immediately on return.
  function resume() {
    if (document.visibilityState === "hidden") {
      clearTimeout(reconnect);
      reconnect = undefined;
      return;
    }
    if (source && Date.now() - lastFrame >= 45_000) scheduleReconnect();
    if (!source && !opening && !halted) {
      attempt = 0;
      connect();
    }
  }

  return {
    getStatus,
    getTopicStatus,
    subscribeStatus(listener: () => void) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    /** Reopen and catch up without navigating or changing unsaved page state. */
    retry() {
      halted = false;
      attempt = 0;
      connect();
    },
    /**
     * Joins share one stream. A topic the stream already carries rereads only; a
     * new topic reopens with the full set, and everyone catches up on ready, so
     * every read still follows its join.
     */
    subscribe(topic: LiveResourceTopic, read: LiveResourceRead) {
      const subscription: Subscription = {
        topic,
        encoded: encodeTopic(topic),
        read,
        interrupted: true,
        dirty: true,
      };
      if (!subscriptions.size) {
        document.addEventListener("visibilitychange", resume);
        window.addEventListener("pageshow", resume);
        window.addEventListener("online", resume);
        window.addEventListener("offline", scheduleReconnect);
      }
      subscriptions.add(subscription);
      publishStatus();
      if (carried.has(subscription.encoded)) void reread(subscription);
      else connect();
      return {
        /** Coalesces with hints: at most one more read follows the current one. */
        refresh() {
          if (subscriptions.has(subscription)) void reread(subscription);
        },
        unsubscribe() {
          subscriptions.delete(subscription);
          subscription.controller?.abort();
          if (!subscriptions.size) {
            document.removeEventListener("visibilitychange", resume);
            window.removeEventListener("pageshow", resume);
            window.removeEventListener("online", resume);
            window.removeEventListener("offline", scheduleReconnect);
            halted = false;
            attempt = 0;
            connect();
          }
          publishStatus();
        },
      };
    },
  };
}

export type LiveResourceRuntime = ReturnType<typeof createRuntime>;
