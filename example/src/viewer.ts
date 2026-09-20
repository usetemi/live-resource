import { db } from "./db";

type Viewer = { allowed: boolean; fault: "fail" | "hold" | null };

/** Reads current access from the database on every call; nothing is cached. */
export async function findViewer(request: Request): Promise<Viewer | undefined> {
  const name = /(?:^|;\s*)viewer=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (!name) return undefined;
  const result = await db.query<Viewer>("SELECT allowed, fault FROM viewers WHERE name = $1", [
    decodeURIComponent(name),
  ]);
  return result.rows[0];
}

/** Snapshot routes authorize independently of the stream, then honor the viewer's fault. */
export async function snapshot(request: Request, read: () => Promise<unknown>) {
  let viewer = await findViewer(request);
  if (!viewer?.allowed) return new Response("Not authorized", { status: 403 });
  while (viewer?.fault === "hold" && !request.signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    viewer = await findViewer(request);
  }
  if (viewer?.fault === "fail") return new Response("Snapshot failed", { status: 500 });
  return Response.json(await read(), { headers: { "Cache-Control": "private, no-store" } });
}
