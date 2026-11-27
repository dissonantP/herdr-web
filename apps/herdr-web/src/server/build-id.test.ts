import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { currentBuild } from "./http.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

test("the build id is the entry script's hashed path, read fresh each time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-build-"));
  dirs.push(dir);
  writeFileSync(join(dir, "index.html"), '<head><script type="module" crossorigin src="/assets/index-aaa.js"></script></head>');
  expect(await currentBuild(dir)).toBe("/assets/index-aaa.js");
  writeFileSync(join(dir, "index.html"), '<head><script type="module" crossorigin src="/assets/index-bbb.js"></script></head>');
  expect(await currentBuild(dir)).toBe("/assets/index-bbb.js");
});

test("no build, no id", async () => {
  expect(await currentBuild(null)).toBeNull();
  expect(await currentBuild("/nonexistent-herdr-dir")).toBeNull();
});
