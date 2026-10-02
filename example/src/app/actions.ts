"use server";

import { cookies } from "next/headers";

import { db } from "@/db";
import { viewerName } from "@/viewer";

// Writes are ordinary Server Actions. The committed row fires the table's trigger,
// so every joined tab rereads; the action does not revalidate or notify anything.
export async function addTask(formData: FormData) {
  const title = String(formData.get("title") ?? "").trim();
  if (title) await db.query("INSERT INTO tasks (title) VALUES ($1)", [title]);
}

export async function toggleTask(id: number) {
  await db.query("UPDATE tasks SET done = NOT done WHERE id = $1", [id]);
}

export async function addNote(formData: FormData) {
  const body = String(formData.get("body") ?? "").trim();
  const viewer = viewerName((await cookies()).toString());
  if (body && viewer) {
    await db.query("INSERT INTO notes (viewer, body) VALUES ($1, $2)", [viewer, body]);
  }
}
