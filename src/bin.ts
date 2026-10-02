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

/**
 * `text` with the block current: replaced between its markers, or appended when it
 * has none. Undefined for a marker without its pair, where replacing or appending
 * would discard text the block does not own.
 */
function withBlock(text: string): string | undefined {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = BLOCK.join(eol);
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END, Math.max(begin, 0));
  if ((begin === -1) !== (end === -1)) return undefined;
  if (begin !== -1) return text.slice(0, begin) + block + text.slice(end + END.length);
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

// Every file is read and decided before any is written, so a refusal leaves all of them alone.
const stale: [file: string, next: string][] = [];
for (const file of files) {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = withBlock(current);
  if (next === undefined) {
    console.error(
      `${file}: has one live-resource-agent-rules marker without the other; fix it by hand`
    );
    process.exit(2);
  }
  if (next !== current) stale.push([file, next]);
}
if (check) {
  for (const [file] of stale) {
    console.error(`${file}: live-resource agent rules are missing or out of date`);
  }
  if (stale.length > 0) {
    console.error(`Run: npx live-resource agent-rules ${stale.map(([file]) => file).join(" ")}`);
    process.exit(1);
  }
} else {
  for (const [file, next] of stale) {
    writeFileSync(file, next);
    console.log(`${file}: updated`);
  }
}
