import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { servableImage, uploadsRoot } from "./upload-file.ts";

let dir = "";
let root = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-upload-file-"));
  root = join(dir, "files");
  mkdirSync(join(root, "t1", "deeper"), { recursive: true });
  writeFileSync(join(root, "t1", "a.png"), "x");
  writeFileSync(join(root, "t1", "A.JPG"), "x");
  writeFileSync(join(root, "t1", "doc.txt"), "x");
  writeFileSync(join(root, "t1", "vector.svg"), "<svg/>");
  writeFileSync(join(root, "t1", "deeper", "b.png"), "x");
  writeFileSync(join(root, "top.png"), "x");
  writeFileSync(join(dir, "outside.png"), "x");
  symlinkSync(join(dir, "outside.png"), join(root, "t1", "link.png"));
  mkdirSync(join(root, "t2"));
  writeFileSync(join(root, "t2", "notes.txt"), "x");
  symlinkSync(join(root, "t2", "notes.txt"), join(root, "t1", "l.png"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("servableImage", () => {
  it("serves an image directly inside one terminal's folder", async () => {
    expect((await servableImage(root, join(root, "t1", "a.png")))?.type).toBe("image/png");
    expect((await servableImage(root, join(root, "t1", "A.JPG")))?.type).toBe("image/jpeg");
  });
  it("refuses other types (including SVG), other depths, other places, links out and odd paths", async () => {
    for (const p of [join(root, "t1", "doc.txt"), join(root, "t1", "vector.svg"), join(root, "t1", "deeper", "b.png"), join(root, "top.png"), join(dir, "outside.png"), join(root, "t1", "link.png"), join(root, "t1", "l.png"), join(root, "t1", "..", "..", "outside.png"), join(root, "t1", "missing.png"), "relative.png", "/etc/passwd", `${join(root, "t1", "a.png")}\0.png`]) {
      expect(await servableImage(root, p), p).toBeNull();
    }
  });
});

describe("uploadsRoot", () => {
  it("follows the core's state directory", () => {
    expect(uploadsRoot({ XDG_STATE_HOME: "/s", HC_SESSION: "qa" }, "/h")).toBe("/s/herdr-core/qa/files");
    expect(uploadsRoot({}, "/h")).toBe("/h/.local/state/herdr-core/default/files");
  });
});
