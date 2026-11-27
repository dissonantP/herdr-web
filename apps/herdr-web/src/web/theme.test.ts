import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// F6: every colour and size comes from theme.css (@herdr/web's views: its own theme.test.ts); the manifest and meta tag carry its background.

const web = new URL(".", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(web, path), "utf8");
const bg = /--bg:\s*(#[0-9a-fA-F]{6})/u.exec(read("theme.css"))?.[1];

describe("theme discipline", () => {
  const styled = [
    "app.css",
    ...readdirSync(web).filter((f) => f.endsWith(".tsx")),
  ];
  for (const file of styled) {
    it(`${file} has no colour or pixel literals`, () => {
      const source = read(file).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\(m(in|ax)-width: \d+px\)/gu, ""); // media queries cannot use variables
      expect(source.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b\d+(\.\d+)?px\b/gu) ?? []).toEqual([]);
    });
  }
});

describe("PWA metadata", () => {
  const manifest = JSON.parse(read("public/manifest.webmanifest")) as Record<string, unknown> & { icons: { src: string; sizes: string; purpose: string }[] };

  it("uses the theme's background", () => {
    expect(bg).toBeDefined();
    expect(manifest.background_color).toBe(bg);
    expect(manifest.theme_color).toBe(bg);
    expect(read("index.html")).toContain(`<meta name="theme-color" content="${bg}"`);
  });

  it("is installable: standalone, start_url, 192 and 512 icons, a maskable one", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    const sizes = manifest.icons.filter((i) => i.purpose === "any").map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });
});
