'use strict';
// Napisi na programu in v preview (dodano h Controller.prototype).
// Vsak vklopljen napis ima svojo plast na programu (LAYER_TITLE..), neodvisno od posnetkov in playliste.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { writeJson, readJson } = require('./store');
const { Titles, FONTS, normBrand, titleLabel, templateOf, installTemplates, loadUserTemplates, allTemplates } = require('./titles');

const PROGRAM_CHANNEL = 1;
const PREVIEW_CHANNEL = 2;
const LAYER_TITLE = 60; // program: 60..69, preview: 60
const MAX_TITLES_ON = 10;
const OUT_MS = 900; // čas za izhodno animacijo, potem plast počistimo

/** Niz za AMCP (narekovaji in poševnice ubežani). */
const amcpString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;

const USER_README = `Lastne predloge za napise (Playout)
====================================

V to mapo daj svoje predloge kot datoteke .html. Pokažejo se med predlogami v zavihku Napisi
(z oznako "moja"), ko klikneš "Osveži predloge" ali znova zaženeš aplikacijo.

Predloga je spletna stran 1920 x 1080 s prosojnim ozadjem in tremi funkcijami:
  update(podatki)  podatki (JSON): f0, f1, f2 (besedila), align, bg, accent, text (barve), font, logo (naslov slike)
  play()           animacija prihoda
  stop()           animacija odhoda (po 0,9 s se napis odstrani)

V <head> lahko dodaš:
  <meta name="playout-name" content="Ime predloge">
  <meta name="playout-fields" content="Ime|Funkcija|Oznaka">     (imena polj, največ 3)
  <meta name="playout-aligns" content="left,center,right">       (možni položaji: left, center, right, tl, tr, bl, br)

Primer: preimenuj "primer.html.txt" v "primer.html" in ga spremeni (barve, pisave, animacije).
Predlogo ti lahko pripravi tudi Claude: opiši, kako naj napis izgleda.
`;

const methods = {
  _initTitles() {
    this.titleSlots = new Map(); // plast -> { titleId, closing, gen }
    this.titlePvw = null; // id napisa v preview
    this._titleGen = 0;
    this._titleTimers = new Map(); // titleId -> timer za samodejni izklop
    this.userTemplatesDir = this.dataDir ? path.join(this.dataDir, 'predloge') : null;
    if (this.userTemplatesDir) loadUserTemplates(this.userTemplatesDir);
  },

  /** Mapa za lastne predloge (ob prvem odprtju dobi navodila in primer). */
  userTemplatesFolder() {
    const dir = this.userTemplatesDir;
    if (!dir) this._error('Mapa za predloge ni na voljo');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      const gfx = path.join(__dirname, 'gfx');
      fs.writeFileSync(path.join(dir, 'PREBERI.txt'), USER_README, 'utf8');
      const ex = fs.readFileSync(path.join(gfx, 'klasicni.html'), 'utf8')
        .replace('<title>Klasični napis</title>', '<title>Primer</title>\n<meta name="playout-name" content="Primer (kopija klasičnega)">\n<meta name="playout-fields" content="Ime|Funkcija">\n<meta name="playout-aligns" content="left,center,right">');
      fs.writeFileSync(path.join(dir, 'primer.html.txt'), ex, 'utf8');
    }
    return dir;
  },

  /** Ponovno prebere lastne predloge in jih namesti v motor. */
  async rescanTemplates() {
    const list = this.userTemplatesDir ? loadUserTemplates(this.userTemplatesDir) : [];
    this._installTemplates();
    this._changed();
    for (const t of this.titles.items) if (t.template.startsWith('user-')) await this._refreshTitle(t, true);
    return list.length;
  },

  _openTitles(dir) {
    this.titlesFile = path.join(dir, 'titles.json');
    this.titles = new Titles(readJson(this.titlesFile, null));
    this.project.brand = normBrand(this.project.brand);
  },

  _saveTitles() {
    writeJson(this.titlesFile, this.titles.toJSON());
  },

  _installTemplates() {
    try {
      if (this.userTemplatesDir) loadUserTemplates(this.userTemplatesDir);
      installTemplates(this.templateDir);
    } catch (e) {
      if (this.engine && this.engine._log) this.engine._log(`Predlog za napise ni bilo mogoče namestiti: ${e.message}`);
    }
  },

  titlesState() {
    const onAir = [];
    for (const s of this.titleSlots.values()) if (!s.closing) onAir.push(s.titleId);
    return {
      templates: allTemplates().map(({ file, ...t }) => t),
      userDir: this.userTemplatesDir,
      fonts: FONTS,
      brand: this.project.brand,
      items: this.titles.items.map((t) => ({ ...t, label: titleLabel(t) })),
      onAir,
      pvw: this.titlePvw,
    };
  },

  /** Podatki za predlogo: celostna podoba projekta + nastavitve napisa. */
  _titleData(t) {
    const b = this.project.brand;
    const logoId = t.logo === null ? b.logo : t.logo;
    let logo = '';
    if (logoId) {
      const it = this.library.items.find((x) => x.id === logoId);
      if (it && it.type === 'image') logo = pathToFileURL(it.path).href;
    }
    return {
      f0: t.f0, f1: t.f1, f2: t.f2, align: t.align,
      bg: t.bg || b.bg, accent: t.accent || b.accent, text: t.text || b.text, font: b.font, logo,
      mode: t.mode, target: t.target, seconds: t.seconds,
    };
  },

  /** Pošlje napis in nastavi njegovo velikost (MIXER FILL okoli roba, kjer napis stoji). */
  async _titleSend(ch, L, t, op) {
    await this.engine.send(this._titleCmd(ch, L, t, op));
    const k = Number(t.size) || 1;
    const al = t.align || 'center';
    const ax = /left|^tl$|^bl$/.test(al) ? 0.07 : /right|^tr$|^br$/.test(al) ? 0.93 : 0.5;
    const mid = t.template === 'naslov' || (t.template === 'ura' && al === 'center');
    const ay = mid ? 0.5 : /^t/.test(al) ? 0.08 : 0.9;
    const r = (v) => Math.round(v * 10000) / 10000;
    await this.engine.send(`MIXER ${ch}-${L} FILL ${r(ax * (1 - k))} ${r(ay * (1 - k))} ${k} ${k}`);
  },

  _titleCmd(ch, L, t, op) {
    const data = amcpString(JSON.stringify(this._titleData(t)));
    if (op === 'update') return `CG ${ch}-${L} UPDATE 0 ${data}`;
    return `CG ${ch}-${L} ADD 0 "playout-${templateOf(t.template).id}" 1 ${data}`;
  },

  _titleOnLayer(id) {
    for (const [L, s] of this.titleSlots) if (s.titleId === id && !s.closing) return L;
    return null;
  },

  _requireTitle(id) {
    const t = this.titles.get(id);
    if (!t) this._error('Napis ne obstaja');
    return t;
  },

  // ---------- urejanje ----------

  addTitle(patch = {}, afterId = null) {
    const t = this.titles.add(patch, afterId);
    this._saveTitles();
    this._changed();
    return t.id;
  },

  async setTitle(id, patch = {}) {
    const old = this._requireTitle(id).template;
    const t = this.titles.set(id, patch);
    this._saveTitles();
    this._changed();
    await this._refreshTitle(t, t.template !== old);
  },

  async removeTitle(id) {
    if (this._titleOnLayer(id) !== null) await this.titleOff(id);
    if (this.titlePvw === id) await this.titlePreview(null);
    this.titles.remove(id);
    this._saveTitles();
    this._changed();
  },

  moveTitle(id, toIndex) {
    this.titles.move(id, toIndex);
    this._saveTitles();
    this._changed();
  },

  async setBrand(patch = {}) {
    this.project.brand = normBrand({ ...this.project.brand, ...patch });
    this._saveProjectMeta();
    this._changed();
    for (const t of this.titles.items) await this._refreshTitle(t, false);
  },

  /** Sprememba napisa velja takoj na programu in v preview. */
  async _refreshTitle(t, reload) {
    if (this.engine.status !== 'running') return;
    const L = this._titleOnLayer(t.id);
    if (L !== null) await this._titleSend(PROGRAM_CHANNEL, L, t, reload ? 'add' : 'update').catch(() => {});
    if (this.titlePvw === t.id) await this._titleSend(PREVIEW_CHANNEL, LAYER_TITLE, t, reload ? 'add' : 'update').catch(() => {});
  },

  // ---------- na program / z njega ----------

  async titleOn(id) {
    const t = this._requireTitle(id);
    this._requireEngine();
    if (this._titleOnLayer(id) !== null) return;
    let L = null;
    for (let i = 0; i < MAX_TITLES_ON; i++) {
      if (!this.titleSlots.has(LAYER_TITLE + i)) {
        L = LAYER_TITLE + i;
        break;
      }
    }
    if (L === null) this._error(`Hkrati je lahko vklopljenih največ ${MAX_TITLES_ON} napisov`);
    const gen = ++this._titleGen;
    this.titleSlots.set(L, { titleId: id, closing: false, gen });
    this._changed();
    try {
      await this._titleSend(PROGRAM_CHANNEL, L, t, 'add');
    } catch (e) {
      this.titleSlots.delete(L);
      this._changed();
      this._error(`Napisa ni bilo mogoče prikazati: ${e.message}`);
    }
    this._armTitleTimer(t);
  },

  _armTitleTimer(t) {
    clearTimeout(this._titleTimers.get(t.id));
    this._titleTimers.delete(t.id);
    if (!t.duration) return;
    const tm = setTimeout(() => {
      this._titleTimers.delete(t.id);
      this.titleOff(t.id).catch(() => {});
    }, t.duration * 1000);
    if (tm.unref) tm.unref();
    this._titleTimers.set(t.id, tm);
  },

  async titleOff(id) {
    const L = this._titleOnLayer(id);
    clearTimeout(this._titleTimers.get(id));
    this._titleTimers.delete(id);
    if (L === null) return;
    const slot = this.titleSlots.get(L);
    slot.closing = true;
    this._changed();
    if (this.engine.status !== 'running') {
      this.titleSlots.delete(L);
      return;
    }
    await this.engine.send(`CG ${PROGRAM_CHANNEL}-${L} STOP 0`).catch(() => {});
    const tm = setTimeout(async () => {
      const s = this.titleSlots.get(L);
      if (!s || s.gen !== slot.gen) return;
      this.titleSlots.delete(L);
      if (this.engine.status === 'running') await this.engine.send(`CLEAR ${PROGRAM_CHANNEL}-${L}`).catch(() => {});
      this._changed();
    }, OUT_MS);
    if (tm.unref) tm.unref();
  },

  async titleToggle(id) {
    if (this._titleOnLayer(id) !== null) await this.titleOff(id);
    else await this.titleOn(id);
  },

  async titlesAllOff() {
    for (const s of [...this.titleSlots.values()]) if (!s.closing) await this.titleOff(s.titleId);
  },

  /** Napis v preview (en naenkrat); null = počisti. */
  async titlePreview(id) {
    const t = id ? this._requireTitle(id) : null;
    this.titlePvw = t ? t.id : null;
    this._changed();
    if (this.engine.status !== 'running') return;
    if (t) await this._titleSend(PREVIEW_CHANNEL, LAYER_TITLE, t, 'add');
    else await this.engine.send(`CLEAR ${PREVIEW_CHANNEL}-${LAYER_TITLE}`).catch(() => {});
  },

  /** Po ponovnem zagonu motorja: vklopljeni napisi in napis v preview se vrnejo. */
  async _restoreTitles() {
    for (const [L, s] of [...this.titleSlots]) {
      if (s.closing) {
        this.titleSlots.delete(L);
        continue;
      }
      const t = this.titles.get(s.titleId);
      if (!t) {
        this.titleSlots.delete(L);
        continue;
      }
      await this._titleSend(PROGRAM_CHANNEL, L, t, 'add').catch(() => {});
    }
    if (this.titlePvw) {
      const t = this.titles.get(this.titlePvw);
      if (t) await this._titleSend(PREVIEW_CHANNEL, LAYER_TITLE, t, 'add').catch(() => {});
      else this.titlePvw = null;
    }
  },

  /** Ob menjavi projekta: vsi napisi dol (brez animacije). */
  async _clearTitles() {
    for (const tm of this._titleTimers.values()) clearTimeout(tm);
    this._titleTimers.clear();
    const layers = [...this.titleSlots.keys()];
    this.titleSlots.clear();
    const pvw = this.titlePvw;
    this.titlePvw = null;
    this._titleGen++;
    if (this.engine.status !== 'running') return;
    for (const L of layers) await this.engine.send(`CLEAR ${PROGRAM_CHANNEL}-${L}`).catch(() => {});
    if (pvw) await this.engine.send(`CLEAR ${PREVIEW_CHANNEL}-${LAYER_TITLE}`).catch(() => {});
  },

  /** Korak akcije "Napis": vklopi / umakni / preklopi / vsi dol. */
  async _actionLocalStep(step) {
    if (step.cmd === 'allOff') return this.titlesAllOff();
    const t = this.titles.get(step.target);
    if (!t) throw new Error('Napisa ni v tem projektu');
    if (step.cmd === 'on') return this.titleOn(t.id);
    if (step.cmd === 'off') return this.titleOff(t.id);
    return this.titleToggle(t.id);
  },

  /** Napis po id ali imenu (za API in bližnjice). */
  findTitle(key) {
    const k = String(key || '').trim().toLowerCase();
    return this.titles.items.find((t) => t.id === key) || this.titles.items.find((t) => titleLabel(t).toLowerCase() === k)
      || this.titles.items.find((t) => (t.f0 || '').toLowerCase() === k) || null;
  },
};

function installTitleMethods(Controller) {
  Object.assign(Controller.prototype, methods);
}

module.exports = { installTitleMethods, LAYER_TITLE, amcpString };
