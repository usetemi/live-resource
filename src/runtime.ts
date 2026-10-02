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

/** The per-tab runtime: one shared stream, serialized reads, and recovery. */
export function createRuntime(endpoint: string) {
  const subscriptions = new Set<Subscription>();
  const statusListeners = new Set<() => void>();
  // Topics the open stream carries, and those it has refused since it opened.
  let carried = new Set<string>();
  const denied = new Set<string>();
  let source: AbortController | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  let lastFrame = 0;
  let attempt = 0;
  // Automatic retries stop on a denial or a rejected topic set until retry().
  let halted: "unauthorized" | "rejected" | undefined;

  function topicStatus(subscription: Subscription): LiveTopicStatus {
    if (denied.has(subscription.encoded)) return "unauthorized";
    return !ready || subscription.interrupted ? "reconnecting" : "connected";
  }

  function getStatus(): LiveResourceStatus {
    if (!subscriptions.size) return "idle";
    if (halted === "unauthorized") return "unauthorized";
    const statuses = [...subscriptions].map(topicStatus);
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
    try {
      while (subscription.dirty && ready && subscriptions.has(subscription)) {
        subscription.dirty = false;
        const controller = new AbortController();
        subscription.controller = controller;
        const timeout = setTimeout(() => {
          controller.abort();
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
        subscription.interrupted = false;
        publishStatus();
      }
    } catch {
      if (subscriptions.has(subscription)) scheduleReconnect();
    } finally {
      subscription.controller = undefined;
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

  function connect() {
    source?.abort();
    source = undefined;
    clearTimeout(reconnect);
    clearTimeout(watchdog);
    reconnect = undefined;
    carried = new Set();
    denied.clear();
    interrupt();
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
    function halt(reason: NonNullable<typeof halted>) {
      halted = reason;
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
      if (response.status === 401 || response.status === 403) {
        halt("unauthorized");
        return;
      }
      if (response.status === 400) {
        console.error(`live-resource: ${endpoint} rejected [${[...carried].join(", ")}]`);
        halt("rejected");
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
          if (buffer.length > 16_384) throw new Error("Oversized subscription frame");
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
              attempt = 0;
              for (const subscription of subscriptions) void reread(subscription);
            }
            if (type === "invalidate")
              forEachJoin(data, (subscription) => void reread(subscription));
            if (type === "denied" && data !== undefined) {
              denied.add(data);
              forEachJoin(data, (subscription) => subscription.controller?.abort());
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
    if (!source && !halted) {
      attempt = 0;
      connect();
    }
  }

  return {
    getStatus,
    subscribeStatus(listener: () => void) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    /** Reopen and catch up without navigating or changing unsaved page state. */
    retry() {
      halted = undefined;
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
        getStatus: () => topicStatus(subscription),
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
            halted = undefined;
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
