/**
 * Generate build/icon.ico — the Forge mark, drawn programmatically.
 *
 * Why generate rather than commit a binary: the mark is trivial geometry (the
 * same rotated rounded square the renderer draws for Forge's avatar), and a
 * script keeps it editable and reviewable. It also avoids adding an image
 * toolchain — everything here uses node:zlib and hand-rolled PNG/ICO writers.
 *
 * Run: node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Accent blue field, white mark. At 16px a tinted-on-navy mark turns to mud,
// so the app icon inverts the in-app treatment for contrast.
const BG = [0x2f, 0x6f, 0xed];
const FG = [0xff, 0xff, 0xff];
const SS = 4; // supersample factor, then box-average down for antialiasing

/** Signed distance to a rounded rectangle centred on the origin. */
function sdRoundRect(x, y, halfW, halfH, r) {
  const qx = Math.abs(x) - (halfW - r);
  const qy = Math.abs(y) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Render one square RGBA icon at `size` px. */
function render(size) {
  const n = size * SS;
  const acc = new Float64Array(size * size * 4);

  const c = n / 2;
  const bgHalf = n * 0.5; // full-bleed field
  const bgR = n * 0.22; // rounded-square app-icon silhouette
  const mkHalf = n * 0.205; // the diamond: a square rotated 45°
  const mkR = n * 0.038;
  const cos = Math.SQRT1_2;

  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const x = px + 0.5 - c;
      const y = py + 0.5 - c;

      // Coverage of the background plate.
      const dBg = sdRoundRect(x, y, bgHalf, bgHalf, bgR);
      const aBg = Math.min(Math.max(0.5 - dBg, 0), 1);

      // Coverage of the mark, in a frame rotated 45°.
      const rx = (x * cos) + (y * cos);
      const ry = (-x * cos) + (y * cos);
      const dMk = sdRoundRect(rx, ry, mkHalf, mkHalf, mkR);
      const aMk = Math.min(Math.max(0.5 - dMk, 0), 1) * aBg;

      // Composite mark over plate, premultiplied by plate alpha.
      const r = (BG[0] * (1 - aMk)) + (FG[0] * aMk);
      const g = (BG[1] * (1 - aMk)) + (FG[1] * aMk);
      const b = (BG[2] * (1 - aMk)) + (FG[2] * aMk);

      const ox = Math.floor(px / SS);
      const oy = Math.floor(py / SS);
      const o = ((oy * size) + ox) * 4;
      acc[o] += r * aBg;
      acc[o + 1] += g * aBg;
      acc[o + 2] += b * aBg;
      acc[o + 3] += aBg * 255;
    }
  }

  const per = SS * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size * 4; i++) out[i] = Math.round(acc[i] / per);
  return out;
}

// --- minimal PNG writer -----------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 = compression / filter / interlace, all 0

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc((size * size * 4) + size);
  for (let y = 0; y < size; y++) {
    const at = y * ((size * 4) + 1);
    raw[at] = 0;
    rgba.copy(raw, at + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO container ----------------------------------------------------------

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const images = SIZES.map((s) => png(render(s), s));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(SIZES.length, 4);

const entries = Buffer.alloc(16 * SIZES.length);
let offset = header.length + entries.length;
SIZES.forEach((size, i) => {
  const at = i * 16;
  entries[at] = size === 256 ? 0 : size; // 0 means 256 in the ICO spec
  entries[at + 1] = size === 256 ? 0 : size;
  entries[at + 2] = 0; // palette size
  entries[at + 3] = 0; // reserved
  entries.writeUInt16LE(1, at + 4); // colour planes
  entries.writeUInt16LE(32, at + 6); // bits per pixel
  entries.writeUInt32LE(images[i].length, at + 8);
  entries.writeUInt32LE(offset, at + 12);
  offset += images[i].length;
});

const dest = join(ROOT, 'build');
mkdirSync(dest, { recursive: true });
const ico = Buffer.concat([header, entries, ...images]);
writeFileSync(join(dest, 'icon.ico'), ico);

process.stdout.write(`icon.ico -> ${SIZES.join('/')} px, ${ico.length} bytes\n`);
