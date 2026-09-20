import { readTasks } from "@/db";
import { snapshot } from "@/viewer";

export const GET = (request: Request) => snapshot(request, readTasks);
