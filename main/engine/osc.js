'use strict';
// Sprejem OSC sporočil iz CasparCG (UDP). Iz njih beremo čas posnetkov
// (koliko je preteklo in koliko je dolg).

const dgram = require('dgram');
const { EventEmitter } = require('events');

function readString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.toString('utf8', off, end);
  const next = (end + 4) & ~3; // poravnava na 4 bajte (vključno z ničlo)
  return [str, next];
}

/** Razčleni OSC paket (sporočilo ali "bundle") v seznam { address, args }. */
function parsePacket(buf, out = []) {
  if (buf.length < 4) return out;
  const [head, afterHead] = readString(buf, 0);
  if (head === '#bundle') {
    let off = afterHead + 8; // časovna oznaka
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off);
      off += 4;
      if (size <= 0 || off + size > buf.length) break;
      parsePacket(buf.subarray(off, off + size), out);
      off += size;
    }
    return out;
  }
  const address = head;
  let off = afterHead;
  if (off >= buf.length) {
    out.push({ address, args: [] });
    return out;
  }
  const [tags, afterTags] = readString(buf, off);
  off = afterTags;
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === 'i') { args.push(buf.readInt32BE(off)); off += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(off)); off += 4; }
    else if (t === 'h') { args.push(Number(buf.readBigInt64BE(off))); off += 8; }
    else if (t === 'd') { args.push(buf.readDoubleBE(off)); off += 8; }
    else if (t === 's') { const [s, n] = readString(buf, off); args.push(s); off = n; }
    else if (t === 'T') args.push(true);
    else if (t === 'F') args.push(false);
    else if (t === 'N') args.push(null);
    else if (t === 'b') { const len = buf.readInt32BE(off); off += 4 + ((len + 3) & ~3); args.push(null); }
    else break; // neznan tip: ostanek preskočimo
    if (off > buf.length) break;
  }
  out.push({ address, args });
  return out;
}

class OscListener extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    this.socket = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      s.on('message', (msg) => {
        let list;
        try {
          list = parsePacket(msg);
        } catch {
          return;
        }
        for (const m of list) this.emit('message', m);
      });
      s.once('error', reject);
      s.bind(this.port, '127.0.0.1', () => {
        this.socket = s;
        this.port = s.address().port;
        s.removeListener('error', reject);
        s.on('error', () => {});
        resolve(this.port);
      });
    });
  }

  stop() {
    if (this.socket) this.socket.close();
    this.socket = null;
  }
}

/** Sestavi OSC sporočilo. args: števila (cela -> i, sicer f), nizi (s) ali { type, value }. */
function encodeMessage(address, args = []) {
  const pad = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4 || 0)]);
  const str = (s) => {
    const b = Buffer.from(String(s) + '\0', 'utf8');
    return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  };
  let tags = ',';
  const parts = [];
  for (const a of args) {
    const { type, value } = typeof a === 'object' && a !== null ? a : { type: typeof a === 'string' ? 's' : Number.isInteger(a) ? 'i' : 'f', value: a };
    tags += type;
    if (type === 'i') { const b = Buffer.alloc(4); b.writeInt32BE(Math.round(value)); parts.push(b); }
    else if (type === 'f') { const b = Buffer.alloc(4); b.writeFloatBE(Number(value)); parts.push(b); }
    else if (type === 's') parts.push(str(value));
  }
  return pad(Buffer.concat([str(address), str(tags), ...parts]));
}

module.exports = { encodeMessage, OscListener, parsePacket };
