import { cookies } from "next/headers";

import { readNotes, readTasks } from "@/db";
import { viewerName } from "@/viewer";

import { Live, Notes, Status, Tasks } from "./live";

export const dynamic = "force-dynamic";

export default async function Page() {
  const viewer = viewerName((await cookies()).toString());
  const [tasks, notes] = await Promise.all([readTasks(), viewer ? readNotes(viewer) : []]);
  return (
    <Live>
      <main>
        <h1>live-resource example</h1>
        <Status />
        <Tasks initial={tasks} />
        {viewer && <Notes viewer={viewer} initial={notes} />}
      </main>
    </Live>
  );
}
