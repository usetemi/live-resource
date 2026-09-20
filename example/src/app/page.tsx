import { readNotes, readTasks } from "@/db";

import { Live, Notes, Status, Tasks } from "./live";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [tasks, notes] = await Promise.all([readTasks(), readNotes()]);
  return (
    <Live>
      <main>
        <h1>live-resource example</h1>
        <Status />
        <Tasks initial={tasks} />
        <Notes initial={notes} />
      </main>
    </Live>
  );
}
