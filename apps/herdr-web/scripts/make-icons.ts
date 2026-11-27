import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// Draws the app icons (a terminal prompt chevron + cursor on the theme's dark background) into
// src/web/public/icons/ with no dependencies. Colours are read from theme.css's --bg and --accent.
// Run `node scripts/make-icons.ts` after changing them; the PNGs are committed.

import { readFileSync } from "node:fs";

const theme = readFileSync(new URL("../src/web/theme.css", import.meta.url), "utf8");
const token = (name: string): [number, number, number] => {
  const m = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`, "u").exec(theme);
  if (m?.[1] === undefined) throw new Error(`no --${name} in theme.css`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const BG = token("bg");
const FG = token("accent");

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (crcTable[(c ^ b) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Distance from point p to segment a-b. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Coverage 0..1 of the glyph at unit coordinates, `scale` shrinks it toward the centre (maskable safe zone). */
function glyph(u: number, v: number, scale: number): number {
  const x = (u - 0.5) / scale + 0.5;
  const y = (v - 0.5) / scale + 0.5;
  const w = 0.07;
  const chevron = Math.min(segDist(x, y, 0.3, 0.32, 0.5, 0.5), segDist(x, y, 0.5, 0.5, 0.3, 0.68)) <= w;
  const cursor = x >= 0.56 && x <= 0.72 && y >= 0.63 && y <= 0.7;
  return chevron || cursor ? 1 : 0;
}

function png(size: number, scale: number, rounded: boolean): Buffer {
  const ss = 3;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let cover = 0;
      let alpha = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          const r = 0.18;
          const cx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
          const cy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
          if (!rounded || cx * cx + cy * cy <= r * r) {
            alpha += 1;
            cover += glyph(u, v, scale);
          }
        }
      }
      const n = ss * ss;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const g = alpha === 0 ? 0 : cover / alpha;
      raw[o] = Math.round(BG[0] * (1 - g) + FG[0] * g);
      raw[o + 1] = Math.round(BG[1] * (1 - g) + FG[1] * g);
      raw[o + 2] = Math.round(BG[2] * (1 - g) + FG[2] * g);
      raw[o + 3] = Math.round((alpha / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const out = new URL("../src/web/public/icons/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("icon-192.png", out), png(192, 1, true));
writeFileSync(new URL("icon-512.png", out), png(512, 1, true));
// Maskable: full-bleed background, glyph inside the 80% safe zone.
writeFileSync(new URL("icon-maskable-512.png", out), png(512, 0.8, false));
writeFileSync(new URL("apple-touch-icon.png", out), png(180, 0.8, false));
console.log("icons written");
