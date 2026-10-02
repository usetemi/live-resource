"use client";

import { LiveResourceProvider, readFrom, useStatus, useTopic } from "@usetemi/live-resource";
import { useState, type ReactNode } from "react";

import type { Note, Task } from "@/db";

import { addNote, addTask, toggleTask } from "./actions";

export function Live({ children }: { children: ReactNode }) {
  return <LiveResourceProvider endpoint="/api/live">{children}</LiveResourceProvider>;
}

export function Status() {
  const { status, retry } = useStatus();
  return (
    <p>
      Live updates: <output aria-label="Stream status">{status}</output>{" "}
      {status === "unauthorized" && <button onClick={retry}>Retry</button>}
    </p>
  );
}

// The server-rendered rows are the initial state; the join keeps them current.
export function Tasks({ initial }: { initial: Task[] }) {
  const [tasks, setTasks] = useState(initial);
  const { status } = useTopic(
    "tasks",
    readFrom("/api/tasks", async (response) => setTasks(await response.json()))
  );
  const [filter, setFilter] = useState("");
  return (
    <section aria-label="Tasks">
      <h2>
        Tasks <output aria-label="Tasks status">{status}</output>
      </h2>
      <input
        aria-label="Filter tasks"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <ul>
        {tasks
          .filter((task) => task.title.includes(filter))
          .map((task) => (
            <li key={task.id}>
              <label>
                <input type="checkbox" checked={task.done} onChange={() => toggleTask(task.id)} />
                {task.title}
              </label>
            </li>
          ))}
      </ul>
      <form action={addTask}>
        <input name="title" aria-label="New task" required />
        <button>Add task</button>
      </form>
    </section>
  );
}

// A keyed join: this tab hears only its own viewer's notes.
export function Notes({ viewer, initial }: { viewer: string; initial: Note[] }) {
  const [notes, setNotes] = useState(initial);
  useTopic(
    { name: "notes", key: viewer },
    readFrom("/api/notes", async (response) => setNotes(await response.json()))
  );
  return (
    <section aria-label="Notes">
      <h2>Notes</h2>
      <ul>
        {notes.map((note) => (
          <li key={note.id}>{note.body}</li>
        ))}
      </ul>
      <form action={addNote}>
        <input name="body" aria-label="New note" required />
        <button>Add note</button>
      </form>
    </section>
  );
}
