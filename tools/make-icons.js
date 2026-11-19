// アイコン生成: node tools/make-icons.js
const fs = require('fs'), zlib = require('zlib');
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(n) {
  const raw = Buffer.alloc((n * 4 + 1) * n);
  const inRR = (x, y, x0, y0, x1, y1, r) => { if (x < x0 || x > x1 || y < y0 || y > y1) return false; const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; };
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0;
    for (let x = 0; x < n; x++) {
      const u = (x + .5) / n, v = (y + .5) / n, o = y * (n * 4 + 1) + 1 + x * 4;
      let px = [0, 0, 0, 0];
      if (inRR(u, v, 0.04, 0.04, 0.96, 0.96, 0.22)) px = [37, 99, 235, 255];
      if (inRR(u, v, 0.18, 0.26, 0.82, 0.74, 0.06)) px = [255, 255, 255, 255];
      if (inRR(u, v, 0.5, 0.46, 0.76, 0.68, 0.04)) px = [37, 99, 235, 255];
      raw.set(px, o);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const n of [16, 48, 128]) fs.writeFileSync(`${__dirname}/../icons/icon${n}.png`, png(n));
