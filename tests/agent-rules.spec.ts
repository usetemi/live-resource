import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

// The command as a consumer runs it: the bin the packed tarball installed into the example.
const bin = fileURLToPath(new URL("../example/node_modules/.bin/live-resource", import.meta.url));

function run(cwd: string, ...args: string[]) {
  const result = spawnSync(bin, ["agent-rules", ...args], { cwd, encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

const BEGIN = "<!-- BEGIN:live-resource-agent-rules -->";
const END = "<!-- END:live-resource-agent-rules -->";

test("the block is appended once and a second run changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rules-"));
  const file = join(dir, "AGENTS.md");
  writeFileSync(file, "# Project\n\nKeep this.");

  expect(run(dir, "AGENTS.md").status).toBe(0);
  const first = readFileSync(file, "utf8");
  expect(first.startsWith("# Project\n\nKeep this.\n\n" + BEGIN)).toBe(true);
  expect(first).toContain("node_modules/@usetemi/live-resource/usage-rules.md");
  expect(first.endsWith(END + "\n")).toBe(true);

  expect(run(dir, "AGENTS.md").output).toBe("");
  expect(readFileSync(file, "utf8")).toBe(first);
});

test("the file the block points at is in the installed package", () => {
  const rules = new URL(
    "../example/node_modules/@usetemi/live-resource/usage-rules.md",
    import.meta.url
  );
  expect(existsSync(rules)).toBe(true);
});

test("a stale block is replaced where it stands and the text around it survives", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rules-"));
  const file = join(dir, "AGENTS.md");
  writeFileSync(file, `# Above\n\n${BEGIN}\nold words\n${END}\n\n# Below\n`);

  expect(run(dir, "AGENTS.md").status).toBe(0);
  const text = readFileSync(file, "utf8");
  expect(text.startsWith("# Above\n\n" + BEGIN)).toBe(true);
  expect(text.endsWith(END + "\n\n# Below\n")).toBe(true);
  expect(text).not.toContain("old words");
  expect(text.split(BEGIN)).toHaveLength(2);
});

test("a CRLF file keeps its line endings", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rules-"));
  const file = join(dir, "AGENTS.md");
  writeFileSync(file, "# Project\r\n");

  run(dir, "AGENTS.md");
  expect(readFileSync(file, "utf8").replaceAll("\r\n", "")).not.toContain("\n");
});

test("a missing file is created holding only the block", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rules-"));

  expect(run(dir, "AGENTS.md").status).toBe(0);
  const text = readFileSync(join(dir, "AGENTS.md"), "utf8");
  expect(text.startsWith(BEGIN)).toBe(true);
  expect(text.endsWith(END + "\n")).toBe(true);
});

test("--check names each file that is missing or stale and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rules-"));
  writeFileSync(join(dir, "current.md"), "# Current\n");
  run(dir, "current.md");
  writeFileSync(join(dir, "none.md"), "# None\n");
  writeFileSync(join(dir, "stale.md"), `${BEGIN}\nold words\n${END}\n`);

  expect(run(dir, "--check", "current.md").status).toBe(0);

  const checked = run(dir, "--check", "current.md", "none.md", "stale.md", "absent.md");
  expect(checked.status).toBe(1);
  expect(checked.output).toContain("none.md");
  expect(checked.output).toContain("stale.md");
  expect(checked.output).toContain("absent.md");
  expect(checked.output).not.toContain("current.md:");
  expect(readFileSync(join(dir, "none.md"), "utf8")).toBe("# None\n");
  expect(readFileSync(join(dir, "stale.md"), "utf8")).toContain("old words");
  expect(existsSync(join(dir, "absent.md"))).toBe(false);
});

test("a marker without its pair is refused and no file in the call is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rules-"));
  writeFileSync(join(dir, "first.md"), "# First\n");
  const broken = `${BEGIN}\nold words\n\n# Mine\n`;
  writeFileSync(join(dir, "broken.md"), broken);

  const refused = run(dir, "first.md", "broken.md");
  expect(refused.status).toBe(2);
  expect(refused.output).toContain("broken.md");
  expect(readFileSync(join(dir, "broken.md"), "utf8")).toBe(broken);
  expect(readFileSync(join(dir, "first.md"), "utf8")).toBe("# First\n");
});

test("a call without a file to write is refused with the usage text", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rules-"));

  const refused = run(dir);
  expect(refused.status).toBe(2);
  expect(refused.output).toContain("Usage: live-resource agent-rules");
});
