'use strict';
// Jedro aplikacije: stanje, nastavitve, knjižnica in ukazi.
// Ne ve nič o Electronu, zato ga lahko testiramo brez okna.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { readJson, writeJson } = require('./store');
const { makeItem } = require('./media');
const { quote, mediaPath } = require('./engine/amcp');
const { VIDEO_MODES } = require('./engine/caspar-config');
const { describeDisplay } = require('./engine/displays');

const PROGRAM_CHANNEL = 1;
const LAYER_MAIN = 10;

const DEFAULT_SETTINGS = {
  videoMode: '1080p5000',
  programOutput: 'auto', // 'auto' = prvi zaslon, ki ni glavni; 'test' = okno; sicer ime zaslona (npr. \\.\DISPLAY2)
  audioDevice: '', // '' = privzeta naprava sistema
  audioDelayFrames: 0, // + = zvok kasneje, - = slika kasneje
};

function fpsOf(videoMode) {
  const m = /^\d+[pi](\d{2})(\d{2})$/.exec(videoMode);
  if (!m) return 25;
  const fps = parseInt(m[1], 10) + parseInt(m[2], 10) / 100;
  return videoMode.includes('i') ? fps / 2 : fps;
}

class Controller extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./engine/engine').Engine} o.engine
   * @param {string} o.dataDir
   * @param {() => Promise<object[]>} o.listDisplays
   */
  constructor({ engine, dataDir, listDisplays, templateDir }) {
    super();
    this.engine = engine;
    this.dataDir = dataDir;
    this.listDisplaysFn = listDisplays;
    this.templateDir = templateDir;

    this.settingsFile = path.join(dataDir, 'settings.json');
    this.libraryFile = path.join(dataDir, 'library.json');

    const saved = readJson(this.settingsFile, {});
    if (!saved.settingsVersion && saved.programOutput === 'test') saved.programOutput = 'auto'; // v0.1.0 je imel privzeto testno okno
    this.settings = { ...DEFAULT_SETTINGS, ...saved, settingsVersion: 2 };
    this.library = readJson(this.libraryFile, { items: [] });
    this.displays = [];
    this.audioDevices = [];
    this.program = { item: null, startedAt: 0 }; // kaj je na programu
    this.lastError = '';
    this.displaysError = '';
    this.audioWarning = '';

    engine.on('status', () => this._changed());
    engine.on('audioDeviceFailed', ({ device, devices }) => {
      if (devices.length) this.engineAudioDevices = devices;
      this.audioWarning = `Zvočne naprave "${device.replace(/^OpenAL Soft on /i, '')}" ni bilo mogoče odpreti. Zvok gre na privzeto napravo sistema.`;
      this.lastError = this.audioWarning;
      this._changed();
    });
    engine.on('ready', () => this._restoreProgram());
  }

  // ---------- stanje za vmesnik ----------

  getState() {
    const fileExists = (p) => {
      try { return fs.existsSync(p); } catch { return false; }
    };
    return {
      engine: this.engine.getStatus(),
      settings: this.settings,
      videoModes: VIDEO_MODES,
      displays: this.displays.map((d) => ({ ...d, label: describeDisplay(d) })),
      audioDevices: [...new Set([...(this.engineAudioDevices || []), ...this.audioDevices])],
      displaysError: this.displaysError,
      audioWarning: this.audioWarning,
      programOutputResolved: this.resolvedOutput(),
      library: this.library.items.map((it) => ({ ...it, missing: !fileExists(it.path) })),
      program: this.program.item
        ? { id: this.program.item.id, name: this.program.item.name, startedAt: this.program.startedAt }
        : null,
      lastError: this.lastError,
    };
  }

  _changed() {
    this.emit('state', this.getState());
  }

  _error(msg) {
    this.lastError = msg;
    this._changed();
    const err = new Error(msg);
    err.userFacing = true;
    throw err;
  }

  // ---------- motor ----------

  /** Kateri zaslon se dejansko uporabi za PROGRAM (ime naprave, 'test' ali 'none'). */
  resolvedOutput() {
    const s = this.settings;
    if (s.programOutput === 'test' || s.programOutput === 'none') return s.programOutput;
    if (s.programOutput === 'auto') {
      const ext = this.displays.find((x) => !x.primary);
      return ext ? ext.device : 'test';
    }
    return this.displays.some((x) => x.device === s.programOutput) ? s.programOutput : 'test';
  }

  engineOptions() {
    const s = this.settings;
    const screens = [];
    const out = this.resolvedOutput();
    if (out === 'test') {
      const why = s.programOutput === 'test' ? '' : ' – izbran zaslon ni priklopljen';
      screens.push({ windowedTest: true, name: `Playout PROGRAM (testno okno${why})` });
    } else if (out !== 'none') {
      const d = this.displays.find((x) => x.device === out);
      screens.push({ display: d, name: 'Playout PROGRAM' });
    }
    return {
      videoMode: s.videoMode,
      screens,
      audioDevice: s.audioDevice || null,
      audioDelayFrames: Number(s.audioDelayFrames) || 0,
      templateDir: this.templateDir,
    };
  }

  async init() {
    await this.refreshDisplays();
    await this.engine.start(this.engineOptions());
  }

  async refreshDisplays() {
    try {
      this.displays = await this.listDisplaysFn();
      this.displaysError = '';
      this.engine._log(`Zasloni: ${this.displays.map((d) => `#${d.index} ${d.device} ${d.width}x${d.height} @${d.x},${d.y}${d.primary ? ' glavni' : ''}`).join(' | ') || 'nobenega'}`);
    } catch (e) {
      this.displays = [];
      this.displaysError = `Zaslonov ni bilo mogoče prebrati: ${e.message}`;
      this.lastError = this.displaysError;
      this.engine._log(this.displaysError);
    }
    this._changed();
    return this.displays;
  }

  setAudioDevices(list) {
    this.audioDevices = Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
    this._changed();
  }

  // ---------- nastavitve ----------

  async updateSettings(patch) {
    const allowed = ['videoMode', 'programOutput', 'audioDevice', 'audioDelayFrames'];
    const next = { ...this.settings };
    for (const k of allowed) if (k in patch) next[k] = patch[k];
    if (!VIDEO_MODES[next.videoMode]) this._error('Neznan video način');
    next.audioDelayFrames = Math.max(-25, Math.min(25, Math.round(Number(next.audioDelayFrames) || 0)));
    if (next.audioDevice !== this.settings.audioDevice) this.audioWarning = '';

    const engineRelevant = allowed.some((k) => next[k] !== this.settings[k]);
    this.settings = next;
    writeJson(this.settingsFile, this.settings);
    this._changed();
    if (engineRelevant) {
      await this.refreshDisplays();
      await this.engine.restart(this.engineOptions());
    }
  }

  // ---------- knjižnica ----------

  _saveLibrary() {
    writeJson(this.libraryFile, this.library);
    this._changed();
  }

  addFiles(files) {
    let added = 0;
    for (const f of files) {
      const item = makeItem(f);
      if (item) {
        this.library.items.push(item);
        added++;
      }
    }
    this._saveLibrary();
    return added;
  }

  removeItem(id) {
    this.library.items = this.library.items.filter((x) => x.id !== id);
    this._saveLibrary();
  }

  setLoop(id, loop) {
    const it = this.library.items.find((x) => x.id === id);
    if (!it) return;
    it.loop = !!loop;
    this._saveLibrary();
  }

  moveItem(id, toIndex) {
    const items = this.library.items;
    const from = items.findIndex((x) => x.id === id);
    if (from === -1) return;
    const [it] = items.splice(from, 1);
    items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, it);
    this._saveLibrary();
  }

  // ---------- program ----------

  _playCommand(item, seekFrames = 0) {
    let cmd = `PLAY ${PROGRAM_CHANNEL}-${LAYER_MAIN} ${quote(mediaPath(item.path))}`;
    if (item.type !== 'image') {
      if (item.loop) cmd += ' LOOP';
      if (seekFrames > 0) cmd += ` SEEK ${Math.floor(seekFrames)} IN 0`;
    }
    return cmd;
  }

  async play(id) {
    const item = this.library.items.find((x) => x.id === id);
    if (!item) this._error('Posnetek ni v knjižnici');
    if (!fs.existsSync(item.path)) this._error(`Datoteka ne obstaja: ${item.path}`);
    if (this.engine.status !== 'running') this._error('Motor ne teče');
    try {
      await this.engine.send(this._playCommand(item));
    } catch (e) {
      this._error(`Predvajanje ni uspelo: ${e.message}`);
    }
    this.program = { item: { ...item }, startedAt: Date.now() };
    this.lastError = '';
    this._changed();
  }

  async clearProgram() {
    this.program = { item: null, startedAt: 0 };
    this._changed();
    if (this.engine.status === 'running') {
      await this.engine.send(`CLEAR ${PROGRAM_CHANNEL}-${LAYER_MAIN}`);
    }
  }

  /** Po ponovnem zagonu motorja vrnemo na program, kar je bilo tam. */
  async _restoreProgram() {
    const p = this.program;
    if (!p.item) return;
    try {
      let seek = 0;
      if (!p.item.loop && p.item.type !== 'image') {
        seek = ((Date.now() - p.startedAt) / 1000) * fpsOf(this.settings.videoMode);
      }
      await this.engine.send(this._playCommand(p.item, seek));
    } catch (e) {
      this.lastError = `Obnovitev programa ni uspela: ${e.message}`;
      this._changed();
    }
  }
}

module.exports = { Controller, fpsOf, PROGRAM_CHANNEL, LAYER_MAIN };
