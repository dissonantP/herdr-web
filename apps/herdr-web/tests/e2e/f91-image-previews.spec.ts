import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { appendTranscript, writeTranscript } from "../support/claude.ts";
import { addTab, controlledClaude, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 091: an attached image shows a removable thumbnail in the composer, and the sent message
// shows the image (not just its path). Other files keep their path-only look.

const SESSION = "cccccccc-bbbb-4ccc-8ddd-eeeeeeee9091";
const CWD = "/tmp/herdr-qa-f91";
/** A valid 48x32 PNG of coloured blocks (so a screenshot shows a real image). */
function makePng(): Buffer {
  const w = 48;
  const h = 32;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([x < 16 ? 220 : x < 32 ? 60 : 40, x < 16 ? 70 : x < 32 ? 180 : 90, x < 16 ? 70 : x < 32 ? 90 : 200], y * (w * 3 + 1) + 1 + x * 3);
  const crcTable = Array.from({ length: 256 }, (_, n) => [...Array(8)].reduce<number>((c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1), n));
  const crc = (b: Buffer) => (b.reduce((c, v) => (crcTable[(c ^ v) & 255] ?? 0) ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = makePng();
let dir = "";
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

for (const [name, w] of [["desktop", 1280], ["phone", 360]] as const) {
  test(`@F91 image attachments preview in the composer and in the sent message (${name})`, async ({ page, request }, info) => {
    test.skip(info.project.name !== name, "one run per viewport");
    dir = mkdtempSync(join(tmpdir(), "herdr-f91-"));
    writeFileSync(join(dir, "state"), "idle");
    const core = qaCore();
    const seeded = await seed(core);
    const transcript = writeTranscript(core, CWD, SESSION, []);
    await addTab(core, seeded, "alpha", "pics", controlledClaude(join(dir, "state")), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto(`/s/${IDS.alpha}`);
    await page.getByRole("tab", { name: "pics", exact: true }).click();
    const box = page.getByTestId("composer-text");

    // A non-image keeps its look: the path in the text, no thumbnail.
    await page.getByTestId("attach-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
    await expect(box).toHaveValue(/notes\.txt $/u);
    await expect(page.getByTestId("attach-preview")).toHaveCount(0);

    // An image shows a thumbnail, which can be removed (and takes its path out of the text).
    await page.getByTestId("attach-input").setInputFiles({ name: "wrong one.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByTestId("attach-preview")).toHaveCount(1);
    await expect(page.getByTestId("attach-preview").locator("img")).toHaveJSProperty("complete", true);
    expect(await page.getByTestId("attach-preview").locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(48);
    await page.getByTestId("attach-remove").click();
    await expect(page.getByTestId("attach-preview")).toHaveCount(0);
    await expect(box).not.toHaveValue(/wrong_one\.png/u);

    await page.getByTestId("attach-input").setInputFiles({ name: "right one.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByTestId("attach-preview")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`${name}-composer.png`) });
    const path = (await box.inputValue()).trim().split(" ").pop() ?? "";
    expect(path).toMatch(/right_one\.png$/u);

    // Sent (the composer is empty again, as after a send): the transcript's user message holds the path, and the message shows the image.
    await box.fill("");
    appendTranscript(transcript, [JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-11-16T07:00:00.000Z", isSidechain: false, message: { role: "user", content: `what is this ${path}` } })]);
    const sent = page.getByTestId("sent-image");
    await expect(sent).toHaveCount(1);
    await expect(sent.locator("img")).toHaveJSProperty("complete", true);
    expect(await sent.locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(48);
    await page.screenshot({ path: info.outputPath(`${name}-sent.png`) });

    // The server hands back only uploaded images.
    const url = (p: string) => `/api/upload-image?path=${encodeURIComponent(p)}`;
    expect((await request.get(url(path))).status()).toBe(200);
    expect((await request.get(url("/etc/passwd"))).status()).toBe(404);
    expect((await request.get(url(`${path}/../../../../../../etc/hostname`))).status()).toBe(404);
  });
}
