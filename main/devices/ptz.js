'use strict';
// PTZ kontroler (ESP32-S3, projekt PTZ_Controller_S3) prek USB: JSON vrstice, protokol v docs/PTZ_USB_PROTOCOL.md.
// Kontroler upravlja kamere (JVC, VISCA, gimbal, Lumix); mi pošiljamo izbiro kamere, premike, preseti, STOP.
// Varnost: premik pošiljamo vsakih 50 ms, dokler ga vmesnik obnavlja; če vmesnik utihne za 400 ms, ustavimo.

const { EventEmitter } = require('events');

const ESPRESSIF_VID = '303a';
const MOVE_EVERY_MS = 50;
const MOVE_STALE_MS = 400;
const REPLY_MS = 2500;

/** Privzeto odpiranje porta (knjižnica serialport). RTS ostane izklopljen, sicer se ESP32 ponovno zažene. */
async function openSerial(path) {
  const { SerialPort } = require('serialport');
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate: 115200, rtscts: false, hupcl: true, autoOpen: false });
    port.open((e) => {
      if (e) return reject(e);
      port.set({ rts: false, dtr: true }, () => resolve(port));
    });
  });
}

async function listSerial() {
  try {
    const { SerialPort } = require('serialport');
    return await SerialPort.list();
  } catch {
    return [];
  }
}

/**
 * Vrstica JSON. Ob odprtju porta je lahko pred sporočilom ostanek prejšnje vrstice
 * (npr. '{partial{"t":"hello",...}'), zato poskusimo še od zadnjega '{"t"' naprej.
 */
function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    const i = line.lastIndexOf('{"t"');
    if (i > 0) {
      try {
        return JSON.parse(line.slice(i));
      } catch { /* ni JSON */ }
    }
    return null;
  }
}

const ERR_TEXT = {
  pgm: 'kamera je na programu (zaščita v kontrolerju)',
  lock: 'STOP zaklep je vklopljen',
  bad_cam: 'kamera ne obstaja ali je izklopljena',
  bad_arg: 'napačen ukaz',
  unknown_cmd: 'kontroler ukaza ne pozna (stara programska oprema?)',
  joystick_active: 'v uporabi je fizični joystick',
};

class PtzDevice extends EventEmitter {
  /**
   * @param {{id, name, host}} d  host = COM vrata (npr. "COM5"); prazno = samodejno (prvi ESP32)
   * @param {{open?: Function, list?: Function}} io  za teste
   */
  constructor({ id, name, host }, io = {}) {
    super();
    this.id = id;
    this.name = name;
    this.host = host;
    this.open = io.open || openSerial;
    this.list = io.list || listSerial;
    this.port = null;
    this.portPath = '';
    this.connected = false;
    this.model = '';
    this.state = null; // zadnji "state" iz kontrolerja
    this.cams = []; // iz "hello"
    this.presetsByCam = {}; // cam -> [{n, name, stored}]
    this.moveError = '';
    this._buf = '';
    this._nextId = 1;
    this._wait = new Map();
    this._mv = null;
    this._stopped = true;
  }

  start() {
    this._stopped = false;
    this._connect();
  }

  async stop() {
    this._stopped = true;
    clearTimeout(this._retry);
    clearInterval(this._mvTimer);
    this._mvTimer = null;
    if (this._mv) this._write({ cmd: 'move', pan: 0, tilt: 0, zoom: 0 });
    this._mv = null;
    const p = this.port;
    this.port = null;
    this._setConnected(false);
    if (p) await new Promise((r) => p.close(() => r()));
  }

  async _findPort() {
    const want = String(this.host || '').trim();
    if (want && want.toLowerCase() !== 'auto') return want;
    const ports = await this.list();
    const esp = ports.find((p) => String(p.vendorId || '').toLowerCase() === ESPRESSIF_VID);
    return esp ? esp.path : '';
  }

  async _connect() {
    if (this._stopped || this.port) return;
    let path = '';
    try {
      path = await this._findPort();
      if (!path) throw new Error('kontroler ni priklopljen (ni USB naprave ESP32)');
      const port = await this.open(path);
      if (this._stopped) {
        port.close(() => {});
        return;
      }
      this.port = port;
      this.portPath = path;
      this._buf = '';
      port.on('data', (d) => this._onData(d));
      port.on('close', () => this._onClose());
      port.on('error', (e) => this.emit('log', `PTZ ${this.name}: ${e.message}`));
      const hello = await this.request({ cmd: 'hello' });
      this.model = hello.fw || 'PTZ kontroler';
      this.cams = Array.isArray(hello.cams) ? hello.cams : [];
      this._setConnected(true);
      this.emit('log', `PTZ ${this.name}: povezan na ${path} (${this.model})`);
      await this.refresh();
    } catch (e) {
      if (this.port) {
        const p = this.port;
        this.port = null;
        p.close(() => {});
      }
      if (this._lastErr !== e.message) this.emit('log', `PTZ ${this.name}: ${e.message}${path ? ` (${path})` : ''}`);
      this._lastErr = e.message;
      this._setConnected(false);
      if (!this._stopped) this._retry = setTimeout(() => this._connect(), 3000);
    }
  }

  /** Stanje in imena presetov vseh kamer. */
  async refresh() {
    const st = await this.request({ cmd: 'get_state' });
    this._onState(st);
    for (const c of this.cams) {
      if (c.enabled === false || c.type === 'lumix') continue;
      try {
        this._onPresets(await this.request({ cmd: 'get_presets', cam: c.i }));
      } catch { /* kamera morda nima presetov */ }
    }
    this.emit('names');
  }

  _setConnected(on) {
    if (this.connected === on) return;
    this.connected = on;
    this._lastErr = on ? '' : this._lastErr;
    this.emit('status');
  }

  _onClose() {
    this.port = null;
    for (const [, w] of this._wait) w.reject(new Error('povezava s kontrolerjem prekinjena'));
    this._wait.clear();
    clearInterval(this._mvTimer);
    this._mvTimer = null;
    this._mv = null;
    if (this.connected) this.emit('log', `PTZ ${this.name}: povezava prekinjena`);
    this._setConnected(false);
    if (!this._stopped) this._retry = setTimeout(() => this._connect(), 2000);
  }

  _write(obj) {
    if (!this.port) return false;
    this.port.write(`${JSON.stringify(obj)}\n`);
    return true;
  }

  /** Ukaz z odgovorom (ack, state, presets, hello). */
  request(obj) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      if (!this._write({ ...obj, id })) {
        reject(new Error(`PTZ kontroler "${this.name}" ni povezan`));
        return;
      }
      const t = setTimeout(() => {
        this._wait.delete(id);
        reject(new Error('PTZ kontroler ne odgovori'));
      }, REPLY_MS);
      this._wait.set(id, {
        resolve: (m) => { clearTimeout(t); resolve(m); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
    });
  }

  _onData(d) {
    this._buf += d.toString('utf8');
    if (this._buf.length > 65536) this._buf = this._buf.slice(-8192);
    let i;
    while ((i = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, i).trim();
      this._buf = this._buf.slice(i + 1);
      if (!line.startsWith('{')) continue; // besedilo ob zagonu ESP32
      const m = parseLine(line);
      if (m) this._onMessage(m);
    }
  }

  _onMessage(m) {
    if (m.id !== undefined && m.id !== null) {
      if (String(m.id).startsWith('m')) {
        // odgovor na premik: pokažemo, zakaj kamera ne gre
        const err = m.ok === false ? ERR_TEXT[m.err] || m.msg || m.err : '';
        if (err !== this.moveError) {
          this.moveError = err;
          this.emit('live');
        }
        return;
      }
      const w = this._wait.get(m.id);
      if (w) {
        this._wait.delete(m.id);
        if (m.t === 'ack' && m.ok === false) w.reject(new Error(ERR_TEXT[m.err] ? `${ERR_TEXT[m.err]}${m.msg ? `: ${m.msg}` : ''}` : m.msg || m.err || 'napaka'));
        else w.resolve(m);
      }
      if (m.t === 'state') this._onState(m);
      if (m.t === 'presets') this._onPresets(m);
      return;
    }
    if (m.t === 'state') this._onState(m);
    else if (m.t === 'presets') {
      this._onPresets(m);
      this.emit('names');
    } else if (m.t === 'evt') {
      if (m.ev === 'watchdog_stop') this.emit('log', `PTZ ${this.name}: kamera ${m.cam} ustavljena (ni bilo ukazov)`);
      this.emit('live');
    } else if (m.t === 'log' && m.msg) this.emit('log', `PTZ ${this.name}: ${m.msg}`);
  }

  _onState(m) {
    const names = JSON.stringify((m.cams || []).map((c) => [c.i, c.name, c.enabled]));
    const before = JSON.stringify((this.state && this.state.cams || []).map((c) => [c.i, c.name, c.enabled]));
    this.state = m;
    if (Array.isArray(m.cams) && m.cams.length) {
      this.cams = m.cams.map((c) => ({ i: c.i, name: c.name, type: c.type, enabled: c.enabled !== false }));
    }
    if (names !== before) this.emit('names');
    this.emit('live');
  }

  _onPresets(m) {
    if (!m || !Array.isArray(m.list)) return;
    this.presetsByCam[m.cam] = m.list.filter((p) => p && (p.stored || p.name)).map((p) => ({ n: p.n, name: String(p.name || ''), stored: !!p.stored }));
  }

  // ---------- premikanje ----------

  /**
   * Premik iz vmesnika (joystick na zaslonu). Vrednosti -1..1. Vmesnik ga mora ponavljati vsaj na 300 ms,
   * sicer se kamera ustavi. Vse ničle = takoj ustavi.
   */
  move(cam, pan, tilt, zoom) {
    if (!this.connected) throw new Error(`PTZ kontroler "${this.name}" ni povezan`);
    const c = (v) => Math.max(-1, Math.min(1, Math.round((Number(v) || 0) * 1000) / 1000));
    const mv = { cam: Number.isInteger(cam) ? cam : undefined, pan: c(pan), tilt: c(tilt), zoom: c(zoom), at: Date.now() };
    if (!mv.pan && !mv.tilt && !mv.zoom) {
      this._mv = null;
      clearInterval(this._mvTimer);
      this._mvTimer = null;
      this._sendMove({ ...mv });
      return;
    }
    this._mv = mv;
    this._sendMove(mv);
    if (!this._mvTimer) {
      this._mvTimer = setInterval(() => {
        const m = this._mv;
        if (!m || Date.now() - m.at > MOVE_STALE_MS) {
          clearInterval(this._mvTimer);
          this._mvTimer = null;
          this._mv = null;
          this._sendMove({ pan: 0, tilt: 0, zoom: 0 });
          return;
        }
        this._sendMove(m);
      }, MOVE_EVERY_MS);
    }
  }

  _sendMove(m) {
    const o = { cmd: 'move', pan: m.pan, tilt: m.tilt, zoom: m.zoom, id: `m${this._nextId++}` };
    if (m.cam !== undefined) o.cam = m.cam;
    this._write(o);
  }

  // ---------- stanje za vmesnik ----------

  live() {
    if (!this.connected || !this.state) return null;
    const s = this.state;
    return {
      sel: s.sel,
      lock: !!s.lock,
      override: !!s.joystick_override,
      atem: !!s.atem,
      moveError: this.moveError,
      cams: (s.cams || []).map((c) => ({ i: c.i, connected: !!c.connected, pgm: !!c.pgm, pvw: !!c.pvw, moving: !!c.moving, status: c.status || '' })),
    };
  }

  info() {
    return {
      connected: this.connected,
      model: this.model,
      port: this.portPath,
      error: this.connected ? '' : this._lastErr || '',
      cams: this.cams,
      presets: this.presetsByCam,
      live: this.live(),
    };
  }

  /** step: { cmd: 'recall'|'store'|'select'|'stop'|'lock'|'unlock', cam, num, name } */
  async run(step) {
    if (!this.connected) throw new Error(`PTZ kontroler "${this.name}" ni povezan (preveri USB kabel)`);
    const cam = Number.isFinite(Number(step.cam)) && step.cam !== '' && step.cam !== undefined ? Number(step.cam) : undefined;
    const withCam = (o) => (cam === undefined ? o : { ...o, cam });
    switch (step.cmd) {
      case 'recall':
        await this.request(withCam({ cmd: 'preset_recall', n: Number(step.num) }));
        return;
      case 'store': {
        const o = withCam({ cmd: 'preset_store', n: Number(step.num), thumb: true });
        if (step.name) o.name = String(step.name).slice(0, 19);
        await this.request(o);
        if (cam !== undefined) this._onPresets(await this.request({ cmd: 'get_presets', cam }));
        this.emit('names');
        return;
      }
      case 'select':
        await this.request({ cmd: 'select', cam });
        return;
      case 'stop':
        this._mv = null;
        await this.request({ cmd: 'stop' });
        return;
      case 'lock':
      case 'unlock':
        await this.request({ cmd: 'lock', on: step.cmd === 'lock' });
        return;
      default:
        throw new Error(`Neznan PTZ ukaz: ${step.cmd}`);
    }
  }
}

module.exports = { PtzDevice, listSerial, parseLine, ESPRESSIF_VID };
