'use strict';
// Seznam "Čez program": napisi in grafike (npr. animirani lower third, logo, MOV/WebM s prosojnostjo),
// ki gredo čez program in ga ne zamenjajo. Ima svoj NEXT in GO (dodano h Controller.prototype).
// Grafike so na programu na plasteh LAYER_GFX.., nad napisi.

const { quote, mediaPath } = require('./engine/amcp');
const { titleLabel } = require('./titles');

const PROGRAM_CHANNEL = 1;
const LAYER_GFX = 70; // 70..79
const MAX_GFX = 10;

const methods = {
  _initOverlays() {
    this.ovlNext = null; // id naslednjega v seznamu
    this.ovlLive = new Map(); // id vnosa -> { L (grafika) ali titleId, timer, gen }
    this._ovlGen = 0;
    this._gfxBusy = new Set(); // plasti, ki se še praznijo
  },

  _ovlIsOn(o) {
    const r = this.ovlLive.get(o.id);
    if (!r) return false;
    if (o.kind === 'title') return this._titleOnLayer(o.titleId) !== null && !this._titleClosing(o.titleId);
    return true;
  },

  _titleClosing(titleId) {
    const L = this._titleOnLayer(titleId);
    const s = L === null ? null : this.titleSlots.get(L);
    return !!(s && s.closing);
  },

  overlaysState() {
    const lib = new Map(this.library.items.map((x) => [x.id, x]));
    const list = this.playlist.overlays;
    if (this.ovlNext && !list.some((o) => o.id === this.ovlNext)) this.ovlNext = null;
    return {
      next: this.ovlNext,
      items: list.map((o) => {
        let name = '?';
        let type = 'title';
        let missing = false;
        if (o.kind === 'title') {
          const t = this.titles && this.titles.get(o.titleId);
          name = t ? titleLabel(t) : '? (napis je izbrisan)';
          missing = !t;
        } else {
          const it = lib.get(o.mediaId);
          name = it ? it.name : '?';
          type = it ? it.type : 'video';
          missing = !it;
        }
        return { ...o, name, type, missing, onAir: this._ovlIsOn(o) };
      }),
    };
  },

  _saveOverlays() {
    this._savePlaylist();
    this._changed();
  },

  addOverlay(spec, index) {
    if (spec && spec.kind === 'title' && !(this.titles && this.titles.get(spec.titleId))) this._error('Napis ne obstaja');
    if (spec && spec.kind === 'media') this._item(spec.mediaId);
    const o = this.playlist.addOverlay(spec, index);
    if (!o) this._error('Ni kaj dodati');
    if (!this.ovlNext) this.ovlNext = o.id;
    this._saveOverlays();
    return o.id;
  },

  async setOverlay(id, patch) {
    const o = this.playlist.setOverlay(id, patch || {});
    if (!o) this._error('Vnos ne obstaja');
    this._saveOverlays();
    const r = this.ovlLive.get(id);
    if (r && r.L !== undefined && this.engine.status === 'running') {
      await this._gfxMix(r.L, o, 0).catch(() => {});
    }
  },

  async removeOverlay(id) {
    if (this.ovlLive.has(id)) await this.overlayOff(id).catch(() => {});
    this.playlist.removeOverlay(id);
    if (this.ovlNext === id) this.ovlNext = null;
    this._saveOverlays();
  },

  moveOverlay(id, index) {
    this.playlist.moveOverlay(id, index);
    this._saveOverlays();
  },

  setOverlayNext(id) {
    if (id && !this.playlist.overlay(id)) this._error('Vnos ne obstaja');
    this.ovlNext = id || null;
    this._changed();
  },

  /** GO: naslednji (ali izbrani) gre čez program; prejšnji iz seznama gre dol, razen če ima "ostane". */
  async overlayGo(id = null) {
    const list = this.playlist.overlays;
    const o = list.find((x) => x.id === (id || this.ovlNext));
    if (!o) this._error('V seznamu Čez program ni naslednjega');
    this._requireEngine();
    if (!o.keep) {
      for (const x of list) {
        if (x.id !== o.id && !x.keep && this._ovlIsOn(x)) await this.overlayOff(x.id).catch(() => {});
      }
    }
    const i = list.indexOf(o);
    this.ovlNext = list[i + 1] ? list[i + 1].id : null;
    await this._overlayOn(o);
    this._changed();
  },

  async _overlayOn(o) {
    const prev = this.ovlLive.get(o.id);
    if (prev) clearTimeout(prev.timer);
    const gen = ++this._ovlGen;
    if (o.kind === 'title') {
      if (!(this.titles && this.titles.get(o.titleId))) this._error('Napis ne obstaja');
      this.ovlLive.set(o.id, { titleId: o.titleId, gen });
      await this.titleOn(o.titleId);
    } else {
      const item = this._item(o.mediaId);
      this._checkFile(item);
      let L = prev && prev.L !== undefined ? prev.L : null;
      if (L === null) {
        const used = new Set([...this.ovlLive.values()].map((r) => r.L).filter((x) => x !== undefined));
        for (let k = 0; k < MAX_GFX && L === null; k++) if (!used.has(LAYER_GFX + k) && !this._gfxBusy.has(LAYER_GFX + k)) L = LAYER_GFX + k;
      }
      if (L === null) this._error(`Hkrati je lahko čez program največ ${MAX_GFX} grafik`);
      this._gfxBusy.delete(L);
      this.ovlLive.set(o.id, { L, gen, item });
      const frames = Math.round((o.fade || 0) * this._fps());
      try {
        await this.engine.send(`MIXER ${PROGRAM_CHANNEL}-${L} OPACITY 0`);
        await this._gfxMix(L, o, 0, item, 0);
        const loop = item.type !== 'image' && o.end === 'loop' ? ' LOOP' : '';
        await this.engine.send(`PLAY ${PROGRAM_CHANNEL}-${L} ${quote(mediaPath(item.path))}${loop}`);
        await this.engine.send(`MIXER ${PROGRAM_CHANNEL}-${L} OPACITY ${o.opacity.toFixed(4)}${frames ? ` ${frames} LINEAR` : ''}`);
      } catch (e) {
        this.ovlLive.delete(o.id);
        this._changed();
        this._error(`Grafike ni bilo mogoče prikazati: ${e.message}`);
      }
    }
    if (o.seconds) {
      const r = this.ovlLive.get(o.id);
      r.timer = setTimeout(() => {
        const cur = this.ovlLive.get(o.id);
        if (cur && cur.gen === gen) this.overlayOff(o.id).catch(() => {});
      }, o.seconds * 1000);
      if (r.timer.unref) r.timer.unref();
    }
    this._changed();
  },

  /** Položaj, velikost, prosojnost in zvok grafike. */
  async _gfxMix(L, o, frames = 0, item = null, opacity = null) {
    const it = item || (this.ovlLive.get(o.id) || {}).item || this._item(o.mediaId);
    const l = { ...o, blend: 'normal', hidden: false };
    const cmds = this._layerMixCmds(PROGRAM_CHANNEL, L, l, it, frames, opacity);
    for (const c of cmds) await this.engine.send(c);
  },

  /** Umakne en vnos (ali vse, če id ni podan). */
  async overlayOff(id = null) {
    if (!id) {
      for (const k of [...this.ovlLive.keys()]) await this.overlayOff(k).catch(() => {});
      return;
    }
    const r = this.ovlLive.get(id);
    if (!r) return;
    clearTimeout(r.timer);
    this.ovlLive.delete(id);
    this._changed();
    if (r.titleId) {
      await this.titleOff(r.titleId);
      return;
    }
    if (this.engine.status !== 'running') return;
    const o = this.playlist.overlay(id);
    const frames = Math.round(((o ? o.fade : 0.4) || 0) * this._fps());
    const L = r.L;
    this._gfxBusy.add(L);
    if (!frames) {
      this._gfxBusy.delete(L);
      await this.engine.send(`CLEAR ${PROGRAM_CHANNEL}-${L}`).catch(() => {});
      return;
    }
    await this.engine.send(`MIXER ${PROGRAM_CHANNEL}-${L} OPACITY 0 ${frames} LINEAR`).catch(() => {});
    const t = setTimeout(() => {
      if (!this._gfxBusy.has(L)) return; // plast je medtem dobila novo grafiko
      this._gfxBusy.delete(L);
      if (this.engine.status === 'running') this.engine.send(`CLEAR ${PROGRAM_CHANNEL}-${L}`).catch(() => {});
    }, (frames / this._fps()) * 1000 + 200);
    if (t.unref) t.unref();
  },

  /** Čas grafike iz motorja: grafika z "na koncu izgine" gre dol ob koncu. */
  _gfxTime(L, elapsed, total) {
    if (!total) return;
    for (const [id, r] of this.ovlLive) {
      if (r.L !== L) continue;
      const o = this.playlist.overlay(id);
      if (!o || o.end !== 'clear' || r.item.type === 'image') return;
      const fade = o.fade || 0;
      if (elapsed >= total - fade - 1 / this._fps()) this.overlayOff(id).catch(() => {});
      return;
    }
  },

  /** Po ponovnem zagonu motorja: napise obnovijo napisi sami; grafike, ki ostanejo, predvajamo znova. */
  async _restoreOverlays() {
    this._gfxBusy.clear();
    for (const [id, r] of [...this.ovlLive]) {
      if (r.titleId) continue;
      const o = this.playlist.overlay(id);
      this.ovlLive.delete(id);
      if (o && (o.end !== 'clear' || r.item.type === 'image')) await this._overlayOn(o).catch(() => {});
    }
    this._changed();
  },
};

function installOverlayMethods(Controller) {
  Object.assign(Controller.prototype, methods);
}

module.exports = { installOverlayMethods, LAYER_GFX, MAX_GFX };
