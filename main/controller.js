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
const PREVIEW_CHANNEL = 2;
const LAYER_MAIN = 10;
const MONITOR_CONSUMER = 900; // številka "consumerja" za monitor v vmesniku

const TRANSITIONS = {
  MIX: 'Preliv (dissolve)',
  VFADE: 'Čez črno',
  WIPE: 'Brisanje (wipe)',
  SLIDE: 'Drsenje (slide)',
  PUSH: 'Potisk (push)',
};
const DIRECTIONS = { LEFT: 'v levo', RIGHT: 'v desno', UP: 'navzgor', DOWN: 'navzdol' };

const DEFAULT_SETTINGS = {
  transitionType: 'MIX',
  transitionFrames: 12,
  transitionDirection: 'LEFT',
  previewMode: true, // false = klik gre neposredno na program
  directTake: 'cut', // v načinu brez preview: 'cut' ali 'auto'
  autoNext: true, // po prehodu naloži naslednji posnetek v preview
  videoMode: '1080p5000',
  programOutput: 'auto', // 'auto' = prvi zaslon, ki ni glavni; 'test' = okno; sicer ime zaslona (npr. \\.\DISPLAY2)
  audioDevice: '', // '' = privzeta naprava sistema
  audioDelayFrames: 0, // zvok kasneje za toliko sličic (zakasnitev slike v CasparCG ne deluje, ko ima zaslon več Hz kot kanal)
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
  constructor({ engine, dataDir, listDisplays, templateDir, monitors = null, osc = null }) {
    super();
    this.monitors = monitors; // { 1: ChannelMonitor, 2: ChannelMonitor }
    this.osc = osc;
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
    this.preview = { item: null }; // kaj je v preview
    this.cuedId = null; // posnetek, ki je že naložen v ozadje programa (za takojšen CUT)
    this.times = { 1: null, 2: null }; // { elapsed, total } iz OSC
    this._timeEmitAt = 0;
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
    engine.on('ready', () => this._onEngineReady());

    if (osc) osc.on('message', (m) => this._onOsc(m));
    if (monitors) {
      for (const ch of Object.keys(monitors)) {
        monitors[ch].on('disconnected', () => this._onMonitorLost(Number(ch)));
      }
    }
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
        ? { id: this.program.item.id, name: this.program.item.name, type: this.program.item.type, loop: !!this.program.item.loop, startedAt: this.program.startedAt }
        : null,
      preview: this.preview.item
        ? { id: this.preview.item.id, name: this.preview.item.name, type: this.preview.item.type, loop: !!this.preview.item.loop }
        : null,
      transitions: TRANSITIONS,
      directions: DIRECTIONS,
      times: this.times,
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
      audioDelayFrames: Math.max(0, Number(s.audioDelayFrames) || 0),
      templateDir: this.templateDir,
      oscPort: this.osc ? this.osc.port : undefined,
    };
  }

  async init() {
    if (this.osc && !this.osc.socket) {
      try {
        await this.osc.start();
      } catch (e) {
        this.engine._log(`OSC ni na voljo: ${e.message}`);
      }
    }
    if (this.monitors) {
      for (const m of Object.values(this.monitors)) if (!m.server) await m.start();
    }
    await this.refreshDisplays();
    await this.engine.start(this.engineOptions());
  }

  async refreshDisplays() {
    try {
      this.displays = await this.listDisplaysFn();
      this.displaysError = this.displays.problem
        ? `Natančen seznam zaslonov ni na voljo (${this.displays.problem}). Uporabljam približen seznam.`
        : '';
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
    const operational = ['transitionType', 'transitionFrames', 'transitionDirection', 'previewMode', 'directTake', 'autoNext'];
    const next = { ...this.settings };
    for (const k of [...allowed, ...operational]) if (k in patch) next[k] = patch[k];
    if (!TRANSITIONS[next.transitionType]) next.transitionType = 'MIX';
    if (!DIRECTIONS[next.transitionDirection]) next.transitionDirection = 'LEFT';
    next.transitionFrames = Math.max(1, Math.min(250, Math.round(Number(next.transitionFrames) || 12)));
    next.previewMode = !!next.previewMode;
    next.autoNext = !!next.autoNext;
    next.directTake = next.directTake === 'auto' ? 'auto' : 'cut';
    if (!VIDEO_MODES[next.videoMode]) this._error('Neznan video način');
    next.audioDelayFrames = Math.max(0, Math.min(25, Math.round(Number(next.audioDelayFrames) || 0)));
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

  // ---------- preview / program ----------

  _item(id) {
    const item = this.library.items.find((x) => x.id === id);
    if (!item) this._error('Posnetek ni v knjižnici');
    return item;
  }

  _requireEngine() {
    if (this.engine.status !== 'running') this._error('Motor ne teče');
  }

  _checkFile(item) {
    if (!fs.existsSync(item.path)) this._error(`Datoteka ne obstaja: ${item.path}`);
  }

  /** Del ukaza za prehod, npr. "MIX 12 LINEAR" ali "WIPE 12 LINEAR LEFT". */
  transitionPart() {
    const s = this.settings;
    const t = TRANSITIONS[s.transitionType] ? s.transitionType : 'MIX';
    const dur = Math.max(1, Math.round(Number(s.transitionFrames) || 12));
    const dir = ['WIPE', 'SLIDE', 'PUSH'].includes(t) ? ` ${s.transitionDirection || 'LEFT'}` : '';
    return `${t} ${dur} LINEAR${dir}`;
  }

  _mediaArgs(item, seekFrames = 0) {
    let cmd = quote(mediaPath(item.path));
    if (item.type !== 'image') {
      if (item.loop) cmd += ' LOOP';
      if (seekFrames > 0) cmd += ` SEEK ${Math.floor(seekFrames)} IN 0`;
    }
    return cmd;
  }

  _playCommand(item, seekFrames = 0, transition = '') {
    return `PLAY ${PROGRAM_CHANNEL}-${LAYER_MAIN} ${this._mediaArgs(item, seekFrames)}${transition ? ' ' + transition : ''}`;
  }

  async _cue(item) {
    // Preview pokaže prvo sličico, program ima posnetek že odprt v ozadju (takojšen CUT).
    this.cuedId = null;
    await this.engine.send(`LOAD ${PREVIEW_CHANNEL}-${LAYER_MAIN} ${this._mediaArgs(item)}`);
    await this.engine.send(`LOADBG ${PROGRAM_CHANNEL}-${LAYER_MAIN} ${this._mediaArgs(item)}`);
    this.cuedId = item.id;
  }

  /** Naloži posnetek v PREVIEW. */
  async loadPreview(id) {
    const item = this._item(id);
    this._checkFile(item);
    this.preview = { item: { ...item } };
    this.lastError = '';
    this._changed();
    if (this.engine.status !== 'running') return;
    try {
      await this._cue(item);
    } catch (e) {
      this._error(`Nalaganje v preview ni uspelo: ${e.message}`);
    }
  }

  async clearPreview() {
    this.preview = { item: null };
    this.cuedId = null;
    this._changed();
    if (this.engine.status === 'running') {
      await this.engine.send(`CLEAR ${PREVIEW_CHANNEL}-${LAYER_MAIN}`);
      await this.engine.send(`LOADBG ${PROGRAM_CHANNEL}-${LAYER_MAIN} EMPTY`);
    }
  }

  /** Preview gre na program. kind: 'cut' ali 'auto'. */
  async take(kind = 'cut') {
    const item = this.preview.item;
    if (!item) this._error('Preview je prazen');
    this._requireEngine();
    this._checkFile(item);
    try {
      if (kind === 'cut' && this.cuedId === item.id) {
        await this.engine.send(`PLAY ${PROGRAM_CHANNEL}-${LAYER_MAIN}`);
      } else {
        await this.engine.send(this._playCommand(item, 0, kind === 'auto' ? this.transitionPart() : ''));
      }
    } catch (e) {
      this._error(`Prehod ni uspel: ${e.message}`);
    }
    this.cuedId = null;
    this.program = { item: { ...item }, startedAt: Date.now() };
    this.times[PROGRAM_CHANNEL] = null;
    this.lastError = '';
    this._changed();
    await this._afterTake(item);
  }

  async _afterTake(item) {
    if (this.settings.autoNext) {
      const items = this.library.items;
      const idx = items.findIndex((x) => x.id === item.id);
      const next = idx >= 0 ? items[idx + 1] : null;
      if (next) {
        try {
          await this.loadPreview(next.id);
        } catch { /* napaka je že prikazana */ }
        return;
      }
      await this.clearPreview();
      return;
    }
    // Brez samodejnega naslednjega: isti posnetek ostane pripravljen.
    try {
      await this._cue(item);
    } catch { /* ni kritično */ }
  }

  /** Način brez preview: posnetek gre neposredno na program. */
  async playDirect(id, kind) {
    const item = this._item(id);
    this._checkFile(item);
    this._requireEngine();
    const k = kind || this.settings.directTake;
    try {
      await this.engine.send(this._playCommand(item, 0, k === 'auto' ? this.transitionPart() : ''));
    } catch (e) {
      this._error(`Predvajanje ni uspelo: ${e.message}`);
    }
    this.cuedId = null;
    this.program = { item: { ...item }, startedAt: Date.now() };
    this.times[PROGRAM_CHANNEL] = null;
    this.lastError = '';
    this._changed();
  }

  /** Združljivost s 1. korakom. */
  play(id) {
    return this.playDirect(id, 'cut');
  }

  /** Počisti program. withTransition = zatemnitev s trenutnim trajanjem prehoda. */
  async clearProgram(withTransition = false) {
    this.program = { item: null, startedAt: 0 };
    this.times[PROGRAM_CHANNEL] = null;
    this._changed();
    if (this.engine.status !== 'running') return;
    if (withTransition) {
      const dur = Math.max(1, Math.round(Number(this.settings.transitionFrames) || 12));
      await this.engine.send(`PLAY ${PROGRAM_CHANNEL}-${LAYER_MAIN} EMPTY MIX ${dur} LINEAR`);
    } else {
      await this.engine.send(`CLEAR ${PROGRAM_CHANNEL}-${LAYER_MAIN}`);
    }
    // Ozadje programa je bilo morda izpraznjeno; preview ponovno pripravimo.
    if (this.preview.item) {
      try {
        await this._cue(this.preview.item);
      } catch { /* ni kritično */ }
    }
  }

  // ---------- motor: obnova, monitorji, čas ----------

  async _onEngineReady() {
    await this._addMonitors();
    await this._restoreProgram();
    if (this.preview.item) {
      try {
        await this._cue(this.preview.item);
      } catch { /* ni kritično */ }
    }
  }

  async _addMonitors() {
    if (!this.monitors) return;
    for (const [ch, m] of Object.entries(this.monitors)) {
      try {
        await this.engine.send(m.addCommand(MONITOR_CONSUMER));
      } catch (e) {
        this.engine._log(`Monitor kanala ${ch} ni na voljo: ${e.message}`);
      }
    }
  }

  async _onMonitorLost(ch) {
    // Monitor je samo za ogled; če se prekine, ga v miru dodamo znova.
    if (this.engine.status !== 'running' || !this.monitors) return;
    setTimeout(async () => {
      if (this.engine.status !== 'running' || this.monitors[ch].connected) return;
      try {
        await this.engine.send(`REMOVE ${ch}-${MONITOR_CONSUMER}`).catch(() => {});
        await this.engine.send(this.monitors[ch].addCommand(MONITOR_CONSUMER));
      } catch { /* poskusimo ob naslednjem zagonu */ }
    }, 2000);
  }

  _onOsc({ address, args }) {
    const m = /^\/channel\/(\d+)\/stage\/layer\/(\d+)\/foreground\/file\/time$/.exec(address);
    if (!m || Number(m[2]) !== LAYER_MAIN) return;
    const ch = Number(m[1]);
    if (ch !== PROGRAM_CHANNEL && ch !== PREVIEW_CHANNEL) return;
    const [elapsed, total] = args;
    if (typeof elapsed !== 'number') return;
    this.times[ch] = { elapsed, total: typeof total === 'number' ? total : 0 };
    const now = Date.now();
    if (now - this._timeEmitAt > 200) {
      this._timeEmitAt = now;
      this.emit('times', this.times);
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

module.exports = { Controller, fpsOf, PROGRAM_CHANNEL, PREVIEW_CHANNEL, LAYER_MAIN, MONITOR_CONSUMER, TRANSITIONS };
