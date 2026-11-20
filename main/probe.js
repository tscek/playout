'use strict';
// Branje velikosti slike ali videa iz glave datoteke (brez zunanjih programov).
// Podprto: PNG, JPEG, GIF, BMP, WebP, TIFF, MP4/MOV/M4V, MKV/WebM. Sicer vrne null.

const fs = require('fs');

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function imageSize(b) {
  if (b.length < 30) return null;
  // PNG
  if (b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  // GIF
  if (b.toString('ascii', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  // BMP
  if (b.toString('ascii', 0, 2) === 'BM') return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
  // WebP
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const v = b.readUInt32LE(21);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  // JPEG: poiščemo oznako SOFn
  if (b[0] === 0xff && b[1] === 0xd8) {
    let off = 2;
    while (off + 9 < b.length) {
      if (b[off] !== 0xff) { off++; continue; }
      const marker = b[off + 1];
      const len = b.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: b.readUInt16BE(off + 7), height: b.readUInt16BE(off + 5) };
      }
      off += 2 + len;
    }
    return null;
  }
  // TIFF
  const tiffLE = b.toString('ascii', 0, 2) === 'II';
  if ((tiffLE || b.toString('ascii', 0, 2) === 'MM') && b.length > 16) {
    const r16 = (o) => (tiffLE ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const r32 = (o) => (tiffLE ? b.readUInt32LE(o) : b.readUInt32BE(o));
    let ifd = r32(4);
    if (ifd + 2 > b.length) return null;
    const n = r16(ifd);
    let w = 0;
    let h = 0;
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > b.length) break;
      const tag = r16(e);
      const type = r16(e + 2);
      const val = type === 3 ? r16(e + 8) : r32(e + 8);
      if (tag === 256) w = val;
      if (tag === 257) h = val;
    }
    return w && h ? { width: w, height: h } : null;
  }
  return null;
}

/** MP4/MOV: poišče tkhd video sledi (širina/višina v 16.16). */
function mp4Size(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const read = (pos, len) => {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, pos);
    return buf.subarray(0, n);
  };
  let best = null;
  const walk = (start, end, depth) => {
    let pos = start;
    while (pos + 8 <= end && depth < 6) {
      const h = read(pos, 16);
      if (h.length < 8) return;
      let len = h.readUInt32BE(0);
      const type = h.toString('ascii', 4, 8);
      let hdr = 8;
      if (len === 1) {
        len = Number(h.readBigUInt64BE(8));
        hdr = 16;
      } else if (len === 0) len = end - pos;
      if (len < hdr) return;
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
        walk(pos + hdr, Math.min(end, pos + len), depth + 1);
      } else if (type === 'tkhd') {
        const body = read(pos + hdr, Math.min(len - hdr, 100));
        const version = body[0];
        const off = version === 1 ? 88 : 76;
        if (body.length >= off + 8) {
          const w = body.readUInt32BE(off) / 65536;
          const hh = body.readUInt32BE(off + 4) / 65536;
          if (w > 0 && hh > 0 && (!best || w * hh > best.width * best.height)) best = { width: Math.round(w), height: Math.round(hh) };
        }
      }
      pos += len;
    }
  };
  try {
    walk(0, size, 0);
  } finally {
    fs.closeSync(fd);
  }
  return best;
}

/** MKV/WebM: PixelWidth (0xB0) in PixelHeight (0xBA) v prvih 2 MB. */
function mkvSize(b) {
  if (b.readUInt32BE(0) !== 0x1a45dfa3) return null;
  const find = (id) => {
    for (let i = 0; i < b.length - 3; i++) {
      if (b[i] !== id) continue;
      const sz = b[i + 1];
      // dolžina zapisa 1 bajt (0x81..0x88)
      if (sz >= 0x81 && sz <= 0x84) {
        const n = sz - 0x80;
        if (i + 2 + n > b.length) continue;
        const v = b.readUIntBE(i + 2, n);
        // video sled ima Video (0xE0) element nekje pred tem
        if (v > 15 && v < 20000) return v;
      }
    }
    return 0;
  };
  const w = find(0xb0);
  const h = find(0xba);
  return w && h ? { width: w, height: h } : null;
}

/** Vrne { width, height } ali null, če velikosti ni mogoče prebrati. */
function probeSize(file, type) {
  try {
    const head = readHead(file, type === 'image' ? 256 * 1024 : 2 * 1024 * 1024);
    if (type === 'image') return imageSize(head);
    if (head.length >= 12 && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(head.toString('ascii', 4, 8))) return mp4Size(file);
    return mkvSize(head);
  } catch {
    return null;
  }
}

module.exports = { probeSize, imageSize };
