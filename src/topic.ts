/** What a browser joins and what a trigger publishes: a name and, optionally, a key. */
export type LiveResourceTopic = { name: string; key?: string };

export const TOPIC_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** Printable, 1 to 256 code points: a key travels on one SSE data line. */
// oxlint-disable-next-line no-control-regex
export const TOPIC_KEY = /^[^\x00-\x1F\x7F]{1,256}$/u;

/** The one text form a topic takes on the NOTIFY channel and on the stream: `name` or `name key`. */
export function encodeTopic({ name, key }: LiveResourceTopic): string {
  return key === undefined ? name : `${name} ${key}`;
}

/** A notification's topic. A key the stream cannot carry leaves a keyless hint, which every join on the name hears. */
export function decodeTopic(text: string): LiveResourceTopic | undefined {
  const boundary = text.indexOf(" ");
  const name = boundary === -1 ? text : text.slice(0, boundary);
  if (!TOPIC_NAME.test(name)) return undefined;
  const key = boundary === -1 ? undefined : text.slice(boundary + 1);
  return key !== undefined && TOPIC_KEY.test(key) ? { name, key } : { name };
}

export function isTopic(value: unknown): value is LiveResourceTopic {
  if (typeof value !== "object" || value === null) return false;
  const { name, key } = value as Record<string, unknown>;
  return (
    typeof name === "string" &&
    TOPIC_NAME.test(name) &&
    (key === undefined || (typeof key === "string" && TOPIC_KEY.test(key)))
  );
}

/** A join without a key hears every hint on its name; a keyed join hears its key and keyless hints. */
export function hears(join: LiveResourceTopic, hint: LiveResourceTopic): boolean {
  return (
    join.name === hint.name &&
    (join.key === undefined || hint.key === undefined || join.key === hint.key)
  );
}
