import { Pool } from "pg";

declare global {
  var __examplePool: Pool | undefined;
}

// Ordinary queries may use a pooled connection string; only the listener needs a direct one.
export const db = (globalThis.__examplePool ??= new Pool({
  connectionString: process.env.DATABASE_URL,
}));

export type Task = { id: number; title: string; done: boolean };
export type Note = { id: number; body: string };

export async function readTasks() {
  return (await db.query<Task>("SELECT id, title, done FROM tasks ORDER BY id")).rows;
}

export async function readNotes() {
  return (await db.query<Note>("SELECT id, body FROM notes ORDER BY id")).rows;
}
