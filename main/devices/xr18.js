'use strict';
// Behringer XR18 / X-Air (OSC prek UDP, vrata 10024).
// Mute, mute skupine in fader za kanale, buse, glavni izhod LR in DCA.

const dgram = require('dgram');
const { EventEmitter } = require('events');
const { encodeMessage, parsePacket } = require('../engine/osc');

const PORT = 10024;

/** dB v položaj fader-ja X-Air (0..1), enaka krivulja kot na mizi. */
function dbToFader(db) {
  const d = Number(db);
  if (!Number.isFinite(d) || d <= -90) return 0;
  let f;
  if (d < -60) f = (d + 90) / 480;
  else if (d < -30) f = (d + 70) / 160;
  else if (d < -10) f = (d + 50) / 80;
  else f = (d + 30) / 40;
  return Math.max(0, Math.min(1, f));
}

/** Naslov OSC za cilj. target: 'ch' | 'bus' | 'lr' | 'dca' | 'rtn' (FX povratek). */
function basePath(target, num) {
  const n = Math.max(1, Math.round(Number(num) || 1));
  switch (target) {
    case 'ch': return `/ch/${String(n).padStart(2, '0')}/mix`;
    case 'bus': return `/bus/${n}/mix`;
    case 'lr': return '/lr/mix';
    case 'rtn': return `/rtn/${n}/mix`;
    case 'aux': return '/rtn/aux/mix';
    case 'dca': return `/dca/${n}`;
    default: throw new Error(`Neznan cilj na mešalni mizi: ${target}`);
  }
}

class Xr18Device extends EventEmitter {
  constructor({ id, name, host }) {
    super();
    this.id = id;
    this.name = name;
    this.host = host;
    this.socket = null;
    this.connected = false;
    this.model = '';
    this._lastReply = 0;
    this._poll = null;
  }

  start() {
    if (!this.host) return;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (e) => this.emit('log', `XR18 ${this.name}: ${e.message}`));
    this.socket.on('message', (buf) => {
      let msgs = [];
      try { msgs = parsePacket(buf); } catch { return; }
      this._lastReply = Date.now();
      for (const m of msgs) {
        if (m.address === '/xinfo' && m.args.length >= 3) this.model = `${m.args[2]} ${m.args[3] || ''}`.trim();
      }
      if (!this.connected) {
        this.connected = true;
        this.emit('log', `XR18 ${this.name}: povezan${this.model ? ` (${this.model})` : ''}`);
        this.emit('status');
      }
    });
    this.socket.bind(0, () => {
      const ping = () => {
        this._send('/xinfo');
        if (this.connected && Date.now() - this._lastReply > 7000) {
          this.connected = false;
          this.emit('log', `XR18 ${this.name}: ne odgovarja`);
          this.emit('status');
        }
      };
      ping();
      this._poll = setInterval(ping, 3000);
    });
  }

  async stop() {
    clearInterval(this._poll);
    if (this.socket) {
      try { this.socket.close(); } catch { /* ni pomembno */ }
    }
    this.socket = null;
    this.connected = false;
  }

  info() {
    return { connected: this.connected, model: this.model };
  }

  _send(address, args = []) {
    if (!this.socket) throw new Error(`Mešalna miza "${this.name}" nima vpisanega IP naslova`);
    const buf = encodeMessage(address, args);
    this.socket.send(buf, PORT, this.host);
  }

  /**
   * step: { cmd: 'mute' | 'unmute' | 'fader' | 'mutegroup' | 'unmutegroup', target, num, db, group }
   */
  async run(step) {
    if (!this.socket) throw new Error(`Mešalna miza "${this.name}" nima vpisanega IP naslova`);
    switch (step.cmd) {
      case 'mute':
      case 'unmute': {
        const base = basePath(step.target, step.num);
        this._send(`${base}/on`, [{ type: 'i', value: step.cmd === 'mute' ? 0 : 1 }]); // on = 0 pomeni utišano
        return;
      }
      case 'fader': {
        const base = basePath(step.target, step.num);
        this._send(`${base}/fader`, [{ type: 'f', value: dbToFader(step.db) }]);
        return;
      }
      case 'mutegroup':
      case 'unmutegroup': {
        const g = Math.max(1, Math.min(4, Math.round(Number(step.group) || 1)));
        this._send(`/config/mute/${g}`, [{ type: 'i', value: step.cmd === 'mutegroup' ? 1 : 0 }]);
        return;
      }
      default:
        throw new Error(`Neznan ukaz za XR18: ${step.cmd}`);
    }
  }
}

module.exports = { Xr18Device, dbToFader, basePath };
