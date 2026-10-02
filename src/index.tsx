"use client";

import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  createRuntime,
  type LiveResourceRead,
  type LiveResourceRuntime,
  type LiveResourceStatus,
  type LiveTopicStatus,
} from "./runtime.js";
import { isTopic, type LiveResourceTopic } from "./topic.js";

export type { LiveResourceRead, LiveResourceStatus, LiveResourceTopic, LiveTopicStatus };

const RuntimeContext = createContext<LiveResourceRuntime | undefined>(undefined);

function useRuntime() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("Live resource hooks require a <LiveResourceProvider>");
  return runtime;
}

/** Mount once, above every live view. `endpoint` is the stream route and is read once. */
export function LiveResourceProvider({
  endpoint,
  children,
}: {
  endpoint: string;
  children: ReactNode;
}) {
  const [runtime] = useState(() => createRuntime(endpoint));
  return <RuntimeContext value={runtime}>{children}</RuntimeContext>;
}

/**
 * A read that fetches `url` with `cache: "no-store"` and hands the response to
 * `receive`, which applies it; a response that is not `ok` rejects the read.
 */
export function readFrom(
  url: string,
  receive: (response: Response) => void | Promise<void>
): LiveResourceRead {
  return async (signal) => {
    const response = await fetch(url, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Read failed: ${response.status}`);
    await receive(response);
  };
}

type Join = ReturnType<LiveResourceRuntime["subscribe"]>;

/**
 * Join a topic and run `read` when it changes: once after the stream is ready,
 * on every hint for it, and after every reconnection. The latest `read` is
 * always the one called, so it may close over current props and state. Reads
 * for one join never overlap; a hint during a read causes exactly one more.
 */
export function useTopic(
  topic: string | LiveResourceTopic,
  read: LiveResourceRead
): { status: LiveTopicStatus; refresh: () => void } {
  const { name, key } = typeof topic === "string" ? { name: topic } : topic;
  if (!isTopic({ name, key })) {
    throw new Error(`Invalid live resource topic ${JSON.stringify({ name, key })}`);
  }
  const runtime = useRuntime();
  const join = useRef<Join | undefined>(undefined);
  const latest = useEffectEvent((signal: AbortSignal) => read(signal));
  const status = useSyncExternalStore(
    runtime.subscribeStatus,
    (): LiveTopicStatus => runtime.getTopicStatus({ name, key }),
    (): LiveTopicStatus => "reconnecting"
  );

  useEffect(() => {
    const current = runtime.subscribe({ name, key }, (signal) => latest(signal));
    join.current = current;
    return () => {
      join.current = undefined;
      current.unsubscribe();
    };
  }, [runtime, name, key]);

  const [refresh] = useState(() => () => join.current?.refresh());
  return { status, refresh };
}

/** Status of the shared stream. `retry` reopens it and catches up without navigating. */
export function useStatus(): { status: LiveResourceStatus; retry: () => void } {
  const runtime = useRuntime();
  const status = useSyncExternalStore(
    runtime.subscribeStatus,
    runtime.getStatus,
    (): LiveResourceStatus => "idle"
  );
  return { status, retry: runtime.retry };
}
