import { readTasks } from "@/db";
import { snapshot } from "@/viewer";

export const GET = (request: Request) =>
  snapshot(request, (viewer) =>
    viewer.allowed ? readTasks() : new Response("Not authorized", { status: 403 })
  );
