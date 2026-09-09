#!/usr/bin/env node
/**
 * Generates the PWA icon set into `web/public/`.
 *
 * Deliberately dependency-free: a design toolchain (sharp, canvas, resvg) is a
 * native binary and a build step for four static files that change roughly
 * never. Node's own `zlib` plus ~60 lines of PNG chunk assembly is the whole
 * cost, and the output is committed, so nobody has to run this to build.
 *
 *     node scripts/gen-icons.mjs
 *
 * The mark is the terminal prompt the whole app is about: a `>` chevron and a
 * cursor bar, in the app foreground `#e2e6ea` on the app surface `#101215`.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');

const BG = [0x10, 0x12, 0x15];
const FG = [0xe2, 0xe6, 0xea];

// ---------------------------------------------------------------- PNG encoder

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes an RGB pixel buffer (size*size*3) as a PNG. Filter 0 on every row. */
function encodePng(size, rgb) {
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- drawing

/**
 * Signed distance from `p` to the segment `a`–`b`.
 *
 * Strokes are drawn as distance fields rather than rasterised polygons so the
 * chevron gets round caps and clean antialiasing for free, at any size.
 */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Renders the mark at `size`.
 *
 * `inset` is the fraction of the canvas the glyph is scaled down to. Maskable
 * icons pass a smaller value so the whole mark survives Android's aggressive
 * circular crop (only the middle 80% is guaranteed visible).
 */
function renderIcon(size, inset) {
  const rgb = Buffer.alloc(size * size * 3);

  // Glyph geometry in a unit square, then mapped through `inset`.
  const map = (u) => (0.5 + (u - 0.5) * inset) * size;
  const stroke = 0.085 * inset * size;

  const chevron = [
    [map(0.3), map(0.32), map(0.55), map(0.5)],
    [map(0.55), map(0.5), map(0.3), map(0.68)],
  ];
  const cursor = [map(0.63), map(0.68), map(0.78), map(0.68)];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      let d = distanceToSegment(px, py, ...cursor);
      for (const seg of chevron) d = Math.min(d, distanceToSegment(px, py, ...seg));

      // One-pixel linear ramp across the stroke edge — enough antialiasing to
      // stop the diagonals looking like a staircase at 48px.
      const alpha = Math.max(0, Math.min(1, stroke / 2 - d + 0.5));

      const i = (y * size + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        rgb[i + c] = Math.round(BG[c] + (FG[c] - BG[c]) * alpha);
      }
    }
  }
  return encodePng(size, rgb);
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#101215"/>
  <g fill="none" stroke="#e2e6ea" stroke-width="5.4" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="19.2,20.5 35.2,32 19.2,43.5"/>
    <line x1="40.3" y1="43.5" x2="49.9" y2="43.5"/>
  </g>
</svg>
`;

const files = [
  ['icon-192.png', renderIcon(192, 0.82)],
  ['icon-512.png', renderIcon(512, 0.82)],
  // iOS never masks the artwork itself, only the corners, so it keeps the
  // tighter framing.
  ['apple-touch-icon.png', renderIcon(180, 0.82)],
  ['icon-maskable-512.png', renderIcon(512, 0.62)],
  ['favicon.svg', Buffer.from(FAVICON_SVG, 'utf8')],
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, data] of files) {
  writeFileSync(join(OUT_DIR, name), data);
  process.stdout.write(`${name}  ${data.length} bytes\n`);
}
