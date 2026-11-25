'use strict';

/**
 * 生成 Windows 应用图标 build/icon.ico
 * 纯手写 PNG + ICO 编码，不依赖任何图形库。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */

class Canvas {
  constructor(size) {
    this.size = size;
    this.buf = Buffer.alloc(size * size * 4, 0);
  }

  blend(x, y, r, g, b, a) {
    if (a <= 0) return;
    const s = this.size;
    if (x < 0 || y < 0 || x >= s || y >= s) return;
    const i = (y * s + x) * 4;
    const dst = this.buf;
    const sa = a / 255;
    const da = dst[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) return;
    dst[i] = Math.round((r * sa + dst[i] * da * (1 - sa)) / outA);
    dst[i + 1] = Math.round((g * sa + dst[i + 1] * da * (1 - sa)) / outA);
    dst[i + 2] = Math.round((b * sa + dst[i + 2] * da * (1 - sa)) / outA);
    dst[i + 3] = Math.round(outA * 255);
  }

  /** 圆角矩形，带 3x3 超采样抗锯齿 */
  roundRect(x0, y0, w, h, radius, color, alpha = 1) {
    const [r, g, b] = color;
    const SS = 3;
    for (let py = Math.floor(y0); py < Math.ceil(y0 + h); py++) {
      for (let px = Math.floor(x0); px < Math.ceil(x0 + w); px++) {
        let hits = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const fx = px + (sx + 0.5) / SS;
            const fy = py + (sy + 0.5) / SS;
            if (inRound(fx, fy, x0, y0, w, h, radius)) hits++;
          }
        }
        if (hits) this.blend(px, py, r, g, b, Math.round((hits / (SS * SS)) * 255 * alpha));
      }
    }
  }
}

function inRound(x, y, x0, y0, w, h, r) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  if (x < x0 || y < y0 || x > x1 || y > y1) return false;
  const rr = Math.min(r, w / 2, h / 2);
  if (x >= x0 + rr && x <= x1 - rr) return true;
  if (y >= y0 + rr && y <= y1 - rr) return true;
  const cx = x < x0 + rr ? x0 + rr : x1 - rr;
  const cy = y < y0 + rr ? y0 + rr : y1 - rr;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= rr * rr;
}

function draw(size) {
  const c = new Canvas(size);
  const k = size / 256;

  // 背景：蓝色 → 紫色渐变圆角方形
  const x0 = Math.round(8 * k);
  const y0 = Math.round(8 * k);
  const w = size - x0 * 2;
  const h = size - y0 * 2;
  const r = Math.round(56 * k);
  const SS = 3;
  for (let py = y0 - 2; py < y0 + h + 2; py++) {
    for (let px = x0 - 2; px < x0 + w + 2; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = px + (sx + 0.5) / SS;
          const fy = py + (sy + 0.5) / SS;
          if (inRound(fx, fy, x0, y0, w, h, r)) hits++;
        }
      }
      if (!hits) continue;
      const t = ((px - x0) / w + (py - y0) / h) / 2;
      const rr = Math.round(37 + (124 - 37) * t);
      const gg = Math.round(99 + (58 - 99) * t);
      const bb = Math.round(235 + (237 - 235) * t);
      c.blend(px, py, rr, gg, bb, Math.round((hits / (SS * SS)) * 255));
    }
  }

  // 纸页
  const px0 = Math.round(66 * k);
  const py0 = Math.round(46 * k);
  const pw = Math.round(124 * k);
  const ph = Math.round(164 * k);
  c.roundRect(px0, py0, pw, ph, Math.round(14 * k), [255, 255, 255], 0.97);

  // 页眉色块（模拟标题行）
  c.roundRect(px0 + 20 * k, py0 + 26 * k, 62 * k, 14 * k, 7 * k, [37, 99, 235], 1);
  // 正文行
  const lineColors = [
    [203, 213, 225],
    [203, 213, 225],
    [203, 213, 225],
  ];
  lineColors.forEach((col, i) => {
    c.roundRect(px0 + 20 * k, py0 + (58 + i * 24) * k, (i === 2 ? 52 : 84) * k, 9 * k, 4.5 * k, col, 1);
  });
  // 底部强调条
  c.roundRect(px0 + 20 * k, py0 + 130 * k, 84 * k, 9 * k, 4.5 * k, [124, 58, 237], 1);

  return c.buf;
}

function encodeIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

function main() {
  const root = path.resolve(__dirname, '..');
  const outDir = path.join(root, 'build');
  fs.mkdirSync(outDir, { recursive: true });

  const size = 256;
  const rgba = draw(size);
  const png = encodePng(size, size, rgba);
  fs.writeFileSync(path.join(outDir, 'icon.png'), png);
  fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(png, size));
  console.log('[icon] build/icon.png + build/icon.ico (256x256)');
}

main();
