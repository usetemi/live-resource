#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BEGIN = "<!-- BEGIN:live-resource-agent-rules -->";
const END = "<!-- END:live-resource-agent-rules -->";
// Carries no version, so an upgrade alone never makes a current block stale.
const BLOCK = [
  BEGIN,
  "Before writing or changing code that uses `@usetemi/live-resource` (a topic, a trigger,",
  "`authorize`, a read, or a status indicator), read",
  "`node_modules/@usetemi/live-resource/usage-rules.md`. It ships with the installed version.",
  END,
];
const USAGE = `Usage: live-resource agent-rules [--check] <file>...

Writes a marked block that points at the package's usage-rules.md into each file,
replacing an existing block and leaving everything outside the markers alone.
A file that does not exist is created. --check writes nothing and exits 1 when a
file's block is missing or out of date.`;

/** `text` with the block current: replaced between its markers, or appended when it has none. */
function withBlock(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = BLOCK.join(eol);
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END, begin);
  if (begin !== -1 && end !== -1) {
    return text.slice(0, begin) + block + text.slice(end + END.length);
  }
  if (text === "") return block + eol;
  return text + (text.endsWith(eol) ? "" : eol) + eol + block + eol;
}

const [command, ...rest] = process.argv.slice(2);
const check = rest.includes("--check");
const files = rest.filter((argument) => argument !== "--check");
if (command !== "agent-rules" || files.length === 0 || files.some((file) => file.startsWith("-"))) {
  console.error(USAGE);
  process.exit(2);
}

const stale: string[] = [];
for (const file of files) {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = withBlock(current);
  if (next === current) continue;
  stale.push(file);
  if (!check) writeFileSync(file, next);
}
if (check && stale.length > 0) {
  for (const file of stale)
    console.error(`${file}: live-resource agent rules are missing or out of date`);
  console.error(`Run: npx live-resource agent-rules ${stale.join(" ")}`);
  process.exit(1);
}
for (const file of stale) console.log(`${file}: updated`);
