'use strict';
// Navidezni PTZ kontroler (ESP32) po protokolu docs/PTZ_USB_PROTOCOL.md, za teste brez strojne opreme.

const { EventEmitter } = require('events');

class FakePtzPort extends EventEmitter {
  constructor() {
    super();
    this.sel = 1;
    this.lock = false;
    this.cams = [
      { i: 0, name: 'Gimbal', type: 'gimbal', enabled: true, connected: true, pgm: false, pvw: false, moving: false, status: 'povezan' },
      { i: 1, name: 'JVC', type: 'jvc', enabled: true, connected: true, pgm: true, pvw: false, moving: false, status: 'povezana (JVC API)' },
      { i: 2, name: 'AIDA', type: 'visca', enabled: true, connected: true, pgm: false, pvw: true, moving: false, status: 'povezana (VISCA)' },
      { i: 3, name: 'Lumix', type: 'lumix', enabled: false, connected: false, pgm: false, pvw: false, moving: false, status: 'izklopljena' },
    ];
    this.presets = {
      0: [{ n: 1, name: 'Oder', stored: true }],
      1: [{ n: 1, name: 'Govornik', stored: true }, { n: 2, name: 'Totala', stored: true }, { n: 5, name: '', stored: true }],
      2: [{ n: 3, name: 'Publika', stored: true }],
    };
    this.received = [];
    this.closed = false;
    setTimeout(() => this._out('ESP-ROM:esp32s3-20210327 (boot text)\r\n{partial'), 5);
  }

  _out(s) {
    if (!this.closed) this.emit('data', Buffer.from(s));
  }

  _send(o) {
    this._out(`${JSON.stringify(o)}\n`);
  }

  _state(id) {
    const o = { t: 'state', sel: this.sel, lock: this.lock, joystick_override: false, atem: true, cams: this.cams };
    if (id !== undefined) o.id = id;
    this._send(o);
  }

  write(line) {
    const m = JSON.parse(String(line).trim());
    this.received.push(m);
    const ack = (ok = true, err) => this._send(ok ? { t: 'ack', id: m.id, ok: true } : { t: 'ack', id: m.id, ok: false, err });
    setTimeout(() => {
      switch (m.cmd) {
        case 'hello':
          this._send({ t: 'hello', id: m.id, ok: true, proto: 1, fw: 'PTZ_Controller_S3 test', cams: this.cams.map(({ i, name, type, enabled }) => ({ i, name, type, enabled })) });
          break;
        case 'get_state':
          this._state(m.id);
          break;
        case 'get_presets': {
          const list = [];
          for (let n = 1; n <= 50; n++) list.push((this.presets[m.cam] || []).find((p) => p.n === n) || { n, name: '', stored: false });
          this._send({ t: 'presets', id: m.id, cam: m.cam, list });
          break;
        }
        case 'select':
          this.sel = m.cam;
          ack();
          this._state();
          break;
        case 'move': {
          const nonzero = m.pan || m.tilt || m.zoom;
          const cam = m.cam !== undefined ? m.cam : this.sel;
          if (nonzero && this.lock) ack(false, 'lock');
          else if (nonzero && this.cams.find((c) => c.i === cam).pgm) ack(false, 'pgm');
          else ack();
          break;
        }
        case 'stop':
          ack();
          break;
        case 'lock':
          this.lock = !!m.on;
          ack();
          this._state();
          break;
        case 'preset_recall':
          if (this.lock) ack(false, 'lock');
          else ack();
          break;
        case 'preset_store': {
          const cam = m.cam !== undefined ? m.cam : this.sel;
          const list = this.presets[cam] || (this.presets[cam] = []);
          const ex = list.find((p) => p.n === m.n);
          if (ex) Object.assign(ex, { name: m.name || ex.name, stored: true });
          else list.push({ n: m.n, name: m.name || '', stored: true });
          list.sort((a, b) => a.n - b.n);
          ack();
          break;
        }
        default:
          this._send({ t: 'ack', id: m.id, ok: false, err: 'unknown_cmd' });
      }
    }, 2);
  }

  close(cb) {
    this.closed = true;
    this.emit('close');
    if (cb) cb();
  }
}

/** io za PtzDevice / ActionManager({ deviceIo }). */
function fakePtzIo() {
  const io = {
    ports: [],
    list: async () => [{ path: 'COM7', vendorId: '303A', friendlyName: 'USB JTAG/serial debug unit' }],
    open: async (path) => {
      const p = new FakePtzPort();
      p.path = path;
      io.ports.push(p);
      return p;
    },
  };
  return io;
}

module.exports = { FakePtzPort, fakePtzIo };
