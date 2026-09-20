import { readFileSync } from "node:fs";

import { expect, test as base, type Page } from "@playwright/test";
import { Client } from "pg";

type Fixtures = {
  db: Client;
  /** A viewer row and its cookie, owned by one test. */
  viewer: string;
  /** Unique text for rows this test creates. */
  marker: string;
};

const test = base.extend<Fixtures>({
  db: async ({}, use) => {
    const { databaseUrl } = JSON.parse(
      readFileSync(new URL("../.test-state.json", import.meta.url), "utf8")
    );
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await use(db);
    await db.end();
  },
  marker: async ({}, use, testInfo) => {
    await use(`t${testInfo.workerIndex}-${Date.now()}`);
  },
  viewer: async ({ db, context, baseURL, marker }, use) => {
    await db.query("INSERT INTO viewers (name) VALUES ($1)", [marker]);
    await context.addCookies([{ name: "viewer", value: marker, url: baseURL! }]);
    await use(marker);
  },
});

const status = (page: Page) => page.getByRole("status");
const tasks = (page: Page) => page.getByRole("region", { name: "Tasks" });
const notes = (page: Page) => page.getByRole("region", { name: "Notes" });

function count(page: Page, pathname: string) {
  const counter = { requests: 0, navigations: 0 };
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === pathname) counter.requests++;
    if (request.isNavigationRequest()) counter.navigations++;
  });
  return counter;
}

async function visibility(page: Page, state: DocumentVisibilityState) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test("a write in one tab appears in another without polling or navigation", async ({
  page,
  context,
  viewer: _viewer,
  marker,
}) => {
  await page.goto("/");
  await expect(status(page)).toHaveText("connected");
  await tasks(page).getByLabel("Filter tasks").fill(marker);
  const watched = count(page, "/api/tasks");

  const writer = await context.newPage();
  await writer.goto("/");
  await writer.getByLabel("New task").fill(`${marker} from the other tab`);
  await writer.getByRole("button", { name: "Add task" }).click();

  await expect(tasks(page).getByText(`${marker} from the other tab`)).toBeVisible();
  await expect(tasks(page).getByLabel("Filter tasks")).toHaveValue(marker);
  expect(watched.navigations).toBe(0);

  // Nothing rereads while nothing changes.
  const settled = watched.requests;
  await page.waitForTimeout(3_000);
  expect(watched.requests).toBe(settled);
});

test("rolled-back and no-op writes cause no read; another resource stays isolated", async ({
  page,
  db,
  viewer: _viewer,
  marker,
}) => {
  await db.query("INSERT INTO tasks (title) VALUES ($1)", [`${marker} existing`]);
  await page.goto("/");
  await expect(status(page)).toHaveText("connected");
  await expect(tasks(page).getByText(`${marker} existing`)).toBeVisible();
  const taskReads = count(page, "/api/tasks");

  await db.query("BEGIN");
  await db.query("INSERT INTO tasks (title) VALUES ($1)", [`${marker} rolled back`]);
  await db.query("ROLLBACK");
  await db.query("UPDATE tasks SET title = title WHERE title = $1", [`${marker} existing`]);
  await db.query("INSERT INTO notes (body) VALUES ($1)", [`${marker} note`]);
  await expect(notes(page).getByText(`${marker} note`)).toBeVisible();
  expect(taskReads.requests).toBe(0);

  await db.query("INSERT INTO tasks (title) VALUES ($1)", [`${marker} committed`]);
  await expect(tasks(page).getByText(`${marker} committed`)).toBeVisible();
  await expect(tasks(page).getByText(`${marker} rolled back`)).toHaveCount(0);
  expect(taskReads.requests).toBe(1);
});

test("revoked access stops updates until access returns and the viewer retries", async ({
  page,
  db,
  viewer,
  marker,
}) => {
  await page.goto("/");
  await expect(status(page)).toHaveText("connected");
  const streams = count(page, "/api/live");

  await db.query("UPDATE viewers SET allowed = false WHERE name = $1", [viewer]);
  await db.query("INSERT INTO tasks (title) VALUES ($1)", [`${marker} while revoked`]);
  await expect(status(page)).toHaveText("unauthorized");
  await expect(tasks(page).getByText(`${marker} while revoked`)).toHaveCount(0);

  // A denial is not retried automatically.
  await page.waitForTimeout(3_000);
  expect(streams.requests).toBe(0);

  await db.query("UPDATE viewers SET allowed = true WHERE name = $1", [viewer]);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(status(page)).toHaveText("connected");
  await expect(tasks(page).getByText(`${marker} while revoked`)).toBeVisible();
  expect(streams.navigations).toBe(0);
});

test("anonymous viewers cannot subscribe", async ({ page, request }) => {
  expect((await request.get("/api/live?resource=tasks")).status()).toBe(403);
  expect((await request.get("/api/live?resource=undeclared")).status()).toBe(400);
  await page.goto("/");
  await expect(status(page)).toHaveText("unauthorized");
});

test("a lost database listener recovers and catches up on what it missed", async ({
  page,
  db,
  viewer: _viewer,
  marker,
}) => {
  await page.goto("/");
  await expect(status(page)).toHaveText("connected");
  const watched = count(page, "/api/tasks");

  await db.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'live_resource'"
  );
  await expect(status(page)).toHaveText("reconnecting");
  await db.query("INSERT INTO tasks (title) VALUES ($1)", [`${marker} missed`]);

  await expect(status(page)).toHaveText("connected");
  await expect(tasks(page).getByText(`${marker} missed`)).toBeVisible();
  expect(watched.navigations).toBe(0);
});

test("failed and slow reads keep the current rows, and later changes still arrive", async ({
  page,
  db,
  viewer,
  marker,
}) => {
  await db.query("INSERT INTO tasks (title) VALUES ($1)", [`${marker} kept`]);
  await page.goto("/");
  await expect(status(page)).toHaveText("connected");
  const watched = count(page, "/api/tasks");

  await db.query("UPDATE viewers SET fault = 'fail' WHERE name = $1", [viewer]);
  await db.query("INSERT INTO tasks (title) VALUES ($1)", [`${marker} during failure`]);
  await expect(status(page)).toHaveText("reconnecting");
  await expect(tasks(page).getByText(`${marker} kept`)).toBeVisible();
  await db.query("UPDATE viewers SET fault = NULL WHERE name = $1", [viewer]);
  await expect(tasks(page).getByText(`${marker} during failure`)).toBeVisible();
  await expect(status(page)).toHaveText("connected");

  // A change during a read in flight is followed by exactly one more read.
  await db.query("UPDATE viewers SET fault = 'hold' WHERE name = $1", [viewer]);
  const before = watched.requests;
  await db.query("INSERT INTO tasks (title) VALUES ($1)", [`${marker} first`]);
  await expect.poll(() => watched.requests).toBe(before + 1);
  await db.query("INSERT INTO tasks (title) VALUES ($1)", [`${marker} second`]);
  await db.query("INSERT INTO tasks (title) VALUES ($1)", [`${marker} third`]);
  await expect(tasks(page).getByText(`${marker} kept`)).toBeVisible();
  await db.query("UPDATE viewers SET fault = NULL WHERE name = $1", [viewer]);
  await expect(tasks(page).getByText(`${marker} third`)).toBeVisible();
  await expect.poll(() => watched.requests).toBe(before + 2);
  await page.waitForTimeout(1_000);
  expect(watched.requests).toBe(before + 2);
  expect(watched.navigations).toBe(0);
});

test("a hidden tab keeps updating, waits out an outage, and catches up on return", async ({
  page,
  context,
  db,
  viewer: _viewer,
  marker,
}) => {
  await page.goto("/");
  await expect(status(page)).toHaveText("connected");
  const streams = count(page, "/api/live");
  await page.clock.install();

  await visibility(page, "hidden");
  await db.query("INSERT INTO tasks (title) VALUES ($1)", [`${marker} while hidden`]);
  await expect(tasks(page).getByText(`${marker} while hidden`)).toBeVisible();

  // A healthy return neither resubscribes nor rereads.
  const reads = count(page, "/api/tasks");
  await visibility(page, "visible");
  await page.clock.runFor(1_000);
  expect(streams.requests + reads.requests).toBe(0);

  await visibility(page, "hidden");
  await context.setOffline(true);
  await expect(status(page)).toHaveText("reconnecting");
  await context.setOffline(false);
  await page.clock.runFor(60_000);
  expect(streams.requests).toBe(0);

  await db.query("INSERT INTO tasks (title) VALUES ($1)", [`${marker} during outage`]);
  await visibility(page, "visible");
  await expect(tasks(page).getByText(`${marker} during outage`)).toBeVisible();
  await expect(status(page)).toHaveText("connected");
  expect(streams.requests).toBe(1);
});
