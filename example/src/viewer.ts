import { db } from "./db";

export type Viewer = { name: string; allowed: boolean; fault: "fail" | "hold" | null };

export function viewerName(cookie: string | null | undefined): string | undefined {
  const name = /(?:^|;\s*)viewer=([^;]+)/.exec(cookie ?? "")?.[1];
  return name === undefined ? undefined : decodeURIComponent(name);
}

/** Reads current access from the database on every call; nothing is cached. */
export async function findViewer(request: Request): Promise<Viewer | undefined> {
  const name = viewerName(request.headers.get("cookie"));
  if (!name) return undefined;
  const result = await db.query<Viewer>(
    "SELECT name, allowed, fault FROM viewers WHERE name = $1",
    [name]
  );
  return result.rows[0];
}

/**
 * Read routes authorize independently of the stream, then honor the viewer's fault.
 * `read` may answer with its own Response to refuse the viewer.
 */
export async function snapshot(
  request: Request,
  read: (viewer: Viewer) => Promise<unknown> | Response
) {
  let viewer = await findViewer(request);
  while (viewer?.fault === "hold" && !request.signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    viewer = await findViewer(request);
  }
  if (!viewer) return new Response("Not authorized", { status: 403 });
  if (viewer.fault === "fail") return new Response("Snapshot failed", { status: 500 });
  const result = read(viewer);
  if (result instanceof Response) return result;
  return Response.json(await result, { headers: { "Cache-Control": "private, no-store" } });
}
