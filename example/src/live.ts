import { createLiveResourceServer } from "@usetemi/live-resource/server";

import { findViewer } from "./viewer";

declare global {
  var __exampleLive: ReturnType<typeof createLiveResourceServer> | undefined;
}

function create() {
  const server = createLiveResourceServer({
    connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL!,
    resources: ["tasks", "notes"],
    authorize: async (request) => (await findViewer(request))?.allowed === true,
    log: (event) => console[event.level](`live-resource: ${event.name}`),
  });
  process.once("SIGTERM", () => void server.close());
  return server;
}

// One server per process; the global survives development reloads.
export const live = (globalThis.__exampleLive ??= create());
