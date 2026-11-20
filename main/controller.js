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
    this.playlistFile = path.join(dataDir, 'playlist.json');

    const saved = readJson(this.settingsFile, {});
    if (!saved.settingsVersion && saved.programOutput === 'test') saved.programOutput = 'auto'; // v0.1.0 je imel privzeto testno okno
    this.settings = { ...DEFAULT_SETTINGS, ...saved, settingsVersion: 2 };
    this.library = readJson(this.libraryFile, { items: [] });
    this.displays = [];
    this.audioDevices = [];
    this.playlist = new Playlist(readJson(this.playlistFile, null));
    // src = { groupId, entryId }, če je posnetek prišel iz playliste
    this.program = { item: null, startedAt: 0, src: null }; // kaj je na programu
    this.preview = { item: null, src: null, seek: 0 }; // kaj je v preview
    this.cuedId = null; // posnetek, ki je že naložen v ozadje programa (za takojšen CUT)
    this.autoCuedId = null; // posnetek v ozadju, ki ga motor sam zažene ob koncu programa
    this.imageTimer = null; // samodejno nadaljevanje po sliki
    this.panic = false;
    this._lastPgmPath = null;
    this._cueGen = 0;
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
          volumeDb: this.program.item.volumeDb || 0, ...this._specState(this.program.item, this.program.src), startedAt: this.program.startedAt, src: this.program.src }
        : null,
      preview: this.preview.item
        ? { id: this.preview.item.id, name: this.preview.item.name, type: this.preview.item.type, loop: !!this.preview.item.loop,
          volumeDb: this.preview.item.volumeDb || 0, ...this._specState(this.preview.item, this.preview.src), src: this.preview.src, autoFollow: this.autoCuedId ? 'end' : this.imageTimer ? 'timer' : null }
        : null,
      playlist: this.playlist.groups.map((g) => ({
        ...g,
        items: g.items.map((e) => {
          const it = libById.get(e.mediaId);
          return { ...e, name: it ? it.name : '?', type: it ? it.type : 'video', loop: !!(it && it.loop), missing: !it || !fileExists(it.path) };
        }),
      })),
      panic: this.panic,
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
    const operational = ['transitionType', 'transitionFrames', 'transitionDirection', 'previewMode', 'directTake', 'autoNext', 'panicSource', 'masterVolumeDb'];
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
    const masterChanged = next.masterVolumeDb !== this.settings.masterVolumeDb;
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
        this.library.items.push(item);
        added++;
      }
    }
    this._saveLibrary();
    return added;
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
    const pos = t ? Math.round(t.elapsed * 100) / 100 : (v.seek || 0) / fpsOf(this.settings.videoMode);
    const key = which === 'out' ? 'outSec' : 'inSec';
    const value = clear ? null : pos;
    const spec = this._spec(v.item, v.src);
    if (!clear && key === 'outSec' && spec.inSec && value <= spec.inSec) this._error('OUT mora biti za IN točko');
    if (!clear && key === 'inSec' && spec.outSec && value >= spec.outSec) this._error('IN mora biti pred OUT točko');
    if (v.src) {
      this.playlist.setEntry(v.src.entryId, { [key]: value });
      writeJson(this.playlistFile, this.playlist.toJSON());
    } else {
      const it = this._item(v.item.id);
      it[key] = value;
      v.item[key] = value;
      writeJson(this.libraryFile, this.library);
    }
    if (key === 'inSec') v.seek = clear ? 0 : Math.round(pos * fpsOf(this.settings.videoMode));
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
    const inSec = e ? e.inSec : item.inSec;
    const outSec = e ? e.outSec : item.outSec;
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

  /** Parametri posnetka za AMCP: pot, LOOP, SEEK (sličice od začetka datoteke), IN/OUT točki. */
  _mediaArgs(item, seekFrames = 0, src = null) {
    let cmd = quote(mediaPath(item.path));
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
    const item = this._item(id);
    this._checkFile(item);
    const src = this._srcOf(entryId);
    this.preview = { item: { ...item }, src, seek: this._spec(item, src).inF };
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
    const item = this._item(id);
    this._checkFile(item);
    this._requireEngine();
    const k = kind || this.settings.directTake;
    this._clearImageTimer();
    const src = this._srcOf(entryId);
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

  // ---------- zvok in premikanje po posnetku ----------

  async _applyItemVolume(item, frames = 0) {
    const g = dbToGain(item.volumeDb);
    const f = Math.max(0, Math.round(Number(frames) || 0));
    await this.engine.send(`MIXER ${PROGRAM_CHANNEL}-${LAYER_MAIN} VOLUME ${g.toFixed(4)}${f ? ` ${f} LINEAR` : ''}`);
  }

  async _applyMaster() {
    await this.engine.send(`MIXER ${PROGRAM_CHANNEL} MASTERVOLUME ${dbToGain(this.settings.masterVolumeDb).toFixed(4)}`);
  }

  /** Jakost posnetka (shrani se k posnetku). Če je na programu, se spremeni takoj. */
  async setItemVolume(id, db) {
    const it = this._item(id);
    it.volumeDb = clampDb(db, 0);
    for (const slot of [this.program, this.preview]) if (slot.item && slot.item.id === id) slot.item.volumeDb = it.volumeDb;
    this._saveLibrary();
    if (this.program.item && this.program.item.id === id && this.engine.status === 'running') {
      await this._applyItemVolume(this.program.item, 0);
    }
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
        await this.engine.send(`PLAY ${ch}-${LAYER_PANIC} ${quote(mediaPath(logo.path))}${logo.type === 'image' ? '' : ' LOOP'}`);
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
      && this.preview.item && this.program.item && samePath(this.preview.item.path, this.program.item.path)) {
      this._autoAdvanced();
    }
    this.times[ch] = { elapsed, total: typeof total === 'number' ? total : 0 };
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
    if (this.program.item && samePath(this.program.item.path, p)) return;
    if (!samePath(v.path, p)) return;
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
      await this.engine.send(this._playCommand(p.item, seek, '', p.src));
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
