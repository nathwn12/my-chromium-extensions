#!/usr/bin/env node
/**
 * Slowed-reverb icon generator: near-black rounded tile (#0B0F14) with a tall
 * light bar (#EEF3F6) and four descending pink bars (#FF7A9C), transparent
 * outside. Artwork matches assets/icon.svg (bars as tile fractions); the tile
 * holds an 84% width with a RIGHT nudge: 10% left inset, 6% right inset
 * (the 8% baseline plus 2 points of right shift), 8% top/bottom.
 *
 *   node assets/make-icons.mjs          # write + verify
 *   node assets/make-icons.mjs --check  # verify only (no writes)
 *
 * Output bytes are deterministic: same raster, same zlib settings, same file.
 */
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIZES = [16, 24, 32, 48, 128];
const LEFT = 0.1; // right nudge: glyph starts at 10% of canvas
const RIGHT = 0.06; // glyph ends at 94% of canvas
const TOP = 0.08;
const BOTTOM = 0.08;
const SUPERSAMPLE = 8;
const TILE = [0x0b, 0x0f, 0x14];
const LIGHT = [0xee, 0xf3, 0xf6]; // tall left bar (matches icon.svg)
const PINK = [0xff, 0x7a, 0x9c]; // descending tail (matches icon.svg)
// Bars as tile fractions measured from icon.svg (tile 16..496 of 512):
// x=112/170/228/286/344 w=40; y/h per bar; tile-relative u=(x-16)/480.
const BARS = [
  { u: 96 / 480, v: 140 / 480, w: 40 / 480, h: 200 / 480, c: LIGHT },
  { u: 154 / 480, v: 165 / 480, w: 40 / 480, h: 150 / 480, c: PINK },
  { u: 212 / 480, v: 185 / 480, w: 40 / 480, h: 110 / 480, c: PINK },
  { u: 270 / 480, v: 200 / 480, w: 40 / 480, h: 80 / 480, c: PINK },
  { u: 328 / 480, v: 212 / 480, w: 40 / 480, h: 56 / 480, c: PINK },
];
const CORNER_RADIUS = (112 / 480) * (1 - LEFT - RIGHT); // rx=112 over tile 480

const here = dirname(fileURLToPath(import.meta.url));
const iconDir = join(here, "..", "icons");

/* ------------------------------------------------------------- geometry -- */

function insideTile(x, y, size) {
  const x0 = LEFT * size;
  const x1 = (1 - RIGHT) * size;
  const y0 = TOP * size;
  const y1 = (1 - BOTTOM) * size;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const r = CORNER_RADIUS * size;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function barAt(x, y, size) {
  const x0 = LEFT * size;
  const y0 = TOP * size;
  const tw = (1 - LEFT - RIGHT) * size;
  const th = (1 - TOP - BOTTOM) * size;
  for (const b of BARS) {
    const bx0 = x0 + b.u * tw;
    const by0 = y0 + b.v * th;
    if (x >= bx0 && x <= bx0 + b.w * tw && y >= by0 && y <= by0 + b.h * th) return b.c;
  }
  return null;
}

/* ---------------------------------------------------------------- raster -- */

function raster(size) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const step = 1 / SUPERSAMPLE;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let tileHits = 0;
      let lightHits = 0;
      let pinkHits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = px + (sx + 0.5) * step;
          const y = py + (sy + 0.5) * step;
          if (!insideTile(x, y, size)) continue;
          tileHits += 1;
          const c = barAt(x, y, size);
          if (c === LIGHT) lightHits += 1;
          else if (c === PINK) pinkHits += 1;
        }
      }
      if (tileHits === 0) continue;
      const total = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (py * size + px) * 4;
      const li = lightHits / total;
      const pi = pinkHits / total;
      const ti = 1 - li - pi;
      pixels[offset] = Math.round(TILE[0] * ti + LIGHT[0] * li + PINK[0] * pi);
      pixels[offset + 1] = Math.round(TILE[1] * ti + LIGHT[1] * li + PINK[1] * pi);
      pixels[offset + 2] = Math.round(TILE[2] * ti + LIGHT[2] * li + PINK[2] * pi);
      pixels[offset + 3] = Math.round((tileHits / total) * 255);
    }
  }
  return pixels;
}

/* ------------------------------------------------------------------ png -- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

function encodePNG(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc(size * (1 + stride), 0);
  for (let y = 0; y < size; y += 1) {
    pixels.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- verify -- */

function alphaBBox(pixels, size) {
  let minX = size;
  let maxX = -1;
  let minY = size;
  let maxY = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (pixels[(y * size + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

function verify(size, png) {
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (w !== size || h !== size) throw new Error(`icon${size}: IHDR ${w}x${h}`);
  const pixels = raster(size);
  const { minX, maxX, minY, maxY } = alphaBBox(pixels, size);
  if (minX < 0 || maxX >= size || minY < 0 || maxY >= size) {
    throw new Error(`icon${size}: clipped bbox x[${minX},${maxX}] y[${minY},${maxY}]`);
  }
  const left = minX;
  const right = size - 1 - maxX;
  if (size >= 48) {
    const expL = Math.round(LEFT * size);
    const expR = Math.round(RIGHT * size);
    if (Math.abs(left - expL) > 1 || Math.abs(right - expR) > 1) {
      throw new Error(`icon${size}: insets L${left}/R${right}, expected ~${expL}/${expR}`);
    }
  }
  console.log(`ok   icon${size}.png ${size}x${size} bbox x[${minX},${maxX}] L${left}/R${right}`);
  return png.equals(encodePNG(size, pixels));
}

const checkOnly = process.argv.includes("--check");
let dirty = 0;
for (const size of SIZES) {
  const target = join(iconDir, `icon${size}.png`);
  const png = encodePNG(size, raster(size));
  if (!checkOnly) writeFileSync(target, png);
  const onDisk = readFileSync(target);
  const match = verify(size, onDisk);
  if (!match) {
    console.log(`FAIL icon${size}.png bytes differ from generator`);
    dirty += 1;
  }
}
if (dirty > 0) process.exit(1);
console.log(checkOnly ? "check: all five match the generator" : "wrote + verified 16/24/32/48/128");
