# live-resource

Keep a Next.js view current without polling or refreshing, the way Phoenix LiveView does: when a committed Postgres change affects what a page shows, every open tab rereads it.

```
browser ── Server Action ──▶ your code ── COMMIT ──▶ Postgres
                                                        │ trigger: pg_notify('live_resource', 'tasks')
browser ◀── SSE "invalidate tasks" ◀── live-resource ◀──┘
browser ── GET /api/tasks ──▶ your authorized Route Handler ──▶ fresh snapshot
```

- **Client to server is yours.** Writes are ordinary Server Actions. They do not call this library; the committed row fires a trigger.
- **Server to client is a hint.** The notification carries a resource name and nothing else. No row data crosses the stream.
- **The browser rereads.** On a hint, the hook fetches a complete JSON snapshot from your own authorized Route Handler and swaps it in only when it has fully arrived and decoded.

It assumes Next.js 16, React 19.2, Node.js 22, and Postgres 14, or newer. There are no adapters for other frameworks, runtimes, or databases.

## Design

This section describes 0.2, which is not released. The sections after it document the installed 0.1.

live-resource is pubsub for server-rendered views, in the shape of Phoenix Channels: a browser joins topics, the server broadcasts that a topic changed, and the view rereads from the server. The server stays the only place data is assembled, and the browser holds nothing but what the view is showing.

**Model.**

- A **topic** is a `name` and an optional `key`: `tasks`, or `tasks` with key `42`. A name is a projection, not a table; any number of tables publish to it through triggers, and a trigger that names a key column publishes to the keyed topic. A row whose key column is null publishes nothing.
- A name belongs to **one audience**. When two audiences see different slices of the same rows, a staff inbox and each customer's own page, each is its own name with its own trigger on the shared table and its own key column, rather than one name whose admission depends on who is asking.
- The key **narrows**. A join without a key hears every hint on its name; a join with a key hears hints for that key and hints without a key. A keyless hint exists for a side table that has no key for the view, so a side table that an audience-scoped name depends on should publish with that audience's key, or every join on the name learns that something changed.
- A **join** is per topic and answered per topic. `authorize` receives every topic a tab asks for in one call, on open, before a hint is forwarded, and on every heartbeat, and returns the ones it admits. It decides by name and key, never by the caller's role for a shared name. A denied topic fails alone, the rest of the stream continues, and the next heartbeat asks again.
- A **hint** is the whole payload: topic changed. No row data crosses the stream. The view reads through its own authorized server path, which may be a Route Handler, a server-component refresh, or a delta feed. A read may carry an opaque cursor the server path defines; the library passes it through and never holds a log.
- **The browser owns its topic set.** One stream per tab carries the full set, opened by POST and reopened with the full set when it changes. Any server process can serve any open, so a stream never needs to find the process that served the previous one.

**Accepted tradeoffs.**

- A reread per hint, not a diff. Keys limit which views reread; a cursor can make a read cheap; the library still never carries data it cannot authorize.
- Reopening the stream to add a topic, instead of a subscribe message. The stream is one-way so that it stays a plain `Request → Response` handler, with no custom server, no sticky routing, and no second channel.
- A `topics` list declared at startup and checked against the installed triggers on every connect. A projection's tables are listed twice, once in SQL and once here; a declared name with no trigger, a trigger whose name is not declared, or a trigger naming a column the table lacks, is logged as a warning and the server keeps serving, so the mismatch is visible instead of only a stale view.
- Two triggers on a table that two audiences read. Each write notifies once per name; the price of one admission policy per name.
- Postgres `NOTIFY` as the only broker. It needs a direct connection and delivers at most once; a missed hint is repaired by the next `ready`, so nothing is lost that a reread cannot recover.

**Rejected.**

- *Sync engines (Electric, Zero).* They move tables and queries into the browser; here views are assembled on the server and sensitive rows should not be cached in a browser.
- *WebSocket.* Needs a custom server, which standalone Next.js output does not allow, and its one benefit here, an in-band subscribe, is matched by reopening the stream.
- *Pinning a client to one machine.* Would let the server hold the topic set as the source of truth, at the cost of a platform-specific routing dependency in a public library.
- *A library-owned notifications table.* Buys replay, which a full reread already provides, and costs a schema, retention, and upgrade migrations in every consumer's database.
- *Payloads on the wire.* A broadcast that carries data is data the stream cannot authorize per row.
- *One name admitting two audiences by role.* `authorize` would have to inspect the session to decide which keys a caller may hear, and the README would have to specify that policy; two names give each audience one policy and one trigger.
- *Topics encoded in the name (`tasks:42`).* The library has to split name from key anyway; putting the key in the name moves the encoding into every trigger and call site.

## Install

```sh
npm install @usetemi/live-resource pg
```

## Set up

### 1. The trigger function

Copy [`sql/live_resource_notify.sql`](sql/live_resource_notify.sql) into a migration in your own migration tool. It is also in the installed package at `node_modules/@usetemi/live-resource/sql/live_resource_notify.sql`. Then attach it to every table a resource's snapshot reads from, naming the resource:

```sql
CREATE TRIGGER live_resource_tasks
AFTER INSERT OR UPDATE OR DELETE ON tasks
FOR EACH ROW EXECUTE FUNCTION live_resource_notify('tasks');
```

A resource names a projection, not a table. If the `tasks` view joins `users`, put a `live_resource_notify('tasks')` trigger on `users` too. The library does not infer dependencies. Resource names match `^[a-z][a-z0-9_]{0,63}$`.

Postgres delivers the notification only after commit and drops it on rollback. Identical notifications within one transaction are coalesced, and the function skips updates that change nothing.

### 2. The stream endpoint

Create the server once per process and route `GET` to it.

```ts
// src/live.ts
import { createLiveResourceServer } from "@usetemi/live-resource/server";

declare global {
  var __live: ReturnType<typeof createLiveResourceServer> | undefined;
}

export const live = (globalThis.__live ??= createLiveResourceServer({
  connectionString: process.env.DIRECT_DATABASE_URL!,
  resources: ["tasks", "notes"],
  authorize: async (request, resources) => (await currentUser(request))?.canRead(resources) === true,
  log: (event) => console[event.level](`live-resource: ${event.name}`),
}));
```

```ts
// src/app/api/live/route.ts
import { live } from "@/live";

export const GET = (request: Request) => live.handle(request);
```

- `connectionString` must be a direct connection. `LISTEN` does not survive transaction pooling. Your ordinary queries can keep using a pooled one.
- `authorize` runs when a stream opens, before invalidations are forwarded, and on every heartbeat. Read current access from your session store or database rather than trusting a cached session: this callback is what ends a stream after access is revoked. It receives every requested resource in one call.
- `log` is optional. Without it nothing is logged.
- Call `live.close()` during shutdown. It ends the listener and every open stream, and `handle` answers 503 afterwards.

### 3. The snapshot endpoint

One Route Handler per resource, authorized on its own. The stream's authorization does not protect it.

```ts
// src/app/api/tasks/route.ts
export async function GET(request: Request) {
  if (!(await currentUser(request))?.canRead(["tasks"])) {
    return new Response("Not authorized", { status: 403 });
  }
  return Response.json(await readTasks(), { headers: { "Cache-Control": "private, no-store" } });
}
```

### 4. The view

Mount the provider once above every live view, render the first snapshot on the server, and hand it to the hook.

```tsx
"use client";

import { LiveResourceProvider, useSnapshot, useStatus } from "@usetemi/live-resource";

export function Live({ children }: { children: React.ReactNode }) {
  return <LiveResourceProvider endpoint="/api/live">{children}</LiveResourceProvider>;
}

export function Tasks({ initial }: { initial: Task[] }) {
  const tasks = useSnapshot("tasks", { initial, url: "/api/tasks" });
  return (
    <ul>
      {tasks.map((task) => (
        <li key={task.id}>{task.title}</li>
      ))}
    </ul>
  );
}

export function Status() {
  const { status, retry } = useStatus();
  return status === "unauthorized" ? <button onClick={retry}>Reconnect</button> : <span>{status}</span>;
}
```

```tsx
// src/app/page.tsx
export default async function Page() {
  return (
    <Live>
      <Status />
      <Tasks initial={await readTasks()} />
    </Live>
  );
}
```

Give rows stable keys. The hook replaces data, not components, so filters, open menus, focus, and scroll position survive an update.

A complete application is in [`example/`](example).

## API

### `useSnapshot(resource, { initial, url, decode? })`

Returns the current snapshot, starting from `initial`.

- `url` is fetched with `cache: "no-store"`. Put the view's selection in its query string, such as `/api/tasks?state=open`.
- `decode` turns the parsed JSON into your type, for example to revive dates or validate with a schema. Throwing rejects the snapshot. Without it the JSON is cast.
- A new `initial`, from a navigation or a changed selection, renders immediately and schedules a catch-up read, because the server may have read it before a hint this tab already consumed. A changed `url` does the same.
- The data on screen changes only when a complete snapshot has arrived and decoded. A failed, slow, or canceled read keeps the current data and never navigates.

### `useStatus()`

Returns `{ status, retry }` for the tab's shared stream.

| Status | Meaning |
| --- | --- |
| `idle` | Nothing is subscribed. |
| `connected` | Every subscribed snapshot has caught up. |
| `reconnecting` | The stream, the database listener, or a read was interrupted. It clears only after every snapshot catches up. |
| `unauthorized` | Access was denied. Automatic retries have stopped. |

`retry` resubscribes and catches up without navigating, so unsaved page state survives. Offer it with a way to sign in again.

### `createLiveResourceServer({ connectionString, resources, authorize, log? })`

Returns `{ handle(request): Promise<Response>, close(): Promise<void> }`. `handle` answers 400 for an undeclared or missing `resource` parameter, 403 when `authorize` answers false, 503 after `close`, and otherwise the event stream.

## How it behaves

**One stream per tab, one listener per process.** Every `useSnapshot` in a tab shares one SSE connection, and every stream in a server process shares one dedicated Postgres connection. The first subscription to a resource name the stream does not carry reconnects it with the full set. Subscribing again to a carried name only reads.

**Subscribe, then read.** The server sends `ready` only after `LISTEN` has committed, and the browser reads only after `ready`. A change that lands between the server render and the subscription is therefore picked up by the first read rather than lost. The same holds after every reconnection.

**Reads are serialized per subscription.** A hint that arrives during a read marks the subscription dirty, and exactly one more read follows. A read is aborted after 30 seconds, and its lock is held until it settles, so a late completion cannot overlap its retry. A failed read resubscribes before reading again.

**Recovery is split.** The server owns the database listener: it probes the connection, reconnects with backoff, and keeps browser streams open while it does, telling them `interrupted` and then `ready`. The browser owns the stream: it reconnects with backoff and treats 45 seconds of silence as a dead connection.

**Hidden tabs.** A hidden tab with a healthy stream keeps receiving hints and rereading, so it is current the moment you switch back. A hidden tab whose stream breaks does not retry until it is visible again, and then attempts immediately with no accumulated backoff. A healthy return causes no extra subscription or read. The aim is visual stability and a fast return. The costs are background bandwidth for hidden tabs and no freshness promise after an outage or a browser suspension.

**Bounds.** A stream that stops draining is closed at 64 queued frames. The browser rejects a frame buffer over 16 KiB. A stream may request at most 32 resources.

These values are fixed. The protocol, including the `live_resource` channel, is the contract between the two halves of the package and is not configurable.

## What it is not

- **Not a durable log.** Notifications are hints to reread. A missed hint is repaired by the next `ready`, not replayed.
- **Not exactly-once.** A burst of changes may produce one read or several.
- **Not a job queue.** Do not run commands or background work from a hint.
- **Not a diff protocol.** Every update is a full snapshot read. Keep snapshot queries cheap and bounded.
- **Not a write path.** Use Server Actions. Snapshot reads deliberately do not use them: Next.js dispatches Server Actions one at a time per client, so a background reread would queue ahead of the user's next mutation; action IDs change between deployments, which breaks a tab that stays open across a deploy; and an action cannot be aborted. A Route Handler URL is stable, parallel, and cancelable.

## Development

```sh
npm install
npm run check
```

`npm run check` formats, lints, type-checks, packs the library, installs the tarball into `example/`, and runs the browser tests against the example's production build and a disposable Postgres in Docker. There are no unit tests: every test drives a real browser against a real database.

Releases follow semantic versioning. Publishing a GitHub Release tagged `vX.Y.Z` that matches `package.json` publishes to npm.

## License

MIT
