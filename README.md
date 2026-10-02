# live-resource

Keep a Next.js view current without polling or refreshing, the way Phoenix LiveView does: when a committed Postgres change affects what a page shows, every open tab that joined the topic rereads it.

```
browser ── Server Action ──▶ your code ── COMMIT ──▶ Postgres
                                                        │ trigger: pg_notify('live_resource', 'tasks 42')
browser ◀── SSE "invalidate tasks 42" ◀── live-resource ◀──┘
browser ── GET /api/tasks/42 ──▶ your authorized Route Handler ──▶ fresh data
```

- **Client to server is yours.** Writes are ordinary Server Actions. They do not call this library; the committed row fires a trigger.
- **Server to client is a hint.** The notification carries a topic and nothing else. No row data crosses the stream.
- **The browser rereads.** On a hint, the view runs its own read against your authorized server path and applies the result itself.

It assumes Next.js 16, React 19.2, Node.js 22, and Postgres 14, or newer. There are no adapters for other frameworks, runtimes, or databases.

## Design

live-resource is pubsub for server-rendered views, in the shape of Phoenix Channels: a browser joins topics, the server broadcasts that a topic changed, and the view rereads from the server. The server stays the only place data is assembled, and the browser holds nothing but what the view is showing.

**Model.**

- A **topic** is a `name` and an optional `key`: `tasks`, or `tasks` with key `42`. A name is a projection, not a table; any number of tables publish to it through triggers, and a trigger that names a key column publishes to the keyed topic. A row whose key column is null publishes nothing.
- A name belongs to **one audience**. When two audiences see different slices of the same rows, a staff inbox and each customer's own page, each is its own name with its own trigger on the shared table and its own key column, rather than one name whose admission depends on who is asking.
- The key **narrows**. A join without a key hears every hint on its name; a join with a key hears hints for that key and hints without a key. A keyless hint exists for a side table that has no key for the view, so a side table that an audience-scoped name depends on should publish with that audience's key, or every join on the name learns that something changed.
- A **join** is per topic and answered per topic. `authorize` receives every topic a tab asks for in one call, on open, before a hint is forwarded, and on every heartbeat, and returns the ones it admits. It decides by name and key, never by the caller's role for a shared name. A denied topic fails alone, the rest of the stream continues, and the next heartbeat asks again.
- A **hint** is the whole payload: topic changed. No row data crosses the stream. The view reads through its own authorized server path, which may be a Route Handler, a server-component refresh, or a delta feed whose cursor the view holds. The library never holds a log.
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
- *A hook that holds the data.* The view already has state and a server-rendered first value; a hook that owned a copy had to compare `initial` across renders and reread on every change to it, which cost two reads per update and a reread per navigation. The view applies its read where it keeps its state.

## Install

```sh
npm install @usetemi/live-resource pg
```

## Set up

### 1. The trigger function

Copy [`sql/live_resource_notify.sql`](sql/live_resource_notify.sql) into a migration in your own migration tool. It is also in the installed package at `node_modules/@usetemi/live-resource/sql/live_resource_notify.sql`. Then attach it to every table a topic's read depends on, naming the topic and the column that holds its key:

```sql
CREATE TRIGGER live_resource_tasks
AFTER INSERT OR UPDATE OR DELETE ON tasks
FOR EACH ROW EXECUTE FUNCTION live_resource_notify('tasks', 'id');

CREATE TRIGGER live_resource_tasks_comments
AFTER INSERT OR UPDATE OR DELETE ON comments
FOR EACH ROW EXECUTE FUNCTION live_resource_notify('tasks', 'task_id');
```

A topic names a projection, not a table. If the `tasks` view joins `users`, put a `live_resource_notify('tasks')` trigger on `users` too; without a key column it publishes a keyless hint, which every join on `tasks` hears. The library does not infer dependencies. Names match `^[a-z][a-z0-9_]{0,63}$`.

A read must not write a table that publishes its own topic. Before attaching a trigger, check everything a hint causes to run: the Route Handler the read fetches, a server component a hint re-renders, and what they call. If any of it writes that table, the write hints the join, the hint runs the read, and the read writes again, with no pause between rounds. Write a table that carries no trigger for the topic instead, or leave the trigger off and give the view another way to move on.

The key is the column's value as `to_jsonb` renders it, compared as text: a uuid is lowercase, a number has no quotes. An `INSERT` publishes the new row's key, a `DELETE` the old row's, and an `UPDATE` that moves a row between keys publishes both. A row whose key column is null publishes nothing, and so does a trigger naming a column the table lacks; the server reports the latter when it connects. A key the stream cannot carry, empty, longer than 256 characters, or holding a control character, arrives as a keyless hint instead.

Postgres delivers the notification only after commit and drops it on rollback. Identical notifications within one transaction are coalesced, and the function skips updates that change nothing. An update that changes any column publishes, including one that only bumps `updated_at`. The trigger must be `AFTER`, and `FOR EACH ROW` when it names a key column; the function raises otherwise. Row triggers do not fire on `TRUNCATE`; where a view must hear one, add a keyless `AFTER TRUNCATE ... FOR EACH STATEMENT` trigger.

### 2. The stream endpoint

Create the server once per process and route `POST` to it.

```ts
// src/live.ts
import { createLiveResourceServer } from "@usetemi/live-resource/server";

declare global {
  var __live: ReturnType<typeof createLiveResourceServer> | undefined;
}

export const live = (globalThis.__live ??= createLiveResourceServer({
  connectionString: process.env.DIRECT_DATABASE_URL!,
  topics: ["tasks", "notes"],
  authorize: async (request, topics) => {
    const user = await currentUser(request);
    return user ? topics.filter((topic) => user.canRead(topic)) : [];
  },
  log: (event) => console[event.level](`live-resource: ${event.name}`, event.detail ?? ""),
}));
```

```ts
// src/app/api/live/route.ts
import { live } from "@/live";

export const POST = (request: Request) => live.handle(request);
```

- `connectionString` must be a direct connection. `LISTEN` does not survive transaction pooling. Your ordinary queries can keep using a pooled one.
- `topics` is every name a browser may join. Each time the listener connects, the server compares the list with the installed `live_resource_notify` triggers and logs a `trigger_mismatch` warning for each disagreement. It keeps serving.
- `authorize` runs when a stream opens, before a hint is forwarded, and on every heartbeat, with every topic the stream asked for, and returns the ones it admits. Decide by name and key: a customer may join `orders` with their own id as the key and nothing else. Read current access from your session store or database rather than trusting a cached session: this callback is what ends a join after access is revoked. Keep it cheap: it runs for every open stream on each of those occasions, and a heartbeat comes every 15 seconds. Read each fact once per call rather than once per topic, and skip reads no asked topic needs.
- `log` is optional. Without it nothing is logged.
- Call `live.close()` during shutdown. It ends the listener and every open stream, and `handle` answers 503 afterwards.

### 3. The read

One authorized server path per view, authorized on its own. The stream's authorization does not protect it.

```ts
// src/app/api/tasks/route.ts
export async function GET(request: Request) {
  if (!(await currentUser(request))?.canRead({ name: "tasks" })) {
    return new Response("Not authorized", { status: 403 });
  }
  return Response.json(await readTasks(), { headers: { "Cache-Control": "private, no-store" } });
}
```

### 4. The view

Mount the provider once above every live view, render the first value on the server, hand it to the view as its initial state, and join the topic with a read that applies the result.

```tsx
"use client";

import { LiveResourceProvider, readFrom, useStatus, useTopic } from "@usetemi/live-resource";
import { useState } from "react";

export function Live({ children }: { children: React.ReactNode }) {
  return <LiveResourceProvider endpoint="/api/live">{children}</LiveResourceProvider>;
}

export function Tasks({ initial }: { initial: Task[] }) {
  const [tasks, setTasks] = useState(initial);
  useTopic("tasks", readFrom("/api/tasks", async (response) => setTasks(await response.json())));
  return (
    <ul>
      {tasks.map((task) => (
        <li key={task.id}>{task.title}</li>
      ))}
    </ul>
  );
}

export function Task({ id, initial }: { id: number; initial: Task }) {
  const [task, setTask] = useState(initial);
  useTopic(
    { name: "tasks", key: String(id) },
    readFrom(`/api/tasks/${id}`, async (response) => setTask(await response.json()))
  );
  return <h1>{task.title}</h1>;
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

Give rows stable keys. The view replaces data, not components, so filters, open menus, focus, and scroll position survive an update.

A complete application is in [`example/`](example).

## API

### `useTopic(topic, read)`

Joins `topic`, a name or `{ name, key }`, and runs `read` when it changes. Returns `{ status, refresh }` for that join.

- `read(signal)` is called once after the stream is ready, on every hint for the topic, and after every reconnection. It applies its result and resolves; it rejects on failure and honors `signal` before applying. The latest `read` passed to the hook is the one called, so it may close over current props and state.
- Reads for one join never overlap. A hint during a read marks the join dirty, and exactly one more read follows.
- `refresh()` asks for one more read, coalesced the same way. Call it when the read's inputs change, such as a filter the user chose or a cursor the view advanced.
- `status` is `connected` once the join has caught up, `reconnecting` while the stream or a read is interrupted, and `unauthorized` while `authorize` refuses the topic or the open itself was refused. While the stream is open, a refused join is asked again on every heartbeat and reads once admitted; a refused open stays refused until `retry`.
- `topic` is checked when the hook renders: a name outside `^[a-z][a-z0-9_]{0,63}$`, or a key that is empty, over 256 characters, or holds a control character, throws.
- The view owns its state. The server-rendered value is the initial state and nothing more; the first read after `ready` replaces it. A changed selection is the view's to handle: change what `read` fetches and call `refresh()`, or remount the view with a `key`.

### `readFrom(url, receive)`

A read for the common case: fetches `url` with `cache: "no-store"` and the join's signal, rejects a response that is not `ok`, and otherwise hands the `Response` to `receive`, which applies it. Put the view's selection in the query string, such as `/api/tasks?state=open`.

### `useStatus()`

Returns `{ status, retry }` for the tab's shared stream.

| Status | Meaning |
| --- | --- |
| `idle` | Nothing is joined. |
| `connected` | Every admitted join has caught up. |
| `reconnecting` | The stream, the database listener, or a read was interrupted. It clears only after every admitted join catches up. |
| `unauthorized` | The open was refused, or every join is denied. Automatic retries of a refused open have stopped; a 400, which is a configuration error, is reported the same way with the reason in the console. |

`retry` reopens the stream and catches up without navigating, so unsaved page state survives. Offer it with a way to sign in again. A denied join never reads, so a view whose only way forward is its read stays where it is while it is `unauthorized`. Every route that mounts a live view needs to show that state, through a shared status indicator or in the view itself.

### `createLiveResourceServer({ connectionString, topics, authorize, log? })`

Returns `{ handle(request): Promise<Response>, close(): Promise<void> }`. `handle` takes a `POST` whose JSON body is `{ topics: [{ name, key? }] }` and answers 400 for any other method, a malformed topic, or more than 256 topics; 403 when `authorize` admits none of them; 503 after `close` or when `authorize` throws; and otherwise the event stream, with a `denied` frame for each topic `authorize` refused. A name the server does not declare is never offered to `authorize` and is denied like any other, so one view's typo does not take down the tab's other joins; the connect-time trigger check is what reports the typo.

`authorize` receives the same `Request` on every call, the one that opened the stream, with its body consumed: decide from its headers and from current state.

Upgrading from 0.1:

- `resources` is `topics`, and `authorize` returns the admitted topics instead of a boolean. A callback that still returns `true` fails every open.
- Re-apply `sql/live_resource_notify.sql`; it replaces the function in place. Existing one-argument triggers keep working and publish keyless hints.
- `useSnapshot` is gone. The view keeps its own state and joins with `useTopic`; a new server-rendered value is not applied to a mounted view, so remount with a `key` or call `refresh()` where the selection changes.
- The 0.1 browser opens with `GET`. Route `GET` to `handle` as well until no such tab is left; the 400 it answers stops that client's retries.

## Agent rules

The package ships [`usage-rules.md`](usage-rules.md): the rules above as short directives for a coding agent, installed at `node_modules/@usetemi/live-resource/usage-rules.md` so they always match the installed version. To keep an agent pointed at it:

```sh
npx live-resource agent-rules AGENTS.md src/live/AGENTS.md
```

The command writes a marked block that points at the file into each path it is given. It replaces an existing block where it stands, appends one to a file that has none, creates a file that does not exist, and changes nothing outside the markers. It runs only when you run it. `--check` writes nothing and exits 1 when a file's block is missing or out of date, which suits CI. Any other failure, such as a file holding one marker without the other or a path that cannot be read, exits 2 and writes nothing.

## How it behaves

**One stream per tab, one listener per process.** Every `useTopic` in a tab shares one SSE connection, and every stream in a server process shares one dedicated Postgres connection. The first join to a topic the stream does not carry reopens it with the full set. Joining a carried topic again only reads.

**Join, then read.** The server sends `ready` only after `LISTEN` has committed, and the browser reads only after `ready`. A change that lands between the server render and the join is therefore picked up by the first read rather than lost. The same holds after every reconnection. In a browser test, a row written before the join is ready reaches the view through that first read, not through a hint; a test that means to prove a hint waits for the `connected` status before it writes. The stream endpoint's response arrives before the server is listening, so it is not that signal.

**Denied joins never read.** A refused topic is announced before `ready` and before any hint, so the browser does not catch up on a join whose own read would be refused. Every heartbeat asks `authorize` again and announces what changed; a join admitted later reads once, and a join denied later stops.

**Hints are forwarded per join.** A notification marks the admitted joins it reaches, and the stream sends one `invalidate` per marked join, so a bulk update that publishes thousands of keys costs a keyless join one frame.

**Reads are serialized per join.** A hint that arrives during a read marks the join dirty, and exactly one more read follows. A read is aborted after 30 seconds, and its lock is held until it settles, so a late completion cannot overlap its retry. A failed read reopens the stream before reading again, with a backoff that resets only when a read lands, so one route that keeps failing is retried slower and slower rather than twice a second. That backoff applies only to a read that failed: a hint runs the read at once. If a read starts or resumes work on the server, and the work records its failure in a row that publishes the topic, the failure's hint runs the read and the work again immediately, so the server must space those retries itself.

**Recovery is split.** The server owns the database listener: it probes the connection, reconnects with backoff, and keeps browser streams open while it does, telling them `interrupted` and then `ready`. The browser owns the stream: it reconnects with backoff and treats 45 seconds of silence as a dead connection.

**Hidden tabs.** A hidden tab with a healthy stream keeps receiving hints and rereading, so it is current the moment you switch back. A hidden tab whose stream breaks does not retry until it is visible again, and then attempts immediately with no accumulated backoff. A healthy return causes no extra open or read. The aim is visual stability and a fast return. The costs are background bandwidth for hidden tabs and no freshness promise after an outage or a browser suspension.

**Bounds.** A stream that stops draining is closed at 64 queued batches, where one heartbeat's frames are one batch. The browser rejects an unterminated frame over 16 KiB. An open may carry at most 256 topics. Joins made in the same tick open one stream between them. The trigger costs a bulk write a few microseconds per row on Postgres 16 and scales linearly with the number of distinct keys; a wide row pays more for the unchanged-row comparison than for the key.

These values are fixed. The protocol, including the `live_resource` channel and the `name key` form of a topic on it, is the contract between the two halves of the package and is not configurable.

## What it is not

- **Not a durable log.** Notifications are hints to reread. A missed hint is repaired by the next `ready`, not replayed.
- **Not exactly-once.** A burst of changes may produce one read or several.
- **Not a job queue.** Do not run commands or background work from a hint.
- **Not a clock or a webhook.** A hint announces a committed row write on a table with a trigger, and nothing else. A view that waits on an external system, on the passage of time, or on a table with no trigger hears nothing for that change and needs its own exit: a timer, or a control the user can press.
- **Not a diff protocol.** The library carries no data. A read may fetch a snapshot or a delta from a cursor the view holds; either way the view applies it.
- **Not a write path.** Use Server Actions. Reads deliberately do not use them: Next.js dispatches Server Actions one at a time per client, so a background reread would queue ahead of the user's next mutation; action IDs change between deployments, which breaks a tab that stays open across a deploy; and an action cannot be aborted. A Route Handler URL is stable, parallel, and cancelable.

## Development

```sh
npm install
npm run check
```

`npm run check` formats, lints, type-checks, packs the library, installs the tarball into `example/`, and runs the browser tests against the example's production build and a disposable Postgres in Docker. There are no unit tests: every test drives a real browser against a real database.

Releases follow semantic versioning. Publishing a GitHub Release tagged `vX.Y.Z` that matches `package.json` publishes to npm.

## License

MIT
