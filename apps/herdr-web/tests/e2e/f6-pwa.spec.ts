import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F6: installable (manifest + service worker + icons), works at 360 px and on desktop, dark and
// compact. Installability is checked by auditing the manifest, its icons and the service worker.

test.beforeEach(async () => {
  await seed(qaCore());
});

test("@F6 manifest is valid and its icons exist with the declared sizes", async ({ page, request }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/manifest.webmanifest");
  const response = await request.get("/manifest.webmanifest");
  expect(response.headers()["content-type"]).toContain("manifest+json");
  const manifest = (await response.json()) as { name: string; start_url: string; display: string; icons: { src: string; sizes: string; type: string }[] };
  expect(manifest.name).toBeTruthy();
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  for (const icon of manifest.icons) {
    const png = await request.get(icon.src);
    expect(png.ok(), icon.src).toBe(true);
    const body = await png.body();
    expect(body.subarray(1, 4).toString("ascii")).toBe("PNG");
    const [w, h] = icon.sizes.split("x").map(Number);
    expect([body.readUInt32BE(16), body.readUInt32BE(20)]).toEqual([w, h]);
  }
  expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
});

test("@F6 a service worker takes control", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload(); // now controlled
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  // Pages are never served offline from a cache (F32: the login decides every page load).
});

test("@F6 Settings shows the running service worker, stamped with this build (task 084)", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.goto("/settings");
  const build = await page.evaluate(() => document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute("src") ?? "");
  const hash = build.replace(/^.*\/assets\/index-/u, "").replace(/\.js$/u, "");
  await expect(page.getByTestId("sw-version")).toHaveText(`Page ${hash}, service worker ${hash}`);
});

test("@F6 the service worker never caches the API", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
    return urls;
  });
  expect(cached.some((p) => p.startsWith("/api/"))).toBe(false);
});

test("@F6 dark, no horizontal scroll, theme colours", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  const { scrollWidth, innerWidth, bodyBg } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  const hex = /--bg:\s*#([0-9a-fA-F]{6})/u.exec(readFileSync("src/web/theme.css", "utf8"))?.[1] ?? "";
  const n = parseInt(hex, 16);
  expect(bodyBg).toBe(`rgb(${String((n >> 16) & 255)}, ${String((n >> 8) & 255)}, ${String(n & 255)})`);
  await page.screenshot({ path: info.outputPath(`f6-${info.project.name}-tree.png`) });
});
