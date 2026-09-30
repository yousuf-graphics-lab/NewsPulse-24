'use strict';

/**
 * Generates the PWA icons (192 / 512) with no image library — just a pixel
 * buffer and zlib. Keeps the repo dependency-free and the icons reproducible.
 *
 *   node scripts/make-icons.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* --------------------------------------------------------------- png out -- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- drawing --- */

function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const alpha = a / 255;
    px[i] = Math.round(px[i] * (1 - alpha) + r * alpha);
    px[i + 1] = Math.round(px[i + 1] * (1 - alpha) + g * alpha);
    px[i + 2] = Math.round(px[i + 2] * (1 - alpha) + b * alpha);
    px[i + 3] = Math.min(255, px[i + 3] + a);
  };
  const inside = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

  const S = size;
  const outerR = S * 0.20;

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      // rounded-square mask
      let inShape = true;
      if (x < outerR && y < outerR) inShape = inside(x, y, outerR, outerR, outerR);
      else if (x > S - outerR && y < outerR) inShape = inside(x, y, S - outerR, outerR, outerR);
      else if (x < outerR && y > S - outerR) inShape = inside(x, y, outerR, S - outerR, outerR);
      else if (x > S - outerR && y > S - outerR) inShape = inside(x, y, S - outerR, S - outerR, outerR);
      if (!inShape) continue;

      const inset = S * 0.08;
      const inner = x > inset && x < S - inset && y > inset && y < S - inset;
      if (!inner) { put(x, y, 11, 11, 13, 255); continue; }

      // red gradient field
      const t = (x + y) / (2 * S);
      put(x, y, Math.round(225 - 60 * t), Math.round(29 - 16 * t), Math.round(46 - 14 * t), 255);
    }
  }

  // "N" mark: two verticals + a diagonal, drawn as thick segments.
  const stroke = Math.max(4, Math.round(S * 0.075));
  const x0 = S * 0.28;
  const x1 = S * 0.72;
  const yTop = S * 0.30;
  const yBot = S * 0.72;

  const seg = (ax, ay, bx, by, r, g, b, w) => {
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const cx = Math.round(ax + (bx - ax) * t);
      const cy = Math.round(ay + (by - ay) * t);
      for (let dy = -w; dy <= w; dy += 1) {
        for (let dx = -w; dx <= w; dx += 1) {
          if (dx * dx + dy * dy <= w * w) put(cx + dx, cy + dy, r, g, b, 255);
        }
      }
    }
  };

  const w = Math.floor(stroke / 2);
  seg(x0, yTop, x0, yBot, 255, 255, 255, w);
  seg(x1, yTop, x1, yBot, 255, 255, 255, w);
  seg(x0, yTop, x1, yBot, 255, 255, 255, w);

  // pulse underline
  seg(S * 0.24, S * 0.82, S * 0.76, S * 0.82, 11, 11, 13, Math.max(1, Math.floor(w * 0.5)));

  return encodePng(S, S, px);
}

const outDir = path.join(__dirname, '..', 'src', 'public', 'assets');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, makeIcon(size));
  console.log(`[icons] wrote ${path.relative(process.cwd(), file)}`);
}
