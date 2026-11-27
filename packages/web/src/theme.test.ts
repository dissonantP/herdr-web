import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// F6: the views take every colour and size from the app's CSS variables, never a literal.

const src = new URL(".", import.meta.url).pathname;

describe("theme discipline", () => {
  const styled = [
    ...readdirSync(src).filter((f) => f.endsWith(".tsx")),
    ...readdirSync(join(src, "terminal")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => `terminal/${f}`),
  ];
  for (const file of styled) {
    it(`${file} has no colour or pixel literals`, () => {
      // The one exception: the hidden IME textarea is parked off-screen with fixed offsets (not a look).
      const source = readFileSync(join(src, file), "utf8")
        .split("\n")
        .filter((line) => !/textarea\.style|ghostty-ime/u.test(line))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//gu, "");
      expect(source.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b\d+(\.\d+)?px\b/gu) ?? []).toEqual([]);
    });
  }
});
