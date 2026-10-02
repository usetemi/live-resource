import { createLiveResourceServer } from "@usetemi/live-resource/server";

import { findViewer } from "./viewer";

declare global {
  var __exampleLive: ReturnType<typeof createLiveResourceServer> | undefined;
}

function create() {
  const server = createLiveResourceServer({
    connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL!,
    topics: ["tasks", "notes"],
    // Every allowed viewer may join tasks; a viewer may join notes with their own key only.
    authorize: async (request, topics) => {
      const viewer = await findViewer(request);
      if (!viewer) return [];
      return topics.filter(({ name, key }) =>
        name === "tasks" ? viewer.allowed : name === "notes" && key === viewer.name
      );
    },
    log: (event) => console[event.level](`live-resource: ${event.name}`, event.detail ?? ""),
  });
  process.once("SIGTERM", () => void server.close());
  return server;
}

// One server per process; the global survives development reloads.
export const live = (globalThis.__exampleLive ??= create());
