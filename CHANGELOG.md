# Changelog

## 0.2.1

The runtime and the protocol are unchanged.

- `usage-rules.md` ships in the package: the rules for code that uses the library, as directives for a coding agent.
- `npx live-resource agent-rules <file>...` writes a marked block pointing at that file into each agent file it is given, replacing an existing block and leaving the rest alone. `--check` exits 1 when a block is missing or out of date.
- The README states what was only implied: a read must not write a table that publishes its own topic; an update that only bumps a timestamp still publishes; `authorize` runs per stream on open, per hint, and every 15 seconds; a hint announces a row write and nothing else; a route with a live view must show `unauthorized`; a hint runs the read without delay; a browser test waits for the join before it writes.

## 0.2.0

- Topics: a name and an optional key. `live_resource_notify(name, keyColumn?)` publishes the row's key, both keys when an update moves a row, and nothing for a null key. A keyed join hears its key and keyless hints; an unkeyed join hears every hint on the name.
- `authorize(request, topics)` returns the admitted topics. A denied join fails alone, is announced before `ready`, and is asked again on every heartbeat; an open that admits nothing is still 403. An undeclared name is denied rather than failing the open.
- A failed read's reconnect backoff resets when a read lands, not when the stream opens.
- The stream opens with `POST` and a JSON body of topics. A `GET` is answered 400, which stops a 0.1 browser's retries.
- `topics` replaces `resources`. On every listener connect the declared names are compared with the installed triggers and each mismatch is logged as `trigger_mismatch`.
- `useTopic(topic, read)` replaces `useSnapshot`. The view owns its state and applies each read itself; `readFrom(url, receive)` covers the fetch-and-apply case. `useStatus` is unchanged, and reports `unauthorized` when every join is denied.
- Hints are forwarded per join, so a bulk write costs a join one frame.

## 0.1.0

- `LiveResourceProvider`, `useSnapshot`, and `useStatus` for the browser.
- `createLiveResourceServer` for the stream endpoint, from `@usetemi/live-resource/server`.
- `sql/live_resource_notify.sql`, the trigger function applications attach to their tables.
