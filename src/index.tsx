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
  RESOURCE_NAME,
  type LiveResourceRuntime,
  type LiveResourceStatus,
} from "./runtime.js";

export type { LiveResourceStatus };

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

export type SnapshotOptions<T> = {
  /** The server-rendered snapshot. A new value renders immediately and schedules a catch-up read. */
  initial: T;
  /** An authorized Route Handler that answers the current snapshot as JSON. */
  url: string;
  /** Turns the parsed JSON into `T`; throw to reject a snapshot. Defaults to a cast. */
  decode?: (json: unknown) => T;
};

/**
 * Keeps `initial` current. The data on screen is replaced only by a complete,
 * decoded snapshot; a failed or canceled read retains it and never navigates.
 */
export function useSnapshot<T>(resource: string, { initial, url, decode }: SnapshotOptions<T>): T {
  if (!RESOURCE_NAME.test(resource)) throw new Error(`Invalid live resource name: ${resource}`);
  const runtime = useRuntime();
  const [frame, setFrame] = useState({ initial, url, data: initial });
  const committed = useRef<{ frame: typeof frame; resolve: () => void } | undefined>(undefined);
  const subscription = useRef<ReturnType<LiveResourceRuntime["subscribe"]> | undefined>(undefined);

  // A read completes once React has committed its snapshot.
  useEffect(() => {
    if (committed.current?.frame !== frame) return;
    committed.current.resolve();
    committed.current = undefined;
  }, [frame]);

  const read = useEffectEvent(async (signal: AbortSignal) => {
    const response = await fetch(url, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Snapshot read failed: ${response.status}`);
    const json: unknown = await response.json();
    const next = { initial, url, data: decode ? decode(json) : (json as T) };
    signal.throwIfAborted();
    await new Promise<void>((resolve) => {
      committed.current = { frame: next, resolve };
      signal.addEventListener("abort", () => resolve(), { once: true });
      setFrame(next);
    });
  });

  useEffect(() => {
    const current = runtime.subscribe(resource, (signal) => read(signal));
    subscription.current = current;
    return () => {
      subscription.current = undefined;
      current.unsubscribe();
    };
  }, [runtime, resource]);

  // A navigation's server snapshot may predate a hint this tab already consumed.
  const seen = useRef({ initial, url });
  useEffect(() => {
    if (seen.current.initial === initial && seen.current.url === url) return;
    seen.current = { initial, url };
    subscription.current?.refresh();
  }, [initial, url]);

  return frame.initial === initial && frame.url === url ? frame.data : initial;
}

/** Status of the shared stream. `retry` resubscribes and catches up without navigating. */
export function useStatus(): { status: LiveResourceStatus; retry: () => void } {
  const runtime = useRuntime();
  const status = useSyncExternalStore(
    runtime.subscribeStatus,
    runtime.getStatus,
    (): LiveResourceStatus => "idle"
  );
  return { status, retry: runtime.retry };
}
