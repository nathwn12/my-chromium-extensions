#!/usr/bin/env node
/**
 * Dependency-free icon generator: orange rounded square, white play triangle,
 * transparent outside. Writes 16/32/48/128 PNGs next to this folder.
 *
 *   node extension/tools/make-icons.mjs          # write + verify
 *   node extension/tools/make-icons.mjs --check  # verify only (no writes)
 *
 * Output bytes are deterministic: same raster, same zlib settings, same file.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;
const ORANGE = [0xf4, 0x75, 0x21];
const WHITE = [0xff, 0xff, 0xff];
const CORNER_RADIUS = 0.22; // fraction of the side
const TRIANGLE = [
  [0.37, 0.27],
  [0.37, 0.73],
  [0.74, 0.5]
];

/* ------------------------------------------------------------- geometry -- */

function insideRoundedSquare(x, y, size) {
  const r = size * CORNER_RADIUS;
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function sign(ax, ay, bx, by, px, py) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function insideTriangle(x, y, size) {
  const [a, b, c] = TRIANGLE.map(([u, v]) => [u * size, v * size]);
  const d1 = sign(a[0], a[1], b[0], b[1], x, y);
  const d2 = sign(b[0], b[1], c[0], c[1], x, y);
  const d3 = sign(c[0], c[1], a[0], a[1], x, y);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/* ---------------------------------------------------------------- raster -- */

function raster(size) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const step = 1 / SUPERSAMPLE;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let squareHits = 0;
      let triangleHits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = px + (sx + 0.5) * step;
          const y = py + (sy + 0.5) * step;
          if (!insideRoundedSquare(x, y, size)) continue;
          squareHits += 1;
          if (insideTriangle(x, y, size)) triangleHits += 1;
        }
      }
      const offset = (py * size + px) * 4;
      if (squareHits === 0) continue;
      const total = SUPERSAMPLE * SUPERSAMPLE;
      const white = triangleHits / total;
      const alpha = Math.round((squareHits / total) * 255);
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(ORANGE[channel] * (1 - white) + WHITE[channel] * white);
      }
      pixels[offset + 3] = alpha;
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
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---------------------------------------------------------------- check -- */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function verify(path, size) {
  const bytes = readFileSync(path);
  if (bytes.length < 33) throw new Error(`${path}: too short (${bytes.length} bytes)`);
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error(`${path}: bad PNG magic`);
  if (bytes.toString("latin1", 12, 16) !== "IHDR") throw new Error(`${path}: missing IHDR`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== size || height !== size) {
    throw new Error(`${path}: IHDR ${width}x${height}, expected ${size}x${size}`);
  }
  return bytes.length;
}

/* ----------------------------------------------------------------- main -- */

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "icons");
const checkOnly = process.argv.includes("--check");

if (!checkOnly) mkdirSync(outDir, { recursive: true });

let failed = false;
for (const size of SIZES) {
  const target = join(outDir, `icon${size}.png`);
  try {
    if (!checkOnly) writeFileSync(target, encodePng(size, raster(size)));
    const bytes = verify(target, size);
    console.log(`${checkOnly ? "verified" : "wrote"} icons/icon${size}.png ${size}x${size} ${bytes} bytes`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${error && error.message ? error.message : error}`);
  }
}

if (failed) process.exitCode = 1;
