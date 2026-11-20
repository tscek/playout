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
const { Playlist } = require('./playlist');
const { probeSize } = require('./probe');

const PROGRAM_CHANNEL = 1;
const PREVIEW_CHANNEL = 2;
const LAYER_MAIN = 10;
const LAYER_PANIC_BG = 990; // črna podlaga za paniko
const LAYER_PANIC = 991; // logo za paniko
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
  masterVolumeDb: 0, // glavni fader programa v dB
  masterMuted: false,
  panicSource: '', // '' = črno, sicer id posnetka (logo) iz knjižnice
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
  constructor({ engine, dataDir, listDisplays, templateDir, monitors = null, osc = null, actions = null }) {
    super();
    this.monitors = monitors; // { 1: ChannelMonitor, 2: ChannelMonitor }
    this.actions = actions; // shranjene akcije (ATEM, XR18, HTTP, OSC)
    if (actions) actions.on('changed', () => this._changed());
    this.osc = osc;
    this.engine = engine;
    this.dataDir = dataDir;
    this.listDisplaysFn = listDisplays;
    this.templateDir = templateDir;

    this.settingsFile = path.join(dataDir, 'settings.json');
    this.libraryFile = path.join(dataDir, 'library.json');
    this.playlistFile = path.join(dataDir, 'playlist.json');
    this.stillDir = path.join(dataDir, 'stills'); // kopije slik za predvajanje s prileganjem

    const saved = readJson(this.settingsFile, {});
    if (!saved.settingsVersion && saved.programOutput === 'test') saved.programOutput = 'auto'; // v0.1.0 je imel privzeto testno okno
    this.settings = { ...DEFAULT_SETTINGS, ...saved, settingsVersion: 2 };
    this.library = readJson(this.libraryFile, { items: [] });
    this.displays = [];
    this.audioDevices = [];
    this.playlist = new Playlist(readJson(this.playlistFile, null));
    this._migrateLook();
    // src = { groupId, entryId }, če je posnetek prišel iz playliste
    this.program = { item: null, startedAt: 0, src: null }; // kaj je na programu
    this.preview = { item: null, src: null, seek: 0 }; // kaj je v preview
    this.cuedId = null; // posnetek, ki je že naložen v ozadje programa (za takojšen CUT)
    this.autoCuedId = null; // posnetek v ozadju, ki ga motor sam zažene ob koncu programa
    this.imageTimer = null; // samodejno nadaljevanje po sliki
    this.panic = false;
    this._lastPgmPath = null;
    this._cueGen = 0;
    this.times = { 1: null, 2: null }; // { elapsed, total, fps } iz OSC
    this.clipFps = { 1: 0, 2: 0 }; // sličice na sekundo posnetka (iz OSC)
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
    const libById = new Map(this.library.items.map((it) => [it.id, it]));
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
        ? { id: this.program.item.id, name: this.program.item.name, type: this.program.item.type, loop: !!this.program.item.loop,
          volumeDb: this.program.item.volumeDb || 0, muted: !!this.program.item.muted, ...this._specState(this.program.item, this.program.src),
          paused: !!this.program.paused, pausedAt: this.program.pausedAt || 0, now: Date.now(), startedAt: this.program.startedAt, src: this.program.src }
        : null,
      preview: this.preview.item
        ? { id: this.preview.item.id, name: this.preview.item.name, type: this.preview.item.type, loop: !!this.preview.item.loop,
          volumeDb: this.preview.item.volumeDb || 0, muted: !!this.preview.item.muted, ...this._specState(this.preview.item, this.preview.src),
          playing: !!this.preview.playing, fit: this.preview.item.fit || 'fit', zoom: this.preview.item.zoom || 1,
          posX: this.preview.item.posX || 0, posY: this.preview.item.posY || 0, width: this.preview.item.width || 0, height: this.preview.item.height || 0, src: this.preview.src, autoFollow: this.autoCuedId ? 'end' : this.imageTimer ? 'timer' : null }
        : null,
      playlist: this.playlist.groups.map((g) => ({
        ...g,
        items: g.items.map((e) => {
          const it = libById.get(e.mediaId);
          return { ...e, name: it ? it.name : '?', type: it ? it.type : 'video', loop: !!(it && it.loop), missing: !it || !fileExists(it.path) };
        }),
      })),
      panic: this.panic,
      actions: this.actions ? this.actions.getState() : { devices: [], actions: [] },
      transitions: TRANSITIONS,
      directions: DIRECTIONS,
      times: this.times,
      lastError: this.lastError,
    };
  }

  _specState(item, src) {
    const sp = this._spec(item, src);
    return { inSec: sp.inSec, outSec: sp.outSec, end: sp.end, seconds: sp.seconds, loop: sp.loop };
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
    if (this.actions && !this._actionsStarted) {
      this._actionsStarted = true;
      this.actions.start();
    }
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
    const operational = ['transitionType', 'transitionFrames', 'transitionDirection', 'previewMode', 'directTake', 'autoNext', 'panicSource', 'masterVolumeDb', 'masterMuted'];
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
    if (typeof next.panicSource !== 'string') next.panicSource = '';
    next.masterVolumeDb = clampDb(next.masterVolumeDb, 0);
    next.masterMuted = !!next.masterMuted;
    const masterChanged = next.masterVolumeDb !== this.settings.masterVolumeDb || next.masterMuted !== this.settings.masterMuted;
    const panicChanged = next.panicSource !== this.settings.panicSource;
    const transitionChanged = ['transitionType', 'transitionFrames', 'transitionDirection'].some((k) => next[k] !== this.settings[k]);

    const engineRelevant = allowed.some((k) => next[k] !== this.settings[k]);
    this.settings = next;
    writeJson(this.settingsFile, this.settings);
    this._changed();
    if (engineRelevant) {
      await this.refreshDisplays();
      await this.engine.restart(this.engineOptions());
      return;
    }
    if (panicChanged && this.panic && this.engine.status === 'running') await this._applyPanic().catch(() => {});
    if (masterChanged && !this.panic && this.engine.status === 'running') await this._applyMaster().catch(() => {});
    // Samodejno nadaljevanje ima prehod pripet v ozadje; ob spremembi prehoda ga pripravimo znova.
    if (transitionChanged && this.autoCuedId && this.preview.item) await this._cue().catch(() => {});
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
        this._probe(item);
        this.library.items.push(item);
        added++;
      }
    }
    this._saveLibrary();
    return added;
  }

  /** Prebere velikost slike/videa (za prileganje). */
  _probe(item) {
    if (item.type === 'audio') return;
    const d = probeSize(item.path, item.type);
    if (d && d.width > 0 && d.height > 0) {
      item.width = d.width;
      item.height = d.height;
    }
  }

  /**
   * Nastavitve vnosa v preview ali programu (which): jakost, mute, prileganje.
   * patch: { volumeDb, muted, fit, zoom, posX, posY, reset }. Shranijo se k vnosu v playlisti.
   */
  async setLook(which, patch) {
    const slot = which === 'program' ? this.program : this.preview;
    if (!slot.item) this._error(which === 'program' ? 'Program je prazen' : 'Preview je prazen');
    if (!slot.src || !this.playlist.findEntry(slot.src.entryId)) this._error('Nastavitve ima samo vnos v playlisti. Dodaj posnetek v playlisto.');
    const p = { ...(patch || {}) };
    const entryId = slot.src.entryId;
    this.playlist.setEntry(entryId, p);
    this._savePlaylist();
    const lib = this._item(slot.item.id);
    if (!lib.width && lib.type !== 'audio' && ('fit' in p || 'zoom' in p || 'posX' in p || 'posY' in p || p.reset)) this._probe(lib);
    for (const s of [this.preview, this.program]) {
      if (s.item && s.src && s.src.entryId === entryId) s.item = this._slotItem(lib, s.src);
    }
    if (this.engine.status !== 'running') return;
    if (('volumeDb' in p || 'muted' in p) && this.program.src && this.program.src.entryId === entryId) {
      await this._applyItemVolume(this.program.item, 0);
    }
    // Postavitev: preview se pripravi znova (program dobi spremembo ob naslednjem predvajanju).
    const look = 'fit' in p || 'zoom' in p || 'posX' in p || 'posY' in p || p.reset;
    if (look && this.preview.src && this.preview.src.entryId === entryId) {
      this.preview.seek = this._previewPosFrames();
      await this._cue();
    }
  }

  /** Posnetek, kot ga predvajamo: datoteka iz knjižnice + nastavitve vnosa (jakost, mute, prileganje). */
  _slotItem(item, src) {
    const f = src ? this.playlist.findEntry(src.entryId) : null;
    const e = f ? f.entry : {};
    const out = { ...item, volumeDb: e.volumeDb || 0, muted: !!e.muted, zoom: e.zoom || 1, posX: e.posX || 0, posY: e.posY || 0 };
    delete out.fit;
    if (e.fit) out.fit = e.fit;
    delete out.inSec;
    delete out.outSec;
    return out;
  }

  /** v0.7.0: nastavitve, ki so bile shranjene k mediju, gredo k vsem njegovim vnosom v playlisti. */
  _migrateLook() {
    let moved = false;
    for (const it of this.library.items) {
      const look = {};
      for (const k of ['volumeDb', 'muted', 'fit', 'zoom', 'posX', 'posY', 'inSec', 'outSec']) {
        if (!(k in it)) continue;
        if (!['inSec', 'outSec'].includes(k) && it[k] !== null) look[k] = it[k];
        delete it[k];
        moved = true;
      }
      if (!Object.keys(look).length) continue;
      for (const g of this.playlist.groups) for (const e of g.items) if (e.mediaId === it.id) this.playlist.setEntry(e.id, { ...look });
    }
    if (moved) {
      writeJson(this.libraryFile, this.library);
      writeJson(this.playlistFile, this.playlist.toJSON());
    }
  }

  removeItem(id) {
    this.library.items = this.library.items.filter((x) => x.id !== id);
    this.playlist.removeMedia(id);
    if (this.settings.panicSource === id) {
      this.settings.panicSource = '';
      writeJson(this.settingsFile, this.settings);
    }
    writeJson(this.playlistFile, this.playlist.toJSON());
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

  // ---------- playlist ----------

  _savePlaylist() {
    writeJson(this.playlistFile, this.playlist.toJSON());
    this._changed();
  }

  _group(groupId) {
    const g = this.playlist.group(groupId);
    if (!g) this._error('Skupina ne obstaja');
    return g;
  }

  addGroup(name) {
    const g = this.playlist.addGroup(name);
    this._savePlaylist();
    return g.id;
  }

  async removeGroup(groupId) {
    this.playlist.removeGroup(groupId);
    this._savePlaylist();
    await this._rearm();
  }

  async setGroup(groupId, patch) {
    this._group(groupId);
    this.playlist.setGroup(groupId, patch || {});
    this._savePlaylist();
    await this._rearm();
  }

  moveGroup(groupId, index) {
    this.playlist.moveGroup(groupId, index);
    this._savePlaylist();
  }

  async addToGroup(groupId, mediaIds, index) {
    this._group(groupId);
    const ids = (mediaIds || []).filter((id) => this.library.items.some((x) => x.id === id));
    const added = this.playlist.addMedia(groupId, ids, index);
    this._savePlaylist();
    await this._rearm();
    return added.length;
  }

  async removeEntry(entryId) {
    this.playlist.removeEntry(entryId);
    this._savePlaylist();
    await this._rearm();
  }

  async moveEntry(entryId, toGroupId, index) {
    this.playlist.moveEntry(entryId, toGroupId, index);
    this._savePlaylist();
    await this._rearm();
  }

  /** Nastavitve vnosa (konec, trajanje slike, IN/OUT). */
  async setEntry(entryId, patch) {
    if (!this.playlist.setEntry(entryId, patch || {})) this._error('Vnos ne obstaja');
    this._savePlaylist();
    for (const sl of [this.preview, this.program]) {
      if (sl.item && sl.src && sl.src.entryId === entryId) sl.item = this._slotItem(this._item(sl.item.id), sl.src);
    }
    await this._refreshPreviewSpec(entryId);
    await this._rearm();
  }

  /** Če je spremenjen vnos v preview, ga pripravimo znova (nove IN/OUT točke). */
  async _refreshPreviewSpec(entryId, mediaId) {
    const v = this.preview;
    if (!v.item || this.engine.status !== 'running') return;
    const hit = entryId ? v.src && v.src.entryId === entryId : !v.src && v.item.id === mediaId;
    if (!hit) return;
    try {
      await this._cue();
    } catch { /* ni kritično */ }
  }

  /**
   * IN ali OUT točka za posnetek v preview na trenutnem mestu (which: 'in' | 'out'),
   * ali brisanje točke (clear: true). Shrani se k vnosu v playlisti ali k mediju.
   */
  async markPreview(which, clear = false) {
    const v = this.preview;
    if (!v.item || v.item.type === 'image') this._error('V preview ni videa ali zvoka');
    const t = this.times[PREVIEW_CHANNEL];
    const pos = t ? Math.round(t.elapsed * 1000) / 1000 : (v.seek || 0) / fpsOf(this.settings.videoMode);
    const key = which === 'out' ? 'outSec' : 'inSec';
    const value = clear ? null : pos;
    const spec = this._spec(v.item, v.src);
    if (!clear && key === 'outSec' && spec.inSec && value <= spec.inSec) this._error('OUT mora biti za IN točko');
    if (!clear && key === 'inSec' && spec.outSec && value >= spec.outSec) this._error('IN mora biti pred OUT točko');
    if (!v.src || !this.playlist.findEntry(v.src.entryId)) this._error('IN in OUT ima samo vnos v playlisti. Dodaj posnetek v playlisto.');
    this.playlist.setEntry(v.src.entryId, { [key]: value });
    writeJson(this.playlistFile, this.playlist.toJSON());
    // Playhead ostane, kjer je.
    v.seek = Math.round(pos * fpsOf(this.settings.videoMode));
    this._changed();
    if (this.engine.status === 'running') await this._cue();
  }

  /** Prvi posnetek skupine v preview. */
  async cueGroup(groupId) {
    const g = this._group(groupId);
    if (!g.items.length) this._error('Skupina je prazna');
    await this.loadPreview(g.items[0].mediaId, g.items[0].id);
  }

  _srcOf(entryId) {
    if (!entryId) return null;
    const f = this.playlist.findEntry(entryId);
    return f ? { groupId: f.group.id, entryId } : null;
  }

  /** Kaj pride za danim posnetkom: naslednji v skupini ali v knjižnici. */
  _nextFor(item, src) {
    if (src) {
      const n = this.playlist.nextAfter(src.entryId);
      if (!n) return null;
      const next = this.library.items.find((x) => x.id === n.entry.mediaId);
      return next ? { item: next, entryId: n.entry.id } : null;
    }
    const items = this.library.items;
    const idx = items.findIndex((x) => x.id === item.id);
    const next = idx >= 0 ? items[idx + 1] : null;
    return next ? { item: next, entryId: null } : null;
  }

  /**
   * Kako se posnetek predvaja glede na vnos v playlisti (ali nastavitve medija):
   * end: 'stop' | 'cut' | 'mix' | 'loop', loop, inF/outF (sličice), seconds (trajanje slike), explicit (vnos ima svojo nastavitev).
   */
  _spec(item, src) {
    const f = src ? this.playlist.findEntry(src.entryId) : null;
    const e = f ? f.entry : null;
    const g = f ? f.group : null;
    const end = (e && e.end) || (g ? g.end : 'stop');
    const fps = fpsOf(this.settings.videoMode);
    const inSec = e ? e.inSec : null;
    const outSec = e ? e.outSec : null;
    return {
      end,
      explicit: !!(e && e.end),
      loop: end === 'loop' || !!item.loop,
      inSec: inSec || null,
      outSec: outSec || null,
      inF: inSec ? Math.round(inSec * fps) : 0,
      outF: outSec ? Math.round(outSec * fps) : 0,
      seconds: (e && e.seconds) || (g ? g.imageSeconds : null),
    };
  }

  /**
   * Ali naj posnetek v preview sam sledi programu, ko se ta konča:
   * 'bg' = motor ga sam zažene na koncu videa, 'timer' = slika na programu, preklopimo po času, null = ne.
   */
  _autoFollowMode() {
    const p = this.program;
    const v = this.preview;
    if (!p.item || !p.src || !v.item || !v.src) return null;
    const spec = this._spec(p.item, p.src);
    if (!['cut', 'mix'].includes(spec.end) || spec.loop) return null;
    const next = this.playlist.nextAfter(p.src.entryId);
    if (!next || next.entry.id !== v.src.entryId) return null;
    // Privzeta nastavitev skupine se ustavi na koncu skupine; vnos z lastno nastavitvijo gre tudi v naslednjo.
    if (!spec.explicit && next.group.id !== p.src.groupId) return null;
    if (p.item.type === 'image') return spec.seconds ? 'timer' : null;
    return 'bg';
  }

  /** Ali program po koncu nadaljuje (za pripravo naslednjega v preview). */
  _programFollows() {
    const p = this.program;
    if (!p.item || !p.src) return false;
    const spec = this._spec(p.item, p.src);
    return ['cut', 'mix'].includes(spec.end) && !spec.loop;
  }

  /** Po spremembi playliste preverimo, ali je samodejno nadaljevanje še pravilno pripravljeno. */
  async _rearm() {
    if (this.engine.status !== 'running') return;
    const p = this.program;
    if (this._programFollows() && !this.preview.item) {
      const next = this._nextFor(p.item, p.src);
      if (next) {
        try {
          await this.loadPreview(next.item.id, next.entryId);
        } catch { /* napaka je že prikazana */ }
        return;
      }
    }
    const want = this._autoFollowMode();
    const have = this.autoCuedId ? 'bg' : this.imageTimer ? 'timer' : null;
    if (want !== have && this.preview.item) {
      try {
        await this._cue();
      } catch { /* ni kritično */ }
    }
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

  /**
   * ffmpeg filter za prileganje na 1920x1080 (ohrani razmerje, povečava, premik).
   * null = ni potreben (16:9 brez sprememb ali raztegni brez sprememb), takrat motor sam raztegne na kanal.
   */
  _fitFilter(item) {
    if (item.type === 'audio') return null;
    const W = 1920;
    const H = 1080;
    const fit = item.fit || 'fit';
    const z = Number(item.zoom) || 1;
    const px = Number(item.posX) || 0;
    const py = Number(item.posY) || 0;
    const plain = z === 1 && !px && !py;
    const w = item.width;
    const h = item.height;
    if (plain && fit === 'stretch') return null;
    if (!w || !h) {
      // Velikost ni znana (redek format): privzeto pustimo motorju, sicer prileganje opravi ffmpeg sam
      // (povečava in premik takrat nista mogoča).
      if (!item.fit) return null;
      if (fit === 'fill') return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
      if (fit === 'fit') return `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:-1:-1:color=black@0,setsar=1`;
      return null;
    }
    if (plain && Math.abs(w / h - W / H) < 0.01) return null;
    const even = (v) => Math.max(2, Math.round(v / 2) * 2);
    let sw;
    let sh;
    if (fit === 'stretch') {
      sw = even(W * z);
      sh = even(H * z);
    } else {
      const k = (fit === 'fill' ? Math.max(W / w, H / h) : Math.min(W / w, H / h)) * z;
      sw = even(w * k);
      sh = even(h * k);
    }
    const left = Math.round(((W - sw) / 2 + (px / 100) * W) / 2) * 2;
    const top = Math.round(((H - sh) / 2 + (py / 100) * H) / 2) * 2;
    const cx = Math.max(0, -left);
    const cy = Math.max(0, -top);
    const vw = Math.min(sw - cx, W - Math.max(0, left));
    const vh = Math.min(sh - cy, H - Math.max(0, top));
    if (vw < 2 || vh < 2) return `scale=2:2,pad=${W}:${H}:0:0:color=black@0,setsar=1`; // povsem izven slike
    let f = `scale=${sw}:${sh}`;
    if (cx || cy || vw < sw || vh < sh) f += `,crop=${even(vw - 1)}:${even(vh - 1)}:${cx}:${cy}`;
    f += `,pad=${W}:${H}:${Math.max(0, left)}:${Math.max(0, top)}:color=black@0,setsar=1`;
    return f;
  }

  /** Pot, ki jo dobi motor. Slika s prileganjem gre skozi ffmpeg (kopija s končnico .still). */
  _playPath(item) {
    if (item.type !== 'image' || !this._fitFilter(item)) return item.path;
    try {
      const st = fs.statSync(item.path);
      const file = path.join(this.stillDir, `${item.id}-${Math.round(st.mtimeMs)}.still`);
      if (!fs.existsSync(file)) {
        fs.mkdirSync(this.stillDir, { recursive: true });
        for (const old of fs.readdirSync(this.stillDir)) if (old.startsWith(`${item.id}-`)) fs.rmSync(path.join(this.stillDir, old), { force: true });
        fs.copyFileSync(item.path, file);
      }
      return file;
    } catch {
      return item.path;
    }
  }

  /** Parametri posnetka za AMCP: pot, LOOP, SEEK (sličice od začetka datoteke), IN/OUT točki, filter za prileganje. */
  _mediaArgs(item, seekFrames = 0, src = null) {
    let cmd = quote(mediaPath(this._playPath(item)));
    const vf = this._fitFilter(item);
    if (vf) cmd += ` VF ${quote(vf)}`;
    if (item.type !== 'image') {
      const spec = this._spec(item, src);
      if (spec.loop) cmd += ' LOOP';
      let seek = Math.max(0, Math.floor(seekFrames));
      if (spec.outF && seek >= spec.outF) seek = spec.inF;
      if (seek > 0 || spec.inF || spec.outF) cmd += ` SEEK ${seek} IN ${spec.inF}`;
      if (spec.outF) cmd += ` OUT ${spec.outF}`;
    }
    return cmd;
  }

  _playCommand(item, seekFrames = 0, transition = '', src = null) {
    return `PLAY ${PROGRAM_CHANNEL}-${LAYER_MAIN} ${this._mediaArgs(item, seekFrames, src)}${transition ? ' ' + transition : ''}`;
  }

  _clearImageTimer() {
    if (this.imageTimer) clearTimeout(this.imageTimer);
    this.imageTimer = null;
  }

  /**
   * Pripravi posnetek iz preview: preview pokaže prvo sličico, program ga ima že odprtega v ozadju
   * (takojšen CUT). Če skupina samodejno nadaljuje, motor ozadje sam zažene ob koncu programa.
   */
  async _cue() {
    const item = this.preview.item;
    this.cuedId = null;
    this.autoCuedId = null;
    this._clearImageTimer();
    if (!item) return;
    const gen = ++this._cueGen;
    this.preview.playing = false;
    const mode = this._autoFollowMode();
    const seek = this.preview.seek || 0;
    const src = this.preview.src;
    await this.engine.send(`LOAD ${PREVIEW_CHANNEL}-${LAYER_MAIN} ${this._mediaArgs(item, seek, src)}`);
    if (mode === 'bg') {
      // CasparCG 2.5 napaka: če AUTO pripravimo takoj po zagonu posnetka s SEEK, motor preklopi takoj.
      // Zato počakamo, da program teče vsaj 0,7 s.
      const wait = 700 - (Date.now() - (this.program.wallStart || 0));
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
        if (gen !== this._cueGen) return;
      }
    }
    let bg = `LOADBG ${PROGRAM_CHANNEL}-${LAYER_MAIN} ${this._mediaArgs(item, seek, src)}`;
    if (mode === 'bg') bg += `${this._followCut() ? '' : ' ' + this.transitionPart()} AUTO`;
    await this.engine.send(bg);
    this.cuedId = item.id;
    if (mode === 'bg') this.autoCuedId = item.id;
    if (mode === 'timer') this._startImageTimer();
    this._changed();
  }

  /** Ali skupina, ki je na programu, samodejno nadaljuje s CUT (brez prehoda). */
  _followCut() {
    const p = this.program;
    return !!(p.item && p.src && this._spec(p.item, p.src).end === 'cut');
  }

  _startImageTimer() {
    if (this.program.paused) return; // ob nadaljevanju se nastavi znova
    const secs = this._spec(this.program.item, this.program.src).seconds || 5;
    const wait = Math.max(0, secs * 1000 - (Date.now() - this.program.startedAt));
    const expect = this.preview.src.entryId;
    this.imageTimer = setTimeout(() => {
      this.imageTimer = null;
      if (!this.preview.src || this.preview.src.entryId !== expect) return;
      this.take(this._followCut() ? 'cut' : 'auto').catch(() => {});
    }, wait);
  }

  /** Naloži posnetek v PREVIEW. entryId = vnos v playlisti (če je posnetek iz playliste). */
  async loadPreview(id, entryId = null) {
    const src = this._srcOf(entryId);
    const item = this._slotItem(this._item(id), src);
    this._checkFile(item);
    this.preview = { item, src, seek: this._spec(item, src).inF };
    this.lastError = '';
    this._changed();
    if (this.engine.status !== 'running') return;
    try {
      await this._cue();
    } catch (e) {
      this._error(`Nalaganje v preview ni uspelo: ${e.message}`);
    }
  }

  async clearPreview() {
    this.preview = { item: null, src: null, seek: 0 };
    this.cuedId = null;
    this.autoCuedId = null;
    this._clearImageTimer();
    this._changed();
    if (this.engine.status === 'running') {
      await this.engine.send(`CLEAR ${PREVIEW_CHANNEL}-${LAYER_MAIN}`);
      await this.engine.send(`LOADBG ${PROGRAM_CHANNEL}-${LAYER_MAIN} EMPTY`);
    }
  }

  _onAir(item, src, seekFrames = 0) {
    this._cueGen++;
    this.cuedId = null;
    this.autoCuedId = null;
    this._clearImageTimer();
    const offset = (seekFrames / fpsOf(this.settings.videoMode)) * 1000;
    this.program = { item: { ...item }, startedAt: Date.now() - offset, wallStart: Date.now(), src: src || null };
    this._armEntryActions();
    this.times[PROGRAM_CHANNEL] = null;
    this.lastError = '';
    this._changed();
  }

  /** Preview gre na program. kind: 'cut' ali 'auto'. */
  async take(kind = 'cut') {
    const { item, src } = this.preview;
    if (!item) this._error('Preview je prazen');
    this._requireEngine();
    this._checkFile(item);
    this._clearImageTimer();
    try {
      // Ozadje s samodejnim nadaljevanjem ima pripet prehod, zato CUT v tem primeru pošlje posnetek znova.
      if (kind === 'cut' && this.cuedId === item.id && this.autoCuedId !== item.id) {
        await this.engine.send(`PLAY ${PROGRAM_CHANNEL}-${LAYER_MAIN}`);
      } else {
        await this.engine.send(this._playCommand(item, this.preview.seek || 0, kind === 'auto' ? this.transitionPart() : '', src));
      }
      await this._applyItemVolume(item, kind === 'auto' ? this.settings.transitionFrames : 0);
    } catch (e) {
      this._error(`Prehod ni uspel: ${e.message}`);
    }
    this._onAir(item, src, this.preview.seek || 0);
    await this._afterTake(item, src);
  }

  async _afterTake(item, src) {
    if (this.settings.autoNext || this._programFollows()) {
      const next = this._nextFor(item, src);
      if (next) {
        try {
          await this.loadPreview(next.item.id, next.entryId);
        } catch { /* napaka je že prikazana */ }
        return;
      }
      await this.clearPreview();
      return;
    }
    // Brez samodejnega naslednjega: isti posnetek ostane pripravljen.
    try {
      await this._cue();
    } catch { /* ni kritično */ }
  }

  /** Način brez preview: posnetek gre neposredno na program. */
  async playDirect(id, kind, entryId = null) {
    const src = this._srcOf(entryId);
    const item = this._slotItem(this._item(id), src);
    this._checkFile(item);
    this._requireEngine();
    const k = kind || this.settings.directTake;
    this._clearImageTimer();
    const inF = this._spec(item, src).inF;
    try {
      await this.engine.send(this._playCommand(item, inF, k === 'auto' ? this.transitionPart() : '', src));
      await this._applyItemVolume(item, k === 'auto' ? this.settings.transitionFrames : 0);
    } catch (e) {
      this._error(`Predvajanje ni uspelo: ${e.message}`);
    }
    this._onAir(item, src, inF);
    if (this._programFollows()) {
      await this._afterTake(item, src); // naslednji se pripravi v ozadju in sledi sam
    } else if (this.preview.item) {
      try {
        await this._cue();
      } catch { /* ni kritično */ }
    }
  }

  /** Združljivost s 1. korakom. */
  play(id) {
    return this.playDirect(id, 'cut');
  }

  /** Počisti program. withTransition = zatemnitev s trenutnim trajanjem prehoda. */
  async clearProgram(withTransition = false) {
    this._clearImageTimer();
    clearTimeout(this._endTimer);
    this._endPending = null;
    this.autoCuedId = null;
    this.program = { item: null, startedAt: 0, src: null };
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
        await this._cue();
      } catch { /* ni kritično */ }
    }
  }

  // ---------- akcije ob vnosih ----------

  /** Ko gre vnos na program: akcija ob začetku takoj, akcija ob koncu se pripravi. */
  _armEntryActions() {
    clearTimeout(this._endTimer);
    this._endPending = null;
    const p = this.program;
    if (!this.actions || !p.item || !p.src) return;
    const f = this.playlist.findEntry(p.src.entryId);
    if (!f) return;
    const e = f.entry;
    if (e.startAction) this._runAction(e.startAction, `začetek: ${p.item.name}`);
    if (!e.endAction) return;
    const spec = this._spec(p.item, p.src);
    if (spec.loop) return; // zanka se ne konča
    this._endPending = { entryId: e.id, actionId: e.endAction, lead: e.endLead || 0 };
    this._scheduleImageEnd();
  }

  /** Slika nima časa iz motorja: akcijo ob koncu sproži časovnik (upošteva premor). */
  _scheduleImageEnd() {
    clearTimeout(this._endTimer);
    const p = this.program;
    const pend = this._endPending;
    if (!pend || !p.item || p.item.type !== 'image' || p.paused) return;
    const spec = this._spec(p.item, p.src);
    if (!spec.seconds) return;
    const wait = Math.max(0, (spec.seconds - pend.lead) * 1000 - (Date.now() - p.startedAt));
    this._endTimer = setTimeout(() => this._fireEndAction(), wait);
  }

  _checkEndAction() {
    const pend = this._endPending;
    const p = this.program;
    if (!p.item || !p.src || p.src.entryId !== pend.entryId) return;
    const t = this.times[PROGRAM_CHANNEL];
    if (!t || !t.total) return;
    const spec = this._spec(p.item, p.src);
    const end = spec.outSec || t.total;
    if (t.elapsed >= end - pend.lead - 1 / fpsOf(this.settings.videoMode)) this._fireEndAction();
  }

  _fireEndAction() {
    const pend = this._endPending;
    if (!pend) return;
    this._endPending = null;
    clearTimeout(this._endTimer);
    this._runAction(pend.actionId, `konec: ${this.program.item ? this.program.item.name : ''}`);
  }

  _runAction(id, why) {
    if (!this.actions) return;
    this.actions.run(id, why).catch((e) => {
      this.lastError = e.message;
      this._changed();
    });
  }

  /** Ročni zagon akcije (gumb). */
  async runAction(id) {
    if (!this.actions) this._error('Akcije niso na voljo');
    await this.actions.run(id, 'gumb');
  }

  // ---------- zvok in premikanje po posnetku ----------

  async _applyItemVolume(item, frames = 0) {
    const g = item.muted ? 0 : dbToGain(item.volumeDb);
    const f = Math.max(0, Math.round(Number(frames) || 0));
    await this.engine.send(`MIXER ${PROGRAM_CHANNEL}-${LAYER_MAIN} VOLUME ${g.toFixed(4)}${f ? ` ${f} LINEAR` : ''}`);
  }

  async _applyMaster() {
    const g = this.settings.masterMuted ? 0 : dbToGain(this.settings.masterVolumeDb);
    await this.engine.send(`MIXER ${PROGRAM_CHANNEL} MASTERVOLUME ${g.toFixed(4)}`);
  }

  /** Trenutni položaj preview v sličicah kanala (iz OSC ali zadnjega premika). */
  _previewPosFrames() {
    const t = this.times[PREVIEW_CHANNEL];
    if (t && typeof t.elapsed === 'number' && this.preview.item && this.preview.item.type !== 'image') {
      return Math.round(t.elapsed * fpsOf(this.settings.videoMode));
    }
    return this.preview.seek || 0;
  }

  /** Premik za delta sekund od trenutnega položaja (koraki po sličici ali sekundi). */
  async step(which, deltaSec) {
    const ch = which === 'program' ? PROGRAM_CHANNEL : PREVIEW_CHANNEL;
    const t = this.times[ch];
    const fps = fpsOf(this.settings.videoMode);
    const cur = t ? t.elapsed : (which === 'program' ? 0 : (this.preview.seek || 0) / fps);
    await this.seek(which, cur + Number(deltaSec || 0));
  }

  /** Predvajaj / ustavi. which: 'program' | 'preview'; play: true/false (brez = preklopi). */
  async playPause(which, play) {
    this._requireEngine();
    if (which === 'program') {
      const p = this.program;
      if (!p.item) this._error('Program je prazen');
      const want = play === undefined ? !!p.paused : !!play;
      if (want && p.paused) {
        await this.engine.send(`RESUME ${PROGRAM_CHANNEL}-${LAYER_MAIN}`);
        p.startedAt += Date.now() - p.pausedAt;
        p.paused = false;
        p.pausedAt = 0;
        if (p.item.type === 'image' && this._autoFollowMode() === 'timer') this._startImageTimer();
        this._scheduleImageEnd();
      } else if (!want && !p.paused) {
        await this.engine.send(`PAUSE ${PROGRAM_CHANNEL}-${LAYER_MAIN}`);
        p.paused = true;
        p.pausedAt = Date.now();
        this._clearImageTimer();
        clearTimeout(this._endTimer);
      }
    } else {
      const v = this.preview;
      if (!v.item || v.item.type === 'image') this._error('V preview ni videa');
      const want = play === undefined ? !v.playing : !!play;
      await this.engine.send(`${want ? 'RESUME' : 'PAUSE'} ${PREVIEW_CHANNEL}-${LAYER_MAIN}`);
      v.playing = want;
      if (!want) v.seek = this._previewPosFrames();
    }
    this._changed();
  }

  /** Premik po posnetku. ch 'program' = takoj na izhodu, 'preview' = začetna točka za naslednji preklop. */
  async seek(which, seconds) {
    this._requireEngine();
    const fps = fpsOf(this.settings.videoMode);
    const slot = which === 'program' ? this.program : this.preview;
    if (!slot.item || slot.item.type === 'image') this._error('Ni posnetka za premik');
    const t = this.times[which === 'program' ? PROGRAM_CHANNEL : PREVIEW_CHANNEL];
    let sec = Math.max(0, Number(seconds) || 0);
    if (t && t.total) sec = Math.min(sec, Math.max(0, t.total - 0.1));
    const sp = this._spec(slot.item, slot.src);
    if (which === 'program' && sp.outSec) sec = Math.min(sec, Math.max(0, sp.outSec - 0.1));
    const frames = Math.round(sec * fps);
    if (which === 'program') {
      await this.engine.send(`CALL ${PROGRAM_CHANNEL}-${LAYER_MAIN} SEEK ${frames}`);
      this.program.startedAt = Date.now() - sec * 1000;
      if (this.program.paused) this.program.pausedAt = Date.now();
    } else {
      this.preview.seek = frames;
      await this._cue();
    }
  }

  // ---------- panika ----------

  /** Panika: program takoj na črno (ali logo) in brez zvoka. Posnetek pod tem teče naprej. */
  async setPanic(on) {
    this.panic = !!on;
    this._changed();
    if (this.engine.status !== 'running') return; // ob zagonu motorja se nastavi samo
    try {
      await this._applyPanic();
    } catch (e) {
      this._error(`Panika ni uspela: ${e.message}`);
    }
  }

  async _applyPanic() {
    const ch = PROGRAM_CHANNEL;
    if (this.panic) {
      await this.engine.send(`PLAY ${ch}-${LAYER_PANIC_BG} #FF000000`);
      await this.engine.send(`MIXER ${ch} MASTERVOLUME 0`);
      const logo = this.settings.panicSource && this.library.items.find((x) => x.id === this.settings.panicSource);
      if (logo && fs.existsSync(logo.path)) {
        const vf = this._fitFilter(logo);
        await this.engine.send(`PLAY ${ch}-${LAYER_PANIC} ${quote(mediaPath(this._playPath(logo)))}${vf ? ` VF ${quote(vf)}` : ''}${logo.type === 'image' ? '' : ' LOOP'}`);
      } else {
        await this.engine.send(`CLEAR ${ch}-${LAYER_PANIC}`);
      }
    } else {
      await this.engine.send(`CLEAR ${ch}-${LAYER_PANIC}`);
      await this.engine.send(`CLEAR ${ch}-${LAYER_PANIC_BG}`);
      await this._applyMaster();
    }
  }

  // ---------- motor: obnova, monitorji, čas ----------

  async _onEngineReady() {
    this._lastPgmPath = null;
    await this._addMonitors();
    if (!this.panic) await this._applyMaster().catch(() => {});
    if (this.panic) {
      try {
        await this._applyPanic();
      } catch (e) {
        this.engine._log(`Panike ni bilo mogoče obnoviti: ${e.message}`);
      }
    }
    await this._restoreProgram();
    if (this.preview.item) {
      try {
        await this._cue();
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
    const fm = /^\/channel\/(\d+)\/stage\/layer\/10\/foreground\/file\/streams\/0\/fps$/.exec(address);
    if (fm) {
      const fps = args[1] ? args[0] / args[1] : args[0];
      const c = Number(fm[1]);
      if (fps > 0 && fps < 200) {
        this.clipFps[c] = fps;
        const slot = c === PROGRAM_CHANNEL ? this.program : this.preview;
        if (slot.item && slot.item.fps !== fps) {
          slot.item.fps = fps;
          const it = this.library.items.find((x) => x.id === slot.item.id);
          if (it && it.fps !== fps) {
            it.fps = fps;
            writeJson(this.libraryFile, this.library);
          }
        }
      }
      return;
    }
    const m = /^\/channel\/(\d+)\/stage\/layer\/(\d+)\/foreground\/file\/(time|path)$/.exec(address);
    if (!m || Number(m[2]) !== LAYER_MAIN) return;
    const ch = Number(m[1]);
    if (ch !== PROGRAM_CHANNEL && ch !== PREVIEW_CHANNEL) return;
    if (m[3] === 'path') {
      if (ch === PROGRAM_CHANNEL) this._onProgramPath(args[0]);
      return;
    }
    const [elapsed, total] = args;
    if (typeof elapsed !== 'number') return;
    const prev = this.times[ch];
    // Isti posnetek dvakrat zapored: pot se ne spremeni, čas pa skoči na začetek.
    if (ch === PROGRAM_CHANNEL && this.autoCuedId && prev && prev.total && prev.elapsed > prev.total - 1.5 && elapsed < 0.5
      && this.preview.item && this.program.item && samePath(this._playPath(this.preview.item), this._playPath(this.program.item))) {
      this._autoAdvanced();
    }
    this.times[ch] = { elapsed, total: typeof total === 'number' ? total : 0, fps: this.clipFps[ch] || 0 };
    if (ch === PROGRAM_CHANNEL && this._endPending) this._checkEndAction();
    const now = Date.now();
    if (now - this._timeEmitAt > 200) {
      this._timeEmitAt = now;
      this.emit('times', this.times);
    }
  }

  /** Motor je sam zagnal naslednji posnetek (samodejno nadaljevanje skupine). */
  _onProgramPath(p) {
    if (typeof p !== 'string' || p === this._lastPgmPath) return;
    this._lastPgmPath = p;
    const v = this.preview.item;
    if (!this.autoCuedId || !v || v.id !== this.autoCuedId) return;
    if (this.program.item && samePath(this._playPath(this.program.item), p)) return;
    if (!samePath(this._playPath(v), p)) return;
    this._autoAdvanced();
  }

  _autoAdvanced() {
    const { item, src } = this.preview;
    this.engine._log(`Samodejno naprej: ${item.name}`);
    this._onAir(item, src, this.preview.seek || 0);
    this._applyItemVolume(item, 4).catch(() => {});
    this._afterTake(item, src).catch(() => {});
  }

  /** Po ponovnem zagonu motorja vrnemo na program, kar je bilo tam. */
  async _restoreProgram() {
    const p = this.program;
    if (!p.item) return;
    try {
      const spec = this._spec(p.item, p.src);
      let seek = spec.inF;
      if (!spec.loop && p.item.type !== 'image') {
        seek = ((Date.now() - p.startedAt) / 1000) * fpsOf(this.settings.videoMode);
      }
      p.wallStart = Date.now();
      if (p.paused) seek = ((p.pausedAt - p.startedAt) / 1000) * fpsOf(this.settings.videoMode);
      await this.engine.send(this._playCommand(p.item, seek, '', p.src));
      if (p.paused) await this.engine.send(`PAUSE ${PROGRAM_CHANNEL}-${LAYER_MAIN}`);
      await this._applyItemVolume(p.item, 0);
    } catch (e) {
      this.lastError = `Obnovitev programa ni uspela: ${e.message}`;
      this._changed();
    }
  }
}

const MIN_DB = -40;
function clampDb(v, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(MIN_DB, Math.min(10, Math.round(n * 2) / 2));
}
/** dB v linearno jakost; -40 dB pomeni utišano. */
function dbToGain(db) {
  const d = Number(db) || 0;
  return d <= MIN_DB ? 0 : Math.pow(10, d / 20);
}

/** Primerjava poti ne glede na velike črke, poševnice in končnico (motor jih lahko vrne drugače). */
function samePath(a, b) {
  const n = (p) => String(p).replace(/\\/g, '/').replace(/\.[^./]*$/, '').toLowerCase();
  return n(a) === n(b);
}

module.exports = { Controller, fpsOf, samePath, dbToGain, PROGRAM_CHANNEL, PREVIEW_CHANNEL, LAYER_MAIN, MONITOR_CONSUMER, TRANSITIONS };
