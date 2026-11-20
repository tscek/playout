'use strict';
// AMCP odjemalec za CasparCG Server (TCP, privzeto vrata 5250).
//
// AMCP odgovarja na ukaze po vrsti, zato ukaze pošiljamo v vrsti in
// vsak odgovor priredimo najstarejšemu čakajočemu ukazu.
//   2xx = uspeh (200 = več vrstic do prazne vrstice, 201 = ena vrstica podatkov, 202 = brez podatkov)
//   4xx/5xx = napaka

const net = require('net');
const { EventEmitter } = require('events');

const COMMAND_TIMEOUT_MS = 5000;

class AmcpError extends Error {
  constructor(code, line, command) {
    super(`AMCP ${code}: ${line} (ukaz: ${command})`);
    this.code = code;
    this.command = command;
  }
}

class AmcpClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 5250 } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.socket = null;
    this.connected = false;
    this.buffer = '';
    this.pending = []; // { command, resolve, reject, timer }
    this.current = null; // odgovor, ki se še bere: { code, head, lines, mode }
    this._shouldRun = false;
    this._retryTimer = null;
  }

  start() {
    this._shouldRun = true;
    this._connect();
  }

  stop() {
    this._shouldRun = false;
    clearTimeout(this._retryTimer);
    if (this.socket) this.socket.destroy();
    this.socket = null;
  }

  _connect() {
    if (!this._shouldRun) return;
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 2000);

    socket.on('connect', () => {
      this.connected = true;
      this.buffer = '';
      this.current = null;
      this.emit('connected');
    });
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => { /* obravnavano v 'close' */ });
    socket.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this._failAll(new Error('Povezava z motorjem prekinjena'));
      if (wasConnected) this.emit('disconnected');
      if (this._shouldRun) {
        this._retryTimer = setTimeout(() => this._connect(), 500);
      }
    });
  }

  _failAll(err) {
    const all = this.pending;
    this.pending = [];
    for (const p of all) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  /** Pošlje ukaz in vrne obljubo z { code, head, data }. */
  send(command) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        reject(new Error('Motor ni povezan'));
        return;
      }
      const entry = { command, resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        // Ukaz brez odgovora: povezava ni več zanesljiva, začnemo znova.
        reject(new Error(`Ni odgovora na ukaz: ${command}`));
        const idx = this.pending.indexOf(entry);
        if (idx !== -1) this.pending.splice(idx, 1);
        if (this.socket) this.socket.destroy();
      }, COMMAND_TIMEOUT_MS);
      this.pending.push(entry);
      this.emit('sent', command);
      this.socket.write(command + '\r\n');
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this._onLine(line);
    }
  }

  _onLine(line) {
    if (this.current) {
      const cur = this.current;
      if (cur.mode === 'single') {
        cur.lines.push(line);
        this._finish();
      } else if (cur.mode === 'multi') {
        if (line === '') this._finish();
        else cur.lines.push(line);
      }
      return;
    }

    const m = /^(\d{3})\s?(.*)$/.exec(line);
    if (!m) return; // neznana vrstica, prezremo
    const code = parseInt(m[1], 10);
    const head = m[2];
    if (code === 200) {
      this.current = { code, head, lines: [], mode: 'multi' };
    } else if (code === 201) {
      this.current = { code, head, lines: [], mode: 'single' };
    } else {
      this.current = { code, head, lines: [], mode: 'none' };
      this._finish();
    }
  }

  _finish() {
    const res = this.current;
    this.current = null;
    const entry = this.pending.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    if (res.code >= 400) {
      entry.reject(new AmcpError(res.code, res.head, entry.command));
    } else {
      entry.resolve({ code: res.code, head: res.head, data: res.lines });
    }
  }
}

/** Pripravi niz za AMCP: v narekovajih, z ubežnimi znaki. */
function quote(str) {
  return '"' + String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Pot za CasparCG: poševnice naprej delujejo tudi na Windows. */
function mediaPath(p) {
  return String(p).replace(/\\/g, '/');
}

module.exports = { AmcpClient, AmcpError, quote, mediaPath };
