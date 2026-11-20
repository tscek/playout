'use strict';
// Monitorji v vmesniku (PREVIEW in PROGRAM).
//
// CasparCG za vsak kanal pošilja pomanjšano sliko kot zaporedje JPEG slik
// (MJPEG) na naš lokalni TCP strežnik. Zadnjo sliko pošljemo vsem
// odprtim vmesnikom kot "multipart" tok, ki ga brskalnik prikaže v <img>.
// Monitor je samo za ogled: če zaostaja ali pade, to ne vpliva na izhod.

const net = require('net');
const { EventEmitter } = require('events');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const BOUNDARY = 'playoutframe';

class ChannelMonitor extends EventEmitter {
  constructor(channel) {
    super();
    this.channel = channel;
    this.port = 0;
    this.server = null;
    this.latest = null;
    this.lastFrameAt = 0;
    this.connected = false;
    this.viewers = new Set();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((sock) => this._onEngine(sock));
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  _onEngine(sock) {
    this.connected = true;
    this.emit('connected');
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const start = buf.indexOf(SOI);
        if (start === -1) {
          buf = Buffer.alloc(0);
          break;
        }
        const end = buf.indexOf(EOI, start + 2);
        if (end === -1) {
          if (start > 0) buf = buf.subarray(start);
          if (buf.length > 8 * 1024 * 1024) buf = Buffer.alloc(0); // varovalka
          break;
        }
        const jpg = Buffer.from(buf.subarray(start, end + 2));
        buf = buf.subarray(end + 2);
        this._onFrame(jpg);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      this.connected = false;
      this.emit('disconnected');
    });
  }

  _onFrame(jpg) {
    this.latest = jpg;
    this.lastFrameAt = Date.now();
    for (const v of this.viewers) this._sendTo(v, jpg);
  }

  _sendTo(viewer, jpg) {
    // Počasnemu gledalcu (npr. tablica na slabem WiFi) slike preskočimo.
    if (viewer.res.writableLength > 256 * 1024) return;
    const now = Date.now();
    if (viewer.minInterval && now - viewer.lastSent < viewer.minInterval) return;
    viewer.lastSent = now;
    viewer.res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`);
    viewer.res.write(jpg);
    viewer.res.write('\r\n');
  }

  /** HTTP: /monitor/<kanal>.mjpg?fps=10 */
  serve(req, res, fps) {
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    const viewer = { res, lastSent: 0, minInterval: fps > 0 ? 1000 / fps : 0 };
    this.viewers.add(viewer);
    if (this.latest) this._sendTo(viewer, this.latest);
    const done = () => this.viewers.delete(viewer);
    req.on('close', done);
    res.on('error', done);
  }

  /** Ukaz AMCP, ki v kanalu doda pošiljanje slike na naš strežnik. */
  addCommand(consumerIndex, { width = 640, height = 360 } = {}) {
    return (
      `ADD ${this.channel}-${consumerIndex} STREAM tcp://127.0.0.1:${this.port} ` +
      `-format mjpeg -codec:v mjpeg -filter:v scale=${width}:${height}:out_range=full,format=yuvj420p -b:v 3000000`
    );
  }
}

module.exports = { ChannelMonitor };
