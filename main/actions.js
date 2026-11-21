'use strict';
// Shranjene akcije: zaporedje korakov (ATEM, XR18, HTTP, OSC, čakanje),
// ki jih sprožiš z gumbom ali jih pripneš na začetek/konec vnosa v playlisti.

const dgram = require('dgram');
const { EventEmitter } = require('events');
const { readJson, writeJson } = require('./store');
const { newId } = require('./media');
const { encodeMessage } = require('./engine/osc');
const { AtemDevice } = require('./devices/atem');
const { Xr18Device } = require('./devices/xr18');
const { PtzDevice } = require('./devices/ptz');
const { buildPresets, presetStep, cacheFromInfo } = require('./presets');

const DEVICE_TYPES = { atem: AtemDevice, xr18: Xr18Device, ptz: PtzDevice };
const STEP_TYPES = ['atem', 'xr18', 'ptz', 'http', 'osc', 'wait', 'title', 'preset'];

function cleanStr(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function normDevice(d) {
  const out = { id: d.id || newId(), type: DEVICE_TYPES[d.type] ? d.type : 'atem', name: cleanStr(d.name, 60) || 'Naprava', host: cleanStr(d.host, 100) };
  // Zadnja znana imena vhodov/kanalov (za presete, ko naprava ni povezana).
  if (d.cache && typeof d.cache === 'object' && JSON.stringify(d.cache).length < 20000) out.cache = d.cache;
  return out;
}

function normStep(s) {
  const type = STEP_TYPES.includes(s.type) ? s.type : 'wait';
  const out = { type };
  for (const k of ['deviceId', 'cmd', 'target', 'url', 'method', 'body', 'host', 'address', 'args', 'name']) {
    if (typeof s[k] === 'string') out[k] = s[k].slice(0, 2000);
  }
  for (const k of ['input', 'me', 'aux', 'macro', 'num', 'db', 'group', 'ms', 'port', 'cam']) {
    if (s[k] !== undefined && s[k] !== '' && Number.isFinite(Number(s[k]))) out[k] = Number(s[k]);
  }
  return out;
}

function normAction(a) {
  return {
    id: a.id || newId(),
    name: cleanStr(a.name, 60) || 'Akcija',
    showButton: a.showButton !== false,
    autoName: !!a.autoName, // ime = ime preseta (sledi imenu v napravi)
    steps: (Array.isArray(a.steps) ? a.steps : []).slice(0, 50).map(normStep),
  };
}

/** Argumenti za splošen OSC ukaz: "1 0.5 besedilo" -> i, f, s. */
function parseOscArgs(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).map((t) => {
    if (/^-?\d+$/.test(t)) return { type: 'i', value: parseInt(t, 10) };
    if (/^-?\d*\.\d+$/.test(t)) return { type: 'f', value: parseFloat(t) };
    return { type: 's', value: t.replace(/^"|"$/g, '') };
  });
}

class ActionManager extends EventEmitter {
  constructor({ file, log = () => {}, deviceIo = {} }) {
    super();
    this.file = file;
    this.deviceIo = deviceIo; // za teste: navidezna serijska vrata
    this.log = log;
    const data = readJson(file, {});
    this.devices = (Array.isArray(data.devices) ? data.devices : []).map(normDevice);
    this.actions = (Array.isArray(data.actions) ? data.actions : []).map(normAction);
    this.conns = new Map(); // id -> AtemDevice/Xr18Device
    this.running = new Set();
    this.lastResult = {}; // actionId -> { ok, error, at }
    this._udp = null;
  }

  start() {
    for (const d of this.devices) if (!this.conns.has(d.id)) this._connect(d);
  }

  async stop() {
    for (const c of this.conns.values()) await c.stop();
    this.conns.clear();
    if (this._udp) this._udp.close();
    this._udp = null;
  }

  _connect(d) {
    const Cls = DEVICE_TYPES[d.type];
    const c = new Cls(d, this.deviceIo);
    c.on('log', (l) => this.log(l));
    c.on('status', () => this.emit('changed'));
    c.on('names', () => this._updateCache(d.id));
    c.on('live', () => this.emit('live', d.id, c.live()));
    this.conns.set(d.id, c);
    try {
      c.start();
    } catch (e) {
      this.log(`Naprava ${d.name}: ${e.message}`);
    }
  }

  /** Naprava je sporočila (nova) imena: shrani jih in osveži presete. */
  _updateCache(id) {
    const d = this.devices.find((x) => x.id === id);
    const c = this.conns.get(id);
    if (!d || !c || !c.connected) return;
    const cache = cacheFromInfo(d.type, c.info());
    if (JSON.stringify(cache) === JSON.stringify(d.cache || null)) return;
    d.cache = cache;
    this._save();
  }

  /** Preseti iz vseh naprav (imena sproti iz naprave, sicer zadnja znana). */
  presets() {
    return buildPresets(this.devices, (d) => {
      const c = this.conns.get(d.id);
      return c && c.connected ? cacheFromInfo(d.type, c.info()) : d.cache || {};
    });
  }

  presetLabel(pid) {
    const p = this.presets().find((x) => x.id === pid);
    if (!p) return pid;
    const dev = this.devices.find((d) => pid.startsWith(`${d.id}.`));
    return `${dev ? dev.name : ''}: ${p.label}`;
  }

  /** Izvede preset (en ukaz). */
  async runPreset(pid, why = '') {
    const step = presetStep(pid, this.devices);
    if (!step) throw new Error('Preset ne obstaja (naprava je bila morda odstranjena)');
    const key = `preset:${pid}`;
    const label = this.presetLabel(pid);
    this.running.add(key);
    this.emit('changed');
    this.log(`Preset "${label}"${why ? ` (${why})` : ''}`);
    let error = '';
    try {
      await this._runStep(step);
    } catch (e) {
      error = e.message;
      this.log(`Preset "${label}": ${error}`);
    }
    this.running.delete(key);
    this.lastResult[key] = { ok: !error, error, at: Date.now() };
    this.emit('changed');
    if (error) throw new Error(`${label}: ${error}`);
  }

  /** Premik PTZ kamere iz vmesnika (ponavlja se, dokler držiš joystick). */
  ptzMove(deviceId, cam, pan, tilt, zoom) {
    const c = this.conns.get(deviceId);
    if (!c || typeof c.move !== 'function') throw new Error('PTZ kontroler ni nastavljen');
    c.move(cam, pan, tilt, zoom);
  }

  /** Ukaz neposredno napravi (plošča ATEM ali PTZ v vmesniku). */
  async deviceRun(deviceId, step) {
    const d = this.devices.find((x) => x.id === deviceId);
    if (!d) throw new Error('Naprava ne obstaja');
    const s = normStep({ ...step, type: d.type, deviceId });
    await this._runStep(s);
  }

  _save() {
    writeJson(this.file, { devices: this.devices, actions: this.actions });
    this.emit('changed');
  }

  getState() {
    return {
      devices: this.devices.map(({ cache, ...d }) => {
        const c = this.conns.get(d.id);
        return { ...d, ...(c ? c.info() : { connected: false }) };
      }),
      actions: this.actions.map((a) => ({ ...a, running: this.running.has(a.id), last: this.lastResult[a.id] || null })),
      presets: this.presets().map(({ step, ...p }) => ({
        ...p, running: this.running.has(`preset:${p.id}`), last: this.lastResult[`preset:${p.id}`] || null,
      })),
    };
  }

  // ---------- naprave ----------

  async saveDevice(dev) {
    const d = normDevice(dev || {});
    const i = this.devices.findIndex((x) => x.id === d.id);
    if (i !== -1 && !d.cache && this.devices[i].cache && this.devices[i].type === d.type) d.cache = this.devices[i].cache;
    if (i === -1) this.devices.push(d);
    else this.devices[i] = d;
    const old = this.conns.get(d.id);
    if (old) await old.stop();
    this.conns.delete(d.id);
    this._connect(d);
    this._save();
    return d.id;
  }

  async removeDevice(id) {
    const c = this.conns.get(id);
    if (c) await c.stop();
    this.conns.delete(id);
    this.devices = this.devices.filter((d) => d.id !== id);
    this._save();
  }

  // ---------- akcije ----------

  saveAction(action) {
    const a = normAction(action || {});
    const i = this.actions.findIndex((x) => x.id === a.id);
    if (i === -1) this.actions.push(a);
    else this.actions[i] = a;
    this._save();
    return a.id;
  }

  removeAction(id) {
    this.actions = this.actions.filter((a) => a.id !== id);
    this._save();
  }

  moveAction(id, index) {
    const from = this.actions.findIndex((a) => a.id === id);
    if (from === -1) return;
    const [a] = this.actions.splice(from, 1);
    this.actions.splice(Math.max(0, Math.min(this.actions.length, index)), 0, a);
    this._save();
  }

  /** Izvede akcijo. Napake ne ustavijo programa; zapišejo se v dnevnik in pokažejo pri gumbu. */
  async run(id, why = '') {
    if (String(id).startsWith('preset:')) return this.runPreset(String(id).slice(7), why);
    const a = this.actions.find((x) => x.id === id);
    if (!a) throw new Error('Akcija ne obstaja');
    this.running.add(id);
    this.emit('changed');
    this.log(`Akcija "${a.name}"${why ? ` (${why})` : ''}`);
    let error = '';
    for (const step of a.steps) {
      try {
        await this._runStep(step);
      } catch (e) {
        error = e.message;
        this.log(`Akcija "${a.name}": ${e.message}`);
        break;
      }
    }
    this.running.delete(id);
    this.lastResult[id] = { ok: !error, error, at: Date.now() };
    this.emit('changed');
    if (error) throw new Error(`Akcija "${a.name}": ${error}`);
  }

  async _runStep(step) {
    switch (step.type) {
      case 'wait':
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(60000, step.ms || 0))));
        return;
      case 'atem':
      case 'xr18':
      case 'ptz': {
        const c = this.conns.get(step.deviceId);
        if (!c) throw new Error('Naprava ni nastavljena');
        await c.run(step);
        return;
      }
      case 'http': {
        if (!/^https?:\/\//i.test(step.url || '')) throw new Error('Neveljaven naslov URL');
        const method = (step.method || 'GET').toUpperCase();
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        try {
          const res = await fetch(step.url, {
            method,
            body: method === 'GET' ? undefined : step.body || undefined,
            headers: step.body && /^\s*[{[]/.test(step.body) ? { 'Content-Type': 'application/json' } : undefined,
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (e) {
          throw new Error(e.name === 'AbortError' ? 'HTTP: ni odgovora v 5 s' : `HTTP: ${e.message}`);
        } finally {
          clearTimeout(t);
        }
        return;
      }
      case 'osc': {
        if (!step.host || !step.port || !step.address) throw new Error('OSC: manjka naslov, vrata ali ukaz');
        if (!this._udp) {
          this._udp = dgram.createSocket('udp4');
          this._udp.on('error', (e) => this.log(`OSC: ${e.message}`));
        }
        const buf = encodeMessage(step.address, parseOscArgs(step.args));
        await new Promise((res, rej) => this._udp.send(buf, step.port, step.host, (e) => (e ? rej(e) : res())));
        return;
      }
      case 'preset': {
        const inner = presetStep(step.target, this.devices);
        if (!inner) throw new Error('Preset ne obstaja (naprava je bila morda odstranjena)');
        await this._runStep(inner);
        return;
      }
      case 'title':
        if (!this.local) throw new Error('Napisi niso na voljo');
        await this.local(step);
        return;
      default:
        throw new Error(`Neznan korak: ${step.type}`);
    }
  }
}

module.exports = { ActionManager, parseOscArgs, normAction };
