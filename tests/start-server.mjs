// Playwright's web server: disposable Postgres, the example's schema, then the
// production build of the example app with the packed package installed.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";

const root = new URL("..", import.meta.url).pathname;
const example = `${root}example`;
const port = process.env.PORT ?? "3210";

const container = await new PostgreSqlContainer(
  process.env.POSTGRES_IMAGE ?? "postgres:16-alpine"
).start();
const databaseUrl = container.getConnectionUri();

const client = new Client({ connectionString: databaseUrl });
await client.connect();
await client.query(
  readFileSync(
    `${example}/node_modules/@usetemi/live-resource/sql/live_resource_notify.sql`,
    "utf8"
  )
);
await client.query(readFileSync(`${example}/schema.sql`, "utf8"));
await client.end();
writeFileSync(`${root}.test-state.json`, JSON.stringify({ databaseUrl }));

const env = { ...process.env, DATABASE_URL: databaseUrl, PORT: port };
const build = spawnSync("npx", ["next", "build"], { cwd: example, env, stdio: "inherit" });
if (build.status !== 0) {
  await container.stop();
  process.exit(build.status ?? 1);
}
const app = spawn("npx", ["next", "start", "-p", port], { cwd: example, env, stdio: "inherit" });

async function stop() {
  app.kill("SIGTERM");
  await container.stop();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
