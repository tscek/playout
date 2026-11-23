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
const { installTitleMethods } = require('./controller-titles');
const { ProjectStore, scanMedia, freeName, safeFolderName, safeRelFolder, isInside, toRel } = require('./projects');

const PROGRAM_CHANNEL = 1;
const PREVIEW_CHANNEL = 2;
const LAYER_MAIN = 10;
const LAYER_BLUR = 9; // zamegljeno ozadje slike (slideshow)
const LAYER_PANIC_BG = 990; // črna podlaga za paniko
const LAYER_PANIC = 991; // logo za paniko
const MONITOR_CONSUMER = 900;
const LAYER_OVL = [20, 40]; // plasti vnosa; na programu se skupini menjata ob vsakem preklopu (za preliv)
const MAX_OVL = 16;
const COLOR_DEFAULT = { opacity: 1, brightness: 1, contrast: 1, saturation: 1 }; // številka "consumerja" za monitor v vmesniku

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
  lanRemote: false, // tablica prek omrežja
  lanPin: '', // 6 številk
  keyOutput: '', // key & fill: zaslon za KEY (črno-belo prosojnost); '' = brez, 'test' = testno okno
  masterVolumeDb: 0, // glavni fader programa v dB
  masterMuted: false,
  fadeSeconds: 0.5, // privzeti fade na začetku in koncu vnosa (0 = brez)
  hotkeys: null, // { ukaz: 'Ctrl+F1', ... }; null = privzete
  globalHotkeys: false, // bližnjice delujejo tudi, ko okno ni v ospredju
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
  constructor({ engine, dataDir, listDisplays, templateDir, monitors = null, osc = null, actions = null, trashItem = null }) {
    super();
    this.trashItem = trashItem; // premik datoteke v koš (Electron shell.trashItem)
    this.monitors = monitors; // { 1: ChannelMonitor, 2: ChannelMonitor }
    this.actions = actions; // shranjene akcije (ATEM, XR18, HTTP, OSC)
    if (actions) {
      actions.on('changed', () => this._changed());
      actions.on('live', (id, live) => this.emit('devLive', { id, live }));
      actions.local = (step) => this._actionLocalStep(step); // koraki, ki jih izvede Playout sam (napisi)
    }
    this.osc = osc;
    this.engine = engine;
    this.dataDir = dataDir;
    this.listDisplaysFn = listDisplays;
    this.templateDir = templateDir;

    this.settingsFile = path.join(dataDir, 'settings.json');
    this.stillDir = path.join(dataDir, 'stills'); // kopije slik za predvajanje s prileganjem

    const saved = readJson(this.settingsFile, {});
    if (!saved.settingsVersion && saved.programOutput === 'test') saved.programOutput = 'auto'; // v0.1.0 je imel privzeto testno okno
    this.settings = { ...DEFAULT_SETTINGS, ...saved, settingsVersion: 2 };
    this.settings.hotkeys = normHotkeys(this.settings.hotkeys);
    this.displays = [];
    this.audioDevices = [];
    this.projects = new ProjectStore(dataDir);
    this.projects.ensure({ panicSource: this.settings.panicSource || '' });
    this.copying = null; // { name, done, total } med kopiranjem v projektno mapo
    this.folders = [];
    this.folderError = '';
    this._initTitles();
    this._openProject(this.projects.currentId);
    this._ovl = { 1: { bank: 0, ids: [], keys: [] }, 2: { bank: 0, ids: [], keys: [] } }; // plasti na kanalu
    this._ovlGen = 0;
    this._baseMix = {}; // zadnje poslane barve osnovnega posnetka po kanalih
    this._blur = {}; // kanal -> pot slike, ki je zamegljena v ozadju (plast 9)
    this._blurBg = null; // zamegljeno ozadje, pripravljeno v ozadju programa (za takojšen CUT)
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
      keyOutputResolved: this.resolvedKeyOutput(),
      keyWarning: this.keyWarning(),
      library: this.library.items.map((it) => ({ ...it, missing: !fileExists(it.path) })),
      program: this.program.item
        ? { id: this.program.item.id, name: this.program.item.name, type: this.program.item.type, loop: !!this.program.item.loop,
          volumeDb: this.program.item.volumeDb || 0, muted: !!this.program.item.muted, ...this._specState(this.program.item, this.program.src),
          paused: !!this.program.paused, pausedAt: this.program.pausedAt || 0, now: Date.now(), startedAt: this.program.startedAt, src: this.program.src,
          layers: ((this._entryOf(this.program.src) || {}).layers || []) }
        : null,
      preview: this.preview.item
        ? { id: this.preview.item.id, name: this.preview.item.name, type: this.preview.item.type, loop: !!this.preview.item.loop,
          volumeDb: this.preview.item.volumeDb || 0, muted: !!this.preview.item.muted, ...this._specState(this.preview.item, this.preview.src),
          playing: !!this.preview.playing, fit: this.preview.item.fit || 'fit', zoom: this.preview.item.zoom || 1,
          posX: this.preview.item.posX || 0, posY: this.preview.item.posY || 0, width: this.preview.item.width || 0, height: this.preview.item.height || 0, src: this.preview.src,
          opacity: this.preview.item.opacity ?? 1, brightness: this.preview.item.brightness ?? 1, contrast: this.preview.item.contrast ?? 1, saturation: this.preview.item.saturation ?? 1,
          layers: ((this._entryOf(this.preview.src) || {}).layers || []), autoFollow: this.autoCuedId ? 'end' : this.imageTimer ? 'timer' : null }
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
      project: this.projectState(),
      titles: this.titlesState(),
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

  /** Zaslon za KEY ali '' (brez), 'test'. Isti zaslon kot PROGRAM ni dovoljen. */
  resolvedKeyOutput() {
    const k = this.settings.keyOutput;
    if (!k) return '';
    if (k === 'test') return 'test';
    if (!this.displays.some((x) => x.device === k)) return '';
    return k === this.resolvedOutput() ? '' : k;
  }

  keyWarning() {
    const k = this.settings.keyOutput;
    if (!k || k === 'test') return '';
    if (!this.displays.some((x) => x.device === k)) return 'Zaslon za KEY ni priklopljen – key izhod je izklopljen.';
    if (k === this.resolvedOutput()) return 'KEY in PROGRAM ne moreta biti na istem zaslonu – key izhod je izklopljen.';
    return '';
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
    // Key & fill: PROGRAM je "fill", na drugem zaslonu gre "key" (prosojnost kot črno-bela slika).
    const key = this.resolvedKeyOutput();
    if (key === 'test') screens.push({ windowedTest: true, testX: 1020, keyOnly: true, name: 'Playout KEY (testno okno)' });
    else if (key) screens.push({ display: this.displays.find((x) => x.device === key), keyOnly: true, name: 'Playout KEY' });
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
    this._installTemplates();
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
    const allowed = ['videoMode', 'programOutput', 'audioDevice', 'audioDelayFrames', 'keyOutput'];
    const operational = ['transitionType', 'transitionFrames', 'transitionDirection', 'previewMode', 'directTake', 'autoNext', 'panicSource', 'masterVolumeDb', 'masterMuted', 'fadeSeconds', 'hotkeys', 'globalHotkeys', 'lanRemote', 'lanPin'];
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
    if (typeof next.keyOutput !== 'string') next.keyOutput = '';
    next.masterVolumeDb = clampDb(next.masterVolumeDb, 0);
    next.masterMuted = !!next.masterMuted;
    next.hotkeys = normHotkeys(next.hotkeys);
    next.globalHotkeys = !!next.globalHotkeys;
    next.lanRemote = !!next.lanRemote;
    if (next.lanPin === 'new' || (next.lanRemote && !/^\d{6}$/.test(String(next.lanPin || '')))) {
      next.lanPin = String(require('crypto').randomInt(0, 1000000)).padStart(6, '0');
    }
    if (!/^\d{6}$/.test(String(next.lanPin || ''))) next.lanPin = '';
    next.fadeSeconds = Math.max(0, Math.min(10, Math.round((Number(next.fadeSeconds) || 0) * 100) / 100));
    const masterChanged = next.masterVolumeDb !== this.settings.masterVolumeDb || next.masterMuted !== this.settings.masterMuted;
    const panicChanged = next.panicSource !== this.settings.panicSource;
    const transitionChanged = ['transitionType', 'transitionFrames', 'transitionDirection'].some((k) => next[k] !== this.settings[k]);

    const engineRelevant = allowed.some((k) => next[k] !== this.settings[k]);
    this.settings = next;
    writeJson(this.settingsFile, this.settings);
    if (panicChanged && this.project) {
      this.project.panicSource = next.panicSource;
      this._saveProjectMeta();
    }
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
    return this.setEntryLook(slot.src.entryId, patch);
  }

  /** Slika, barve, zvok vnosa v playlisti; kjer je vnos v preview ali na programu, velja takoj. */
  async setEntryLook(entryId, patch) {
    const f = this.playlist.findEntry(entryId);
    if (!f) this._error('Vnos ne obstaja');
    const p = { ...(patch || {}) };
    this.playlist.setEntry(entryId, p);
    this._savePlaylist();
    const lib = this.library.items.find((x) => x.id === f.entry.mediaId);
    if (!lib) return;
    if (!lib.width && lib.type !== 'audio' && ('fit' in p || 'zoom' in p || 'posX' in p || 'posY' in p || p.reset)) this._probe(lib);
    for (const s of [this.preview, this.program]) {
      if (s.item && s.src && s.src.entryId === entryId) s.item = this._slotItem(lib, s.src);
    }
    if (this.engine.status !== 'running') return;
    if (('volumeDb' in p || 'muted' in p) && this.program.src && this.program.src.entryId === entryId) {
      await this._applyItemVolume(this.program.item, 0);
    }
    if (Object.keys(COLOR_DEFAULT).some((k) => k in p) || p.resetColor) {
      for (const [ch, sl] of [[PROGRAM_CHANNEL, this.program], [PREVIEW_CHANNEL, this.preview]]) {
        if (sl.src && sl.src.entryId === entryId) await this._applyBaseMix(ch, sl.item, ch === PROGRAM_CHANNEL ? 4 : 0);
      }
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
    for (const k of Object.keys(COLOR_DEFAULT)) out[k] = e[k] === undefined ? COLOR_DEFAULT[k] : e[k];
    delete out.fit;
    if (e.fit) out.fit = e.fit;
    else if (f && f.group.blur && item.type === 'image') out.fit = 'blur';
    out.kenBurns = !!(f && f.group.kenBurns && item.type === 'image');
    if (out.kenBurns) {
      out.kbIndex = f.group.items.indexOf(f.entry); // smer zooma se menja od slike do slike
      out.kbSeconds = (e.seconds || f.group.imageSeconds || 5) + (Number(this.settings.transitionFrames) || 0) / fpsOf(this.settings.videoMode);
    }
    delete out.inSec;
    delete out.outSec;
    return out;
  }

  /** v0.7.0: nastavitve, ki so bile shranjene k mediju, gredo k vsem njegovim vnosom v playlisti. */
  _migrateLook() {
    let moved = false;
    for (const it of this.library.items) {
      const look = {};
      if ('loop' in it) {
        // v0.8.0: ponavljanje je samo še pri vnosu ("ponavljaj posnetek")
        if (it.loop) for (const g of this.playlist.groups) for (const e of g.items) if (e.mediaId === it.id && !e.end) e.end = 'loop';
        delete it.loop;
        moved = true;
      }
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

  // ---------- projekti ----------

  /** Naloži projekt (seznam medijev, playlisto, mapo). Ne dotika se programa in preview. */
  _openProject(id) {
    this._unwatch();
    const dir = this.projects.dir(id);
    this.projectId = id;
    this.project = this.projects.meta(id);
    this.libraryFile = path.join(dir, 'library.json');
    this.playlistFile = path.join(dir, 'playlist.json');
    this.library = readJson(this.libraryFile, { items: [] });
    if (!Array.isArray(this.library.items)) this.library.items = [];
    this.playlist = new Playlist(readJson(this.playlistFile, null));
    this._migrateLook();
    this._openTitles(dir);
    this.settings.panicSource = this.project.panicSource || '';
    this.folders = [];
    this.folderError = '';
    this._resolvePaths();
    this._rescan();
    this._watch();
  }

  _saveProjectMeta() {
    this.projects.saveMeta(this.projectId, this.project);
  }

  /** Poti medijev iz projektne mape (rel) so vedno glede na trenutno mapo. */
  _resolvePaths() {
    const dir = this.project.mediaDir;
    for (const it of this.library.items) {
      if (it.rel && dir) it.path = path.join(dir, ...it.rel.split('/'));
      else if (!it.rel && dir && it.path && isInside(dir, it.path)) it.rel = toRel(dir, it.path);
    }
  }

  _watch() {
    const dir = this.project.mediaDir;
    if (!dir) return;
    try {
      this._watcher = fs.watch(dir, { recursive: true }, () => this._scheduleRescan());
      this._watcher.on('error', () => {});
      if (this._watcher.unref) this._watcher.unref();
    } catch {
      this._watcher = null; // spremljanje ni na voljo: ostane redno preverjanje
    }
    this._rescanInterval = setInterval(() => this._scheduleRescan(0), 15000);
    if (this._rescanInterval.unref) this._rescanInterval.unref();
  }

  _unwatch() {
    if (this._watcher) {
      try { this._watcher.close(); } catch { /* ni pomembno */ }
    }
    this._watcher = null;
    clearInterval(this._rescanInterval);
    clearTimeout(this._rescanDebounce);
  }

  _scheduleRescan(delay = 500) {
    clearTimeout(this._rescanDebounce);
    this._rescanDebounce = setTimeout(() => {
      try {
        if (this._rescan()) this._changed();
      } catch { /* naslednjič */ }
    }, delay);
    if (this._rescanDebounce.unref) this._rescanDebounce.unref();
  }

  /**
   * Uskladi seznam medijev s projektno mapo: nove datoteke doda, premaknjene/preimenovane poveže
   * (po imenu in velikosti), izbrisane odstrani (če niso v playlisti; sicer so označene kot manjkajoče).
   * Vrne true, če se je kaj spremenilo.
   */
  _rescan() {
    const dir = this.project.mediaDir;
    if (!dir) {
      const had = this.folders.length || this.folderError;
      this.folders = [];
      this.folderError = '';
      return !!had;
    }
    let scan;
    try {
      scan = scanMedia(dir);
    } catch {
      const msg = `Projektne mape ni mogoče prebrati: ${dir}`;
      const changed = this.folderError !== msg;
      this.folderError = msg;
      return changed;
    }
    let changed = !!this.folderError || JSON.stringify(scan.folders) !== JSON.stringify(this.folders);
    this.folderError = '';
    this.folders = scan.folders;
    const key = (r) => r.toLowerCase();
    const byRel = new Map();
    for (const it of this.library.items) if (it.rel) byRel.set(key(it.rel), it);
    const seen = new Set();
    const fresh = [];
    for (const f of scan.files) {
      const it = byRel.get(key(f.rel));
      if (!it) {
        fresh.push(f);
        continue;
      }
      seen.add(it);
      if (it.rel !== f.rel || it.size !== f.size || it.mtimeMs !== f.mtimeMs || it.path !== f.abs) {
        Object.assign(it, { rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, path: f.abs });
        changed = true;
      }
    }
    // Manjkajoči: iz mape, ki jih ni več, in zunanji, katerih datoteke ni (npr. projekt z drugega računalnika).
    const lost = this.library.items.filter((it) => (it.rel ? !seen.has(it) : !fs.existsSync(it.path)));
    for (const f of fresh) {
      const name = path.basename(f.abs);
      const same = lost.filter((it) => it.name.toLowerCase() === name.toLowerCase());
      const match = same.find((it) => it.size && it.size === f.size) || (same.length === 1 ? same[0] : null);
      if (match) {
        Object.assign(match, { rel: f.rel, path: f.abs, size: f.size, mtimeMs: f.mtimeMs, name });
        lost.splice(lost.indexOf(match), 1);
      } else {
        const item = makeItem(f.abs);
        if (!item) continue;
        Object.assign(item, { rel: f.rel, size: f.size, mtimeMs: f.mtimeMs });
        this._probe(item);
        this.library.items.push(item);
      }
      changed = true;
    }
    const used = new Set(this.playlist.groups.flatMap((g) => g.items.flatMap((e) => [e.mediaId, ...(e.layers || []).map((l) => l.mediaId)])));
    if (this.settings.panicSource) used.add(this.settings.panicSource);
    for (const s of [this.program, this.preview]) if (s && s.item) used.add(s.item.id);
    const drop = new Set(lost.filter((it) => it.rel && !used.has(it.id)));
    if (drop.size) {
      this.library.items = this.library.items.filter((it) => !drop.has(it));
      changed = true;
    }
    if (changed) writeJson(this.libraryFile, this.library);
    return changed;
  }

  /** Projekti za vmesnik. */
  projectState() {
    return {
      id: this.projectId,
      name: this.project.name,
      mediaDir: this.project.mediaDir,
      folders: this.folders,
      folderError: this.folderError,
      copying: this.copying,
      list: this.projects.list(),
    };
  }

  _requireIdle(what) {
    if (this.program.item && !this.panic) this._error(`${what} ni mogoče, ko je kaj na programu. Najprej počisti program.`);
  }

  /** Odpre drug projekt. Program in preview se počistita. */
  async switchProject(id) {
    if (id === this.projectId) return;
    if (!this.projects.has(id)) this._error('Projekt ne obstaja');
    await this._clearAll();
    this.projects.setCurrent(id);
    this._openProject(id);
    if (this.panic && this.engine.status === 'running') await this._applyPanic().catch(() => {});
    this._changed();
  }

  async _clearAll() {
    await this._clearTitles();
    if (this.engine.status === 'running') {
      if (this.program.item) await this.clearProgram(false).catch(() => {});
      if (this.preview.item) await this.clearPreview().catch(() => {});
    }
    this.program = { item: null, startedAt: 0, src: null };
    this.preview = { item: null, src: null, seek: 0 };
    this.cuedId = null;
    this.autoCuedId = null;
    this._clearImageTimer();
  }

  async createProject(name, mediaDir = null) {
    const id = this.projects.create(name, mediaDir || null);
    await this.switchProject(id);
    return id;
  }

  renameProject(id, name) {
    const nm = String(name || '').trim();
    if (!nm) this._error('Vpiši ime projekta');
    const meta = this.projects.meta(id);
    meta.name = nm;
    this.projects.saveMeta(id, meta);
    if (id === this.projectId) this.project.name = nm;
    this._changed();
  }

  removeProject(id) {
    this.projects.remove(id);
    this._changed();
  }

  /** Nastavi medijsko mapo projekta. */
  setMediaDir(dir) {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) this._error('Mapa ne obstaja');
    this._unwatch();
    // Zunanji posnetki, ki so v novi mapi, dobijo relativno pot; ostali iz stare mape postanejo zunanji.
    for (const it of this.library.items) if (it.rel && !isInside(dir, it.path)) delete it.rel;
    this.project.mediaDir = dir;
    this._saveProjectMeta();
    this._resolvePaths();
    writeJson(this.libraryFile, this.library);
    this._rescan();
    this._watch();
    this._changed();
  }

  _folderAbs(rel) {
    if (!this.project.mediaDir) this._error('Projekt nima izbrane medijske mape (Projekt → Medijska mapa)');
    const r = safeRelFolder(rel);
    return path.join(this.project.mediaDir, ...r.split('/').filter(Boolean));
  }

  /** Nova podmapa v projektni mapi. */
  createFolder(parentRel, name) {
    const dir = path.join(this._folderAbs(parentRel), safeFolderName(name));
    if (fs.existsSync(dir)) this._error('Mapa s tem imenom že obstaja');
    fs.mkdirSync(dir, { recursive: true });
    this._rescan();
    this._changed();
    return toRel(this.project.mediaDir, dir);
  }

  /**
   * Doda datoteke: s projektno mapo jih kopira vanjo (v podmapo folderRel), sicer jih samo doda na seznam.
   * Mape se kopirajo z vsebino (samo medijske datoteke).
   */
  async importFiles(paths, folderRel = '') {
    const list = (paths || []).filter(Boolean);
    if (!this.project.mediaDir) return this.addFiles(list);
    const target = this._folderAbs(folderRel);
    const jobs = []; // [src, destDir]
    for (const p of list) {
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (isInside(this.project.mediaDir, p) || path.resolve(p) === path.resolve(this.project.mediaDir)) continue;
        const destRoot = path.join(target, path.basename(p));
        for (const f of scanMedia(p).files) jobs.push([f.abs, path.dirname(path.join(destRoot, ...f.rel.split('/')))]);
      } else if (makeItem(p)) {
        if (isInside(this.project.mediaDir, p)) continue; // že v mapi
        jobs.push([p, target]);
      }
    }
    if (!jobs.length) {
      this._rescan();
      this._changed();
      return 0;
    }
    let done = 0;
    try {
      for (const [src, destDir] of jobs) {
        this.copying = { name: path.basename(src), done, total: jobs.length };
        this._changed();
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, freeName(destDir, path.basename(src)));
        const tmp = `${dest}.kopiram`;
        await fs.promises.copyFile(src, tmp);
        await fs.promises.rename(tmp, dest);
        done++;
      }
    } catch (e) {
      this._error(`Kopiranje v projektno mapo ni uspelo: ${e.message}`);
    } finally {
      this.copying = null;
      this._rescan();
      this._changed();
    }
    return done;
  }

  /** Premakne datoteko v drugo podmapo projektne mape (tudi na disku). */
  async moveMedia(id, folderRel) {
    const it = this._item(id);
    if (!it.rel) this._error('Premikati je mogoče samo datoteke iz projektne mape');
    const destDir = this._folderAbs(folderRel);
    if (path.resolve(path.dirname(it.path)) === path.resolve(destDir)) return;
    if ((this.program.item && this.program.item.id === id) || (this.preview.item && this.preview.item.id === id)) {
      this._error('Posnetek je na programu ali v preview. Premakni ga, ko ni v uporabi.');
    }
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, freeName(destDir, path.basename(it.path)));
    try {
      await fs.promises.rename(it.path, dest);
    } catch (e) {
      if (e.code === 'EXDEV') {
        await fs.promises.copyFile(it.path, dest);
        await fs.promises.unlink(it.path);
      } else if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) {
        this._error('Datoteke ni mogoče premakniti, ker jo uporablja drug program.');
      } else this._error(`Premik ni uspel: ${e.message}`);
    }
    it.rel = toRel(this.project.mediaDir, dest);
    it.path = dest;
    it.name = path.basename(dest);
    writeJson(this.libraryFile, this.library);
    this._rescan();
    this._changed();
  }

  /** Datoteko iz projektne mape premakne v koš; zunanjo samo odstrani s seznama. Odstrani jo tudi iz playliste. */
  async removeItem(id) {
    const it = this._item(id);
    if ((this.program.item && this.program.item.id === id) || (this.preview.item && this.preview.item.id === id)) {
      this._error('Posnetek je na programu ali v preview. Najprej ga počisti.');
    }
    if (it.rel && fs.existsSync(it.path)) {
      if (!this.trashItem) this._error('Brisanje datotek ni na voljo');
      try {
        await this.trashItem(it.path);
      } catch (e) {
        this._error(`Datoteke ni bilo mogoče premakniti v koš: ${e.message}`);
      }
    }
    this.library.items = this.library.items.filter((x) => x.id !== id);
    this.playlist.removeMedia(id);
    this.titles.forgetMedia(id);
    this._saveTitles();
    if (this.project.brand && this.project.brand.logo === id) {
      this.project.brand.logo = null;
      this._saveProjectMeta();
    }
    if (this.settings.panicSource === id) {
      this.settings.panicSource = '';
      this.project.panicSource = '';
      this._saveProjectMeta();
    }
    writeJson(this.playlistFile, this.playlist.toJSON());
    this._saveLibrary();
  }

  /** Izvoz projekta v majhno datoteko (brez medijev; poti glede na projektno mapo). */
  exportProject(file) {
    const data = {
      format: 'playout-project',
      version: 1,
      name: this.project.name,
      exportedAt: new Date().toISOString(),
      mediaDirName: this.project.mediaDir ? path.basename(this.project.mediaDir) : null,
      panicSource: this.settings.panicSource || '',
      library: this.library.items.map((it) => {
        const o = { id: it.id, name: it.name, type: it.type };
        if (it.rel) o.rel = it.rel;
        else o.path = it.path;
        for (const k of ['size', 'width', 'height']) if (it[k]) o[k] = it[k];
        return o;
      }),
      playlist: this.playlist.toJSON(),
      titles: this.titles.toJSON(),
      brand: this.project.brand,
      actions: this.actions ? { devices: this.actions.devices, actions: this.actions.actions } : null,
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return file;
  }

  /** Uvoz projekta: nov projekt z medijsko mapo mediaDir; posnetki se povežejo po poti ali imenu. */
  async importProject(file, mediaDir) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this._error('Datoteke projekta ni mogoče prebrati');
    }
    if (!data || data.format !== 'playout-project') this._error('To ni datoteka projekta Playout');
    if (mediaDir && (!fs.existsSync(mediaDir) || !fs.statSync(mediaDir).isDirectory())) this._error('Medijska mapa ne obstaja');
    const id = this.projects.create(data.name || path.basename(file, path.extname(file)), mediaDir || null);
    const dir = this.projects.dir(id);
    const items = (Array.isArray(data.library) ? data.library : [])
      .filter((it) => it && typeof it.id === 'string' && (it.rel || it.path))
      .map((it) => {
        const o = { id: it.id, name: String(it.name || ''), type: it.type };
        if (it.rel && mediaDir) {
          o.rel = safeRelFolder(it.rel);
          o.path = path.join(mediaDir, ...o.rel.split('/'));
        } else o.path = it.path || it.rel;
        if (!o.name) o.name = path.basename(o.path);
        for (const k of ['size', 'width', 'height']) if (it[k]) o[k] = it[k];
        return o;
      });
    writeJson(path.join(dir, 'library.json'), { items });
    writeJson(path.join(dir, 'playlist.json'), data.playlist || null);
    const meta = this.projects.meta(id);
    meta.panicSource = typeof data.panicSource === 'string' ? data.panicSource : '';
    if (data.brand) meta.brand = data.brand;
    this.projects.saveMeta(id, meta);
    if (data.titles) writeJson(path.join(dir, 'titles.json'), data.titles);
    // Akcije in naprave, ki jih na tem računalniku še ni, se dodajo (IP naslove popraviš v Akcijah).
    if (this.actions && data.actions) {
      for (const d of data.actions.devices || []) {
        if (d && d.id && !this.actions.devices.some((x) => x.id === d.id)) await this.actions.saveDevice(d).catch(() => {});
      }
      for (const a of data.actions.actions || []) {
        if (a && a.id && !this.actions.actions.some((x) => x.id === a.id)) {
          try { this.actions.saveAction(a); } catch { /* ni kritično */ }
        }
      }
    }
    await this.switchProject(id);
    const missing = this.library.items.filter((it) => !fs.existsSync(it.path)).length;
    return { id, missing };
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
    for (const sl of [this.preview, this.program]) {
      if (sl.item && sl.src && sl.src.groupId === groupId) sl.item = this._slotItem(this._item(sl.item.id), sl.src);
    }
    if (patch && ['blur', 'kenBurns', 'imageSeconds'].some((k) => k in patch) && this.preview.src && this.preview.src.groupId === groupId && this.engine.status === 'running') {
      this.preview.seek = this._previewPosFrames();
      await this._cue().catch(() => {});
    }
    await this._rearm();
  }

  /**
   * Slideshow: nova skupina s slikami. opts: { name, mediaIds, auto (samodejno naprej), seconds, kenBurns, blur, loop }.
   * Vrne id skupine.
   */
  async createSlideshow(opts = {}) {
    const ids = (opts.mediaIds || []).filter((id) => {
      const it = this.library.items.find((x) => x.id === id);
      return it && it.type === 'image';
    });
    if (!ids.length) this._error('Ni slik za slideshow');
    const g = this.playlist.addGroup(opts.name || `Slideshow ${this.playlist.groups.length + 1}`);
    this.playlist.setGroup(g.id, {
      end: opts.auto === false ? 'stop' : 'mix',
      imageSeconds: opts.seconds || 5,
      kenBurns: opts.kenBurns !== false,
      blur: opts.blur !== false,
      loop: !!opts.loop,
    });
    this.playlist.addMedia(g.id, ids);
    this._savePlaylist();
    await this._rearm();
    return g.id;
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
      loop: end === 'loop',
      inSec: inSec || null,
      outSec: outSec || null,
      inF: inSec ? Math.round(inSec * fps) : 0,
      outF: outSec ? Math.round(outSec * fps) : 0,
      seconds: (e && e.seconds) || (g ? g.imageSeconds : null),
      fadeIn: e && e.fadeIn !== null && e.fadeIn !== undefined ? e.fadeIn : this.settings.fadeSeconds || 0,
      fadeOut: e && e.fadeOut !== null && e.fadeOut !== undefined ? e.fadeOut : this.settings.fadeSeconds || 0,
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
    if (item.fit === 'blur') {
      // Kot "fit", le da so robovi prosojni (pod njimi je zamegljeno ozadje).
      const f = this._fitFilter({ ...item, fit: 'fit' });
      return f ? `format=rgba,${f}` : null;
    }
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

  /**
   * Dinamični zoom (Ken Burns): zoom je del slike same (vsaka slika se približuje po svoje),
   * zato med prelivom prejšnja slika teče naprej in nič ne poskoči. Smer (proti sredini, kotom ...) se menja.
   */
  _kbFilter(item, fit) {
    if (!item.kenBurns || item.type !== 'image') return fit;
    const fps = fpsOf(this.settings.videoMode);
    const N = Math.max(1, Math.round((item.kbSeconds || 5) * fps));
    const Z = 0.12;
    const anchors = [[0.5, 0.5], [0, 0], [1, 1], [1, 0], [0, 1], [0.5, 0.2]];
    const [ax, ay] = anchors[Math.max(0, item.kbIndex || 0) % anchors.length];
    const base = fit || 'scale=1920:1080,setsar=1';
    return `${base},loop=loop=-1:size=1,setpts=N/${fps}/TB,`
      + `scale=w='trunc(1920*(1+${Z}*min(n/${N}\,1))/2)*2':h=-2:eval=frame,`
      + `crop=1920:1080:x='(iw-ow)*${ax}':y='(ih-oh)*${ay}',setsar=1`;
  }

  /** Pot, ki jo dobi motor. Slika s prileganjem gre skozi ffmpeg (kopija s končnico .still). */
  _playPath(item) {
    if (item.type !== 'image' || !(this._fitFilter(item) || item.kenBurns)) return item.path;
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
    const vf = this._kbFilter(item, this._fitFilter(item));
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
    await this._applyBaseMix(PREVIEW_CHANNEL, item, 0);
    await this._syncPreviewLayers(src);
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
    const blur = this._blurArgs(item);
    if (blur && mode !== 'bg') {
      await this.engine.send(`LOADBG ${PROGRAM_CHANNEL}-${LAYER_BLUR} ${blur}`);
      this._blurBg = blur;
    }
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
      await this._syncPreviewLayers(null);
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
    this._armEntryTitle();
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
      const fade = kind === 'cut' ? await this._fadeInPrepare(item, src) : 0;
      if (kind === 'cut' && this.cuedId === item.id && this.autoCuedId !== item.id) {
        await this.engine.send(`PLAY ${PROGRAM_CHANNEL}-${LAYER_MAIN}`);
      } else {
        await this.engine.send(this._playCommand(item, this.preview.seek || 0, kind === 'auto' ? this.transitionPart() : '', src));
      }
      await this._applyItemVolume(item, kind === 'auto' ? this.settings.transitionFrames : fade);
      if (fade) await this._applyBaseMix(PROGRAM_CHANNEL, item, fade);
      await this._layersOnAir(item, src, kind === 'auto' ? this.settings.transitionFrames : 0);
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
      const fade = k === 'auto' ? 0 : await this._fadeInPrepare(item, src);
      await this.engine.send(this._playCommand(item, inF, k === 'auto' ? this.transitionPart() : '', src));
      await this._applyItemVolume(item, k === 'auto' ? this.settings.transitionFrames : fade);
      if (fade) await this._applyBaseMix(PROGRAM_CHANNEL, item, fade);
      await this._layersOnAir(item, src, k === 'auto' ? this.settings.transitionFrames : 0);
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
    this._armEntryTitle();
    this._changed();
    if (this.engine.status !== 'running') return;
    if (withTransition) {
      const dur = Math.max(1, Math.round(Number(this.settings.transitionFrames) || 12));
      await this.engine.send(`PLAY ${PROGRAM_CHANNEL}-${LAYER_MAIN} EMPTY MIX ${dur} LINEAR`);
      await this._layersOut(PROGRAM_CHANNEL, dur);
      await this._blurSync(PROGRAM_CHANNEL, null, dur);
    } else {
      await this.engine.send(`CLEAR ${PROGRAM_CHANNEL}-${LAYER_MAIN}`);
      await this._layersOut(PROGRAM_CHANNEL, 0);
      await this._blurSync(PROGRAM_CHANNEL, null, 0);
    }
    // Ozadje programa je bilo morda izpraznjeno; preview ponovno pripravimo.
    if (this.preview.item) {
      try {
        await this._cue();
      } catch { /* ni kritično */ }
    }
  }

  /** Sličice motorja na sekundo (iz OSC) za prikaz obremenjenosti. */
  engineRate() {
    const now = Date.now();
    const prev = this._rateAt || now;
    const dt = (now - prev) / 1000;
    const ticks = this._ticks || 0;
    this._ticks = 0;
    this._rateAt = now;
    const expected = fpsOf(this.settings.videoMode);
    if (dt < 0.5 || this.engine.status !== 'running') return { fps: null, expected };
    return { fps: Math.round((ticks / dt) * 10) / 10, expected };
  }

  // ---------- ukazi (bližnjice, HTTP, Stream Deck) ----------

  /**
   * Izvede ukaz po imenu: cut, auto, panic, next, prev, clear, fadeclear, pause, action:<id>, group:<id>.
   * Uporabljajo ga globalne bližnjice in HTTP vmesnik.
   */
  async runCommand(cmd) {
    const c = String(cmd || '');
    if (c === 'cut' || c === 'auto') {
      if (this.settings.previewMode === false) this._error('Brez preview: CUT/AUTO prek bližnjice ni mogoč');
      return this.take(c);
    }
    if (c === 'panic') return this.setPanic(!this.panic);
    if (c === 'panicOn') return this.setPanic(true);
    if (c === 'panicOff') return this.setPanic(false);
    if (c === 'next' || c === 'prev') return this.stepPreviewEntry(c === 'next' ? 1 : -1);
    if (c === 'clear') return this.clearProgram(false);
    if (c === 'fadeclear') return this.clearProgram(true);
    if (c === 'pause') return this.playPause('program');
    if (c === 'pvwClear') return this.clearPreview();
    const steps = { stepBackFrame: -1, stepFwdFrame: 1, stepBackSec: -1, stepFwdSec: 1 };
    if (c in steps) {
      const fps = this.clipFps[PREVIEW_CHANNEL] || fpsOf(this.settings.videoMode);
      return this.step('preview', c.endsWith('Sec') ? steps[c] : steps[c] / fps);
    }
    if (c.startsWith('action:')) return this.runAction(c.slice(7));
    if (c.startsWith('preset:')) return this.runAction(c);
    if (c.startsWith('group:')) return this.cueGroup(c.slice(6));
    if (c.startsWith('title:')) return this.titleToggle(c.slice(6));
    if (c === 'titlesOff') return this.titlesAllOff();
    this._error(`Neznan ukaz: ${c}`);
  }

  /** Naslednji/prejšnji vnos playliste v preview (ali prvi, če v preview ni vnosa). */
  async stepPreviewEntry(dir) {
    const flat = this.playlist.flat();
    if (!flat.length) this._error('Playlista je prazna');
    const cur = this.preview.src ? flat.findIndex((x) => x.entry.id === this.preview.src.entryId) : -1;
    const i = cur === -1 ? 0 : Math.max(0, Math.min(flat.length - 1, cur + (dir > 0 ? 1 : -1)));
    const { entry } = flat[i];
    return this.loadPreview(entry.mediaId, entry.id);
  }

  /** Kratko stanje za HTTP vmesnik. */
  briefState() {
    const t = this.times[PROGRAM_CHANNEL];
    const pgm = this.program.item;
    let left = null;
    if (pgm && t && t.total) left = Math.max(0, (this._spec(pgm, this.program.src).outSec || t.total) - t.elapsed);
    return {
      program: pgm ? pgm.name : null,
      preview: this.preview.item ? this.preview.item.name : null,
      remaining: left === null ? null : Math.round(left * 10) / 10,
      panic: this.panic,
      project: this.project.name,
      groups: this.playlist.groups.map((g) => ({ id: g.id, name: g.name })),
      actions: this.actions ? this.actions.actions.map((a) => ({ id: a.id, name: a.name })) : [],
      titles: this.titlesState().items.map((t) => ({ id: t.id, name: t.label, onAir: this._titleOnLayer(t.id) !== null })),
    };
  }

  // ---------- plasti in barve ----------

  _entryOf(src) {
    const f = src ? this.playlist.findEntry(src.entryId) : null;
    return f ? f.entry : null;
  }

  /** Plasti vnosa (od spodaj navzgor) z mediji iz knjižnice. */
  _overlays(src) {
    const e = this._entryOf(src);
    if (!e || !e.layers) return [];
    return e.layers
      .map((l) => ({ l, item: this.library.items.find((x) => x.id === l.mediaId) }))
      .filter((x) => x.item)
      .slice(0, MAX_OVL);
  }

  /** Položaj plasti za MIXER FILL (deli zaslona), razmerje slike ohranjeno. */
  _layerFill(l, item) {
    const W = 1920;
    const H = 1080;
    const z = Number(l.scale) || 1;
    let dw = z;
    let dh = z;
    if (item.width && item.height) {
      const k = Math.min(W / item.width, H / item.height);
      dw = ((item.width * k) / W) * z;
      dh = ((item.height * k) / H) * z;
    }
    const x = 0.5 - dw / 2 + (Number(l.posX) || 0) / 100;
    const y = 0.5 - dh / 2 + (Number(l.posY) || 0) / 100;
    return [x, y, dw, dh];
  }

  /** MIXER ukazi za barve in prosojnost. */
  _colorCmds(ch, L, c, frames = 0, opacity = null) {
    const t = frames ? ` ${Math.round(frames)} LINEAR` : '';
    const f = (v) => Number(v).toFixed(4);
    const o = opacity === null ? (c.opacity === undefined ? 1 : c.opacity) : opacity;
    return [
      `MIXER ${ch}-${L} OPACITY ${f(o)}${t}`,
      `MIXER ${ch}-${L} BRIGHTNESS ${f(c.brightness === undefined ? 1 : c.brightness)}${t}`,
      `MIXER ${ch}-${L} CONTRAST ${f(c.contrast === undefined ? 1 : c.contrast)}${t}`,
      `MIXER ${ch}-${L} SATURATION ${f(c.saturation === undefined ? 1 : c.saturation)}${t}`,
    ];
  }

  /** Vsi MIXER ukazi za plast (položaj, mešanje, barve, jakost). */
  _layerMixCmds(ch, L, l, item, frames = 0, opacity = null) {
    const [x, y, w, h] = this._layerFill(l, item).map((v) => v.toFixed(4));
    const g = l.muted ? 0 : dbToGain(l.volumeDb);
    const op = opacity === null ? (l.hidden ? 0 : l.opacity) : opacity;
    return [
      `MIXER ${ch}-${L} FILL ${x} ${y} ${w} ${h}`,
      `MIXER ${ch}-${L} BLEND ${l.blend || 'normal'}`,
      ...this._colorCmds(ch, L, l, frames, op),
      `MIXER ${ch}-${L} VOLUME ${g.toFixed(4)}`,
    ];
  }

  async _sendAll(cmds) {
    for (const c of cmds) await this.engine.send(c);
  }

  _layerPlayCmd(ch, L, l, item) {
    return `PLAY ${ch}-${L} ${quote(mediaPath(item.path))}${item.type !== 'image' && l.loop ? ' LOOP' : ''}`;
  }

  /**
   * Fade na začetku (pri CUT): slika in zvok gresta na 0 pred začetkom, po začetku se dvigneta.
   * Vrne število sličic fade-a (0 = brez).
   */
  async _fadeInPrepare(item, src) {
    const n = Math.round(this._spec(item, src).fadeIn * fpsOf(this.settings.videoMode));
    if (!n || this.panic) return 0;
    await this._applyBaseMix(PROGRAM_CHANNEL, { ...item, opacity: 0 }, 0);
    await this.engine.send(`MIXER ${PROGRAM_CHANNEL}-${LAYER_MAIN} VOLUME 0`);
    return n;
  }

  /** Fade na koncu (pred OUT ali koncem posnetka), če se ne nadaljuje s prelivom. */
  _checkFadeOut(elapsed, total) {
    const p = this.program;
    if (!p.item || p.fadedOut || p.paused || p.item.type === 'image' || this.engine.status !== 'running') return;
    const spec = this._spec(p.item, p.src);
    if (!spec.fadeOut || spec.loop) return;
    if (this.autoCuedId && !this._followCut()) return; // naslednji pride s prelivom
    const end = spec.outSec || total;
    if (!end || Date.now() - (p.wallStart || 0) < 500) return;
    if (elapsed < end - spec.fadeOut - 0.02 || elapsed >= end) return;
    p.fadedOut = true;
    const n = Math.max(1, Math.round((end - elapsed) * fpsOf(this.settings.videoMode)));
    this._applyBaseMix(PROGRAM_CHANNEL, { ...p.item, opacity: 0 }, n).catch(() => {});
    this.engine.send(`MIXER ${PROGRAM_CHANNEL}-${LAYER_MAIN} VOLUME 0 ${n} LINEAR`).catch(() => {});
  }

  /** Barve in prosojnost osnovnega posnetka (samo če so se spremenile). */
  async _applyBaseMix(ch, item, frames = 0) {
    const c = {};
    for (const k of Object.keys(COLOR_DEFAULT)) c[k] = item && item[k] !== undefined ? item[k] : COLOR_DEFAULT[k];
    const key = JSON.stringify(c);
    if (this._baseMix[ch] === key) return;
    if (this._baseMix[ch] === undefined && key === JSON.stringify(COLOR_DEFAULT)) {
      this._baseMix[ch] = key; // motor je pravkar zagnan: privzete vrednosti že veljajo
      return;
    }
    this._baseMix[ch] = key;
    await this._sendAll(this._colorCmds(ch, LAYER_MAIN, c, frames));
  }

  /**
   * Zamegljeno ozadje slike (prileganje "blur"): ista slika čez cel zaslon, zelo zamegljena in malo temnejša,
   * v plasti pod sliko. null = ni potrebno (slika že ustreza 16:9 ali prileganje ni "blur").
   */
  _blurArgs(item) {
    if (!item || item.type !== 'image' || item.fit !== 'blur' || !this._fitFilter(item)) return null;
    const vf = 'scale=192:108:force_original_aspect_ratio=increase,crop=192:108,boxblur=6:2,scale=1920:1080,eq=brightness=-0.12,setsar=1';
    return `${quote(mediaPath(this._playPath(item)))} VF ${quote(vf)}`;
  }

  /** Plast z zamegljenim ozadjem sledi sliki v kanalu (s prelivom, kadar ga ima tudi slika). */
  async _blurSync(ch, item, frames = 0) {
    const want = this._blurArgs(item);
    const have = this._blur[ch] || null;
    const L = `${ch}-${LAYER_BLUR}`;
    const mix = frames ? ` MIX ${Math.round(frames)} LINEAR` : '';
    if (want) {
      if (want === have) return;
      if (ch === PROGRAM_CHANNEL && !frames && this._blurBg === want) await this.engine.send(`PLAY ${L}`);
      else await this.engine.send(`PLAY ${L} ${want}${mix}`);
      if (ch === PROGRAM_CHANNEL) this._blurBg = null;
    } else if (have) {
      if (frames) await this.engine.send(`PLAY ${L} EMPTY${mix}`);
      else await this.engine.send(`CLEAR ${L}`);
      if (ch === PROGRAM_CHANNEL) this._blurBg = null;
    }
    this._blur[ch] = want;
  }

  /** Plasti v preview: posodobi samo, kar se je spremenilo (videi ne začnejo znova po nepotrebnem). */
  async _syncPreviewLayers(src) {
    const ch = PREVIEW_CHANNEL;
    await this._blurSync(ch, this.preview.item, 0);
    const list = this._overlays(src);
    const st = this._ovl[ch];
    const base = LAYER_OVL[0];
    const keys = [];
    for (let i = 0; i < list.length; i++) {
      const { l, item } = list[i];
      const L = base + i;
      const key = `${item.path}|${l.loop}`;
      keys.push(key);
      await this._sendAll(this._layerMixCmds(ch, L, l, item));
      if (st.keys[i] !== key) await this.engine.send(this._layerPlayCmd(ch, L, l, item));
    }
    for (let i = list.length; i < st.keys.length; i++) await this.engine.send(`CLEAR ${ch}-${base + i}`);
    this._ovl[ch] = { bank: 0, ids: list.map((x) => x.l.id), keys };
  }

  /** Plasti gredo na program skupaj z osnovnim posnetkom (s prelivom v drugo skupino plasti). */
  async _layersOnAir(item, src, frames = 0) {
    if (this.engine.status !== 'running') return;
    await this._applyBaseMix(PROGRAM_CHANNEL, item, frames);
    await this._blurSync(PROGRAM_CHANNEL, item, frames);
    const ch = PROGRAM_CHANNEL;
    const list = this._overlays(src);
    const st = this._ovl[ch];
    if (!list.length && !st.ids.length) return;
    const gen = ++this._ovlGen;
    const bank = st.ids.length ? 1 - st.bank : st.bank;
    const base = LAYER_OVL[bank];
    for (let i = 0; i < list.length; i++) {
      const { l, item: it } = list[i];
      const L = base + i;
      await this._sendAll(this._layerMixCmds(ch, L, l, it, 0, frames ? 0 : null));
      await this.engine.send(this._layerPlayCmd(ch, L, l, it));
      if (frames) await this._sendAll(this._colorCmds(ch, L, l, frames, l.hidden ? 0 : l.opacity).slice(0, 1));
    }
    const old = { base: LAYER_OVL[st.bank], n: st.ids.length };
    this._ovl[ch] = { bank, ids: list.map((x) => x.l.id), keys: list.map((x) => `${x.item.path}|${x.l.loop}`) };
    if (old.n && old.base !== base) await this._fadeOutLayers(ch, old.base, old.n, frames, gen);
  }

  async _fadeOutLayers(ch, base, n, frames, gen) {
    const clear = async () => {
      for (let i = 0; i < n; i++) await this.engine.send(`CLEAR ${ch}-${base + i}`).catch(() => {});
    };
    if (!frames) return clear();
    for (let i = 0; i < n; i++) await this.engine.send(`MIXER ${ch}-${base + i} OPACITY 0 ${Math.round(frames)} LINEAR`);
    const ms = (frames / fpsOf(this.settings.videoMode)) * 1000 + 300;
    const t = setTimeout(() => {
      if (gen === this._ovlGen && this.engine.status === 'running') clear();
    }, ms);
    if (t.unref) t.unref();
  }

  /** Program ali preview brez plasti (počisti). */
  async _layersOut(ch, frames = 0) {
    const st = this._ovl[ch];
    if (!st.ids.length) return;
    const gen = ++this._ovlGen;
    this._ovl[ch] = { bank: st.bank, ids: [], keys: [] };
    await this._fadeOutLayers(ch, LAYER_OVL[st.bank], st.ids.length, frames, gen);
    await this._applyBaseMix(ch, null, frames).catch(() => {});
  }

  /** Spremembe plasti, ki ne zahtevajo ponovnega nalaganja (položaj, barve ...), veljajo takoj, tudi na programu. */
  async _liveLayerMix(entryId, layerId) {
    if (this.engine.status !== 'running') return;
    for (const [ch, slot] of [[PROGRAM_CHANNEL, this.program], [PREVIEW_CHANNEL, this.preview]]) {
      if (!slot.src || slot.src.entryId !== entryId) continue;
      const st = this._ovl[ch];
      const i = st.ids.indexOf(layerId);
      if (i === -1) continue;
      const x = this._overlays(slot.src).find((o) => o.l.id === layerId);
      if (!x) continue;
      await this._sendAll(this._layerMixCmds(ch, LAYER_OVL[st.bank] + i, x.l, x.item, ch === PROGRAM_CHANNEL ? 4 : 0));
    }
  }

  _layerSlot(which) {
    const slot = which === 'program' ? this.program : this.preview;
    if (!slot.item) this._error(which === 'program' ? 'Program je prazen' : 'Preview je prazen');
    if (!slot.src || !this.playlist.findEntry(slot.src.entryId)) this._error('Plasti ima samo vnos v playlisti. Dodaj posnetek v playlisto.');
    return slot;
  }

  /** Doda medij kot plast na vrh vnosa v preview (ali na programu). */
  async addLayer(which, mediaId) {
    return this.addEntryLayer(this._layerSlot(which).src.entryId, mediaId);
  }

  async setLayer(which, layerId, patch) {
    return this.setEntryLayer(this._layerSlot(which).src.entryId, layerId, patch);
  }

  async removeLayer(which, layerId) {
    return this.removeEntryLayer(this._layerSlot(which).src.entryId, layerId);
  }

  async moveLayer(which, layerId, dir) {
    return this.moveEntryLayer(this._layerSlot(which).src.entryId, layerId, dir);
  }

  async addEntryLayer(entryId, mediaId) {
    if (!this.playlist.findEntry(entryId)) this._error('Vnos ne obstaja');
    const it = this._item(mediaId);
    if (it.type === 'audio') this._error('Zvok ne more biti plast slike');
    if (!it.width && !it.height) this._probe(it);
    const l = this.playlist.addLayer(entryId, mediaId);
    this._savePlaylist();
    await this._layersChanged(entryId);
    return l.id;
  }

  async setEntryLayer(entryId, layerId, patch) {
    const p = patch || {};
    if (!this.playlist.setLayer(entryId, layerId, p)) this._error('Plast ne obstaja');
    this._savePlaylist();
    if ('loop' in p) await this._layersChanged(entryId);
    else await this._liveLayerMix(entryId, layerId);
  }

  async removeEntryLayer(entryId, layerId) {
    this.playlist.removeLayer(entryId, layerId);
    this._savePlaylist();
    await this._layersChanged(entryId);
  }

  async moveEntryLayer(entryId, layerId, dir) {
    this.playlist.moveLayer(entryId, layerId, dir);
    this._savePlaylist();
    await this._layersChanged(entryId);
  }

  /** Dodana/odstranjena/premaknjena plast: preview takoj, program ob naslednjem predvajanju. */
  async _layersChanged(entryId) {
    if (this.engine.status !== 'running') return;
    if (this.preview.src && this.preview.src.entryId === entryId) await this._syncPreviewLayers(this.preview.src);
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

  /**
   * Napis, pripet na vnos: gre na zaslon titleIn sekund po začetku vnosa in z njega po titleOut sekundah
   * ali ko gre z programa vnos (razen če ima naslednji vnos isti napis; takrat ostane).
   */
  _armEntryTitle() {
    for (const t of this._entryTitleTimers || []) clearTimeout(t);
    this._entryTitleTimers = [];
    const p = this.program;
    const f = p.src ? this.playlist.findEntry(p.src.entryId) : null;
    const e = f ? f.entry : null;
    const want = e && e.titleId && this.titles && this.titles.get(e.titleId) ? e.titleId : null;
    const prev = this._entryTitle || null;
    if (prev && prev !== want) {
      this._entryTitle = null;
      if (this._titleOnLayer(prev) !== null) this.titleOff(prev).catch(() => {});
    }
    if (!want) return;
    const later = (sec, fn) => {
      const t = setTimeout(fn, sec * 1000);
      if (t.unref) t.unref();
      this._entryTitleTimers.push(t);
    };
    const stays = prev === want && this._titleOnLayer(want) !== null;
    const start = stays ? 0 : e.titleIn || 0;
    if (!stays) {
      const on = () => {
        if (this.engine.status !== 'running') return;
        this._entryTitle = want;
        this.titleOn(want).catch(() => {});
      };
      if (start) later(start, on);
      else on();
    }
    if (e.titleOut) {
      later(start + e.titleOut, () => {
        if (this._entryTitle !== want) return;
        this._entryTitle = null;
        this.titleOff(want).catch(() => {});
      });
    }
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
      if (this.program.fadedOut) {
        // Po fade out je slika črna: ob premiku nazaj jo vrnemo.
        this.program.fadedOut = false;
        await this._applyBaseMix(PROGRAM_CHANNEL, this.program.item, 4);
        await this._applyItemVolume(this.program.item, 4);
      }
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
    this._baseMix = {};
    this._blur = {};
    this._blurBg = null;
    this._ovl = { 1: { bank: 0, ids: [], keys: [] }, 2: { bank: 0, ids: [], keys: [] } };
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
    await this._restoreTitles();
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
    if (address === '/channel/1/format') {
      this._ticks = (this._ticks || 0) + 1; // en paket na sličico kanala
      return;
    }
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
    if (ch === PROGRAM_CHANNEL) this._checkFadeOut(elapsed, this.times[ch].total);
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
    const cut = this._followCut();
    const frames = cut ? 0 : this.settings.transitionFrames;
    const fadeIn = cut ? Math.round(this._spec(item, src).fadeIn * fpsOf(this.settings.videoMode)) : 0;
    this._onAir(item, src, this.preview.seek || 0);
    this._applyItemVolume(item, fadeIn || 4).catch(() => {});
    if (fadeIn) this._applyBaseMix(PROGRAM_CHANNEL, item, fadeIn).catch(() => {});
    this._layersOnAir(item, src, frames).catch(() => {});
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
      await this._layersOnAir(p.item, p.src, 0);
    } catch (e) {
      this.lastError = `Obnovitev programa ni uspela: ${e.message}`;
      this._changed();
    }
  }
}

/** Bližnjice: ukaz -> tipka (oblika Electron, npr. "Ctrl+F1"). */
const DEFAULT_HOTKEYS = {
  cut: 'Enter',
  auto: 'Space',
  next: 'Down',
  prev: 'Up',
  stepBackFrame: ',',
  stepFwdFrame: '.',
  stepBackSec: 'Shift+,',
  stepFwdSec: 'Shift+.',
  panic: '',
  pause: '',
  fadeclear: '',
};
function normHotkeys(h) {
  const out = { ...DEFAULT_HOTKEYS };
  if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) {
      if (typeof k === 'string' && k.length < 80 && typeof v === 'string' && v.length < 40) out[k] = v;
    }
  }
  return out;
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

installTitleMethods(Controller);

module.exports = { Controller, DEFAULT_HOTKEYS, fpsOf, samePath, dbToGain, PROGRAM_CHANNEL, PREVIEW_CHANNEL, LAYER_MAIN, MONITOR_CONSUMER, TRANSITIONS };
