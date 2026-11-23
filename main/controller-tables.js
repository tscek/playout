'use strict';
// Tabele oseb v živo: priprava vrstice (po številki ali kliku) kot naslednji napis, GO, akcija iz stolpca (kamera).
// Dodano h Controller.prototype; napis iz vrstice je "navidezen" napis (titles.virtual) z id row:<tabela>:<vrstica>.
// Napisi uporabljajo spremenljivke {Tabela.Stolpec}: napis tabele (titleId) dobi vrednosti iz pripravljene osebe,
// vsak drug napis s spremenljivkami pa iz "trenutne" osebe tabele (zadnja, ki je šla na program).

const fs = require('fs');
const path = require('path');
const { writeJson, readJson } = require('./store');
const { Tables, fill, fillVars, tablesIn, renameVars, rowNum } = require('./tables');
const { normTitle, titleLabel } = require('./titles');

let COUNTRIES = null;
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Koda zastave iz vrednosti celice: koda (SI, SVN, SLO) ali ime države (Slovenija, Germany ...). */
function flagCode(value) {
  const v = norm(value);
  if (!v) return null;
  if (!COUNTRIES) {
    try {
      COUNTRIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'countries.json'), 'utf8'));
    } catch {
      COUNTRIES = {};
    }
  }
  return COUNTRIES[v] || null;
}

const methods = {
  _openTables(dir) {
    this.tablesFile = path.join(dir, 'tables.json');
    this.tables = new Tables(readJson(this.tablesFile, null));
    this.rowCued = null; // { tableId, rowId }
    this.rowCursor = new Map(); // tableId -> rowId trenutne osebe (zadnja na programu)
    this._nextKind = 'list'; // kaj naredi GO: 'row' = oseba iz tabele, 'list' = seznam Čez program, 'title' = napis iz playliste
    this.titleCued = null; // napis iz playliste, ki čaka na GO
    this._titleCuedPrev = 'list';
    this._cueOpts = null; // { seconds, untilNext, anchor } iz vnosa v playlisti za pripravljeno osebo/napis
    this._entryTitles = []; // napisi iz playliste, ki gredo dol ob naslednjem posnetku: { key, gen, anchor }
    this._migrateTables();
  },

  /** Iz v0.17: vzorec (Naslov/Podnaslov) in vzorčni napis tabele postaneta navaden napis s {Tabela.Stolpec}. */
  _migrateTables() {
    let changed = false;
    for (const t of this.tables.tables) {
      if (t.titleId && this.titles.items.some((x) => x.id === t.titleId)) continue;
      if (t.titleId) t.titleId = null;
      if (!(t.styleTitleId || t.map.f0 || t.map.f1 || t.map.f2)) continue;
      this._bindTitle(t);
      changed = true;
    }
    if (changed) {
      this._saveTitles();
      writeJson(this.tablesFile, this.tables.toJSON());
    }
  },

  /** Ustvari napis za tabelo (iz starega vzorca ali privzetih stolpcev) in ga poveže s tabelo. */
  _bindTitle(t, afterId = null) {
    const base = t.styleTitleId ? this.titles.items.find((x) => x.id === t.styleTitleId) : null;
    const conv = (p) => String(p || '').replace(/\{([^{}.]+)\}/g, (all, n) => `{${t.name}.${n.trim()}}`);
    let f = { f0: conv(t.map.f0), f1: conv(t.map.f1), f2: conv(t.map.f2) };
    if (!f.f0 && !f.f1 && !f.f2) {
      const text = t.columns.filter((c) => c.kind === 'text');
      f = { f0: text[0] ? `{${t.name}.${text[0].name}}` : '', f1: text[1] ? `{${t.name}.${text[1].name}}` : '', f2: '' };
    }
    const { id, ...style } = base || { template: t.template };
    const nt = this.titles.add({ ...style, ...f, duration: 0 }, afterId);
    t.titleId = nt.id;
    t.styleTitleId = null;
    t.map = { f0: '', f1: '', f2: '' };
    return nt;
  },

  /** Nov napis za tabelo (gumb "+ nov napis"). */
  addTableTitle(id) {
    const t = this._requireTable(id);
    const nt = this._bindTitle(t);
    this._saveTitles();
    this._saveTables();
    return nt.id;
  },

  _saveTables() {
    writeJson(this.tablesFile, this.tables.toJSON());
    this._changed();
  },

  _requireTable(id) {
    const t = this.tables.get(id || this.tables.active);
    if (!t) this._error('Tabela ne obstaja');
    return t;
  },

  tablesState() {
    const cued = this.rowCued;
    return {
      active: this.tables.active,
      cued,
      cursor: Object.fromEntries(this.rowCursor),
      tables: this.tables.tables.map((t) => ({
        ...t,
        rows: t.rows.map((r) => ({ ...r, n: rowNum(t, r), flag: this._rowFlag(t, r) })),
      })),
    };
  },

  _rowFlag(t, r) {
    const c = t.columns.find((x) => x.kind === 'flag' && r.cells[x.id]);
    return c ? flagCode(r.cells[c.id]) : null;
  },

  /** Slika iz celice: id medija ali ime datoteke (z ali brez končnice). */
  _cellMedia(value) {
    const v = norm(value);
    if (!v) return null;
    const items = this.library.items;
    return items.find((x) => x.id === value)
      || items.find((x) => norm(x.rel || '') === v || norm(x.name) === v)
      || items.find((x) => norm(x.name.replace(/\.[^.]+$/, '')) === v) || null;
  },

  /** Akcija iz celice: id akcije, preset:<id>, ime akcije ali ime preseta. */
  _cellAction(value) {
    if (!this.actions || !value) return null;
    if (this._actionLabel(value)) return value;
    const v = norm(value);
    const a = this.actions.actions.find((x) => norm(x.name) === v);
    if (a) return a.id;
    const presets = this.actions.presets();
    const p = presets.find((x) => norm(this.actions.presetLabel(x.id)) === v) || presets.find((x) => norm(x.label) === v);
    return p ? `preset:${p.id}` : null;
  },

  /** Trenutna oseba tabele: zadnja na programu, sicer prva izpolnjena vrstica. */
  _cursorRow(t) {
    const id = this.rowCursor.get(t.id);
    return (id && t.rows.find((r) => r.id === id)) || t.rows.find((r) => Object.keys(r.cells).length) || null;
  },

  /**
   * Napis z vstavljenimi vrednostmi {Tabela.Stolpec}. pick = { table, row } določi osebo ene tabele,
   * ostale tabele dajo trenutno osebo. Zastava in slika pridejo iz prve tabele (ali iz izbrane).
   */
  _varTitle(base, pick = null) {
    const all = this.tables ? this.tables.tables : [];
    const rowOf = (tb) => (pick && tb.id === pick.table.id ? pick.row : this._cursorRow(tb));
    const out = { ...base };
    for (const k of ['f0', 'f1', 'f2']) out[k] = fillVars(base[k], all, rowOf);
    const src = pick ? pick.table : tablesIn([base.f0, base.f1, base.f2], all)[0];
    const r = src ? rowOf(src) : null;
    if (r) {
      if (out.flag === undefined) out.flag = this._rowFlag(src, r);
      const img = src.columns.find((x) => x.kind === 'image' && r.cells[x.id]);
      const media = img ? this._cellMedia(r.cells[img.id]) : null;
      if (media && media.type === 'image' && !base.logo) out.logo = media.id;
      if (media && media.type !== 'audio' && out.template === 'naslov-grafika' && !base.image) out.image = media.id;
    }
    return out;
  },

  _hasVars(t) {
    return /\{[^{}.]+\.[^{}]+\}/.test(`${t.f0}${t.f1}${t.f2}`);
  },

  /** Napis, ki ga tabela uporablja za GO (če je izbrisan: privzet napis iz prvih stolpcev). */
  _tableTitle(t) {
    const base = t.titleId ? this.titles.items.find((x) => x.id === t.titleId) : null;
    if (base) return base;
    const text = t.columns.filter((c) => c.kind === 'text');
    return normTitle({ template: t.template, f0: text[0] ? `{${t.name}.${text[0].name}}` : '', f1: text[1] ? `{${t.name}.${text[1].name}}` : '' });
  },

  _rowName(t, r) {
    return fill(`{${(t.columns.find((c) => c.kind === 'text') || t.columns[0] || { name: '' }).name}}`, t, r) || `Vrstica ${rowNum(t, r)}`;
  },

  /** Navidezen napis iz vrstice: napis tabele z vrednostmi te osebe. */
  _rowTitle(t, r) {
    const id = `row:${t.id}:${r.id}`;
    const v = this._varTitle(this._tableTitle(t), { table: t, row: r });
    const title = normTitle({ ...v, id, duration: 0 });
    title.flag = v.flag || null;
    title.rowName = this._rowName(t, r);
    this.titles.virtual.set(id, title);
    return title;
  },

  /** Napisi s spremenljivkami tabele, ki so na programu ali v preview, dobijo nove vrednosti. */
  async _refreshVarTitles(tableId) {
    const t = this.tables.get(tableId);
    if (!t) return;
    for (const x of this.titles.items) {
      if (!this._hasVars(x) || !tablesIn([x.f0, x.f1, x.f2], this.tables.tables).includes(t)) continue;
      if (this._titleOnLayer(x.id) !== null || this.titlePvw === x.id) await this._refreshTitle(x, false).catch(() => {});
    }
  },

  _rowAction(t, r, when) {
    if (t.actionWhen !== when) return;
    const c = t.columns.find((x) => x.kind === 'action' && r.cells[x.id]);
    if (!c) return;
    const id = this._cellAction(r.cells[c.id]);
    if (id) this._runAction(id, `oseba ${rowNum(t, r)}: ${this._rowName(t, r)}`);
    else {
      this.lastError = `Akcija "${r.cells[c.id]}" ne obstaja (stolpec ${c.name})`;
      this._changed();
    }
  },

  // ---------- urejanje ----------

  addTable(name) {
    const t = this.tables.add(name);
    this._bindTitle(t);
    this._saveTitles();
    this._saveTables();
    return t.id;
  },

  removeTable(id) {
    this._requireTable(id);
    if (this.rowCued && this.rowCued.tableId === id) this.rowCued = null;
    this.tables.remove(id);
    this._saveTables();
  },

  setActiveTable(id) {
    this._requireTable(id);
    this.tables.active = id;
    this._saveTables();
  },

  async setTable(id, patch) {
    const old = this._requireTable(id).name;
    const t = this.tables.set(id, patch || {});
    if (t.name !== old) this._renameRefs(old, null, null, t.name);
    this._saveTables();
    await this._refreshRows(id);
  },

  /** Sklici {Tabela.Stolpec} v napisih sledijo preimenovanju tabele ali stolpca. */
  _renameRefs(tableName, oldCol, newCol, newTable = null) {
    let n = 0;
    for (const x of this.titles.items) {
      for (const k of ['f0', 'f1', 'f2']) {
        const v = renameVars(x[k], tableName, oldCol, newCol, newTable);
        if (v !== x[k]) {
          x[k] = v;
          n++;
        }
      }
    }
    if (n) this._saveTitles();
  },

  addColumn(id, name, kind) {
    const c = this.tables.addColumn(this._requireTable(id).id, name, kind);
    this._saveTables();
    return c.id;
  },

  async setColumn(id, colId, patch) {
    const t = this._requireTable(id);
    const before = t.columns.find((c) => c.id === colId);
    const oldName = before ? before.name : null;
    const c = this.tables.setColumn(t.id, colId, patch || {});
    if (!c) this._error('Stolpec ne obstaja');
    if (c.name !== oldName) this._renameRefs(t.name, oldName, c.name);
    this._saveTables();
    await this._refreshRows(id);
  },

  async removeColumn(id, colId) {
    this.tables.removeColumn(this._requireTable(id).id, colId);
    this._saveTables();
    await this._refreshRows(id);
  },

  moveColumn(id, colId, index) {
    this.tables.moveColumn(this._requireTable(id).id, colId, index);
    this._saveTables();
  },

  addRows(id, count, index) {
    const rows = this.tables.addRows(this._requireTable(id).id, count, index);
    this._saveTables();
    return rows.length;
  },

  async removeRows(id, rowIds) {
    const t = this._requireTable(id);
    for (const rid of rowIds || []) {
      const key = `row:${t.id}:${rid}`;
      if (this.ovlLive.has(key)) await this.overlayOff(key).catch(() => {});
      if (this.rowCued && this.rowCued.rowId === rid) await this._uncueRow();
    }
    this.tables.removeRows(t.id, rowIds);
    this._saveTables();
  },

  moveRow(id, rowId, index) {
    this.tables.moveRow(this._requireTable(id).id, rowId, index);
    this._saveTables();
  },

  async setCells(id, cells) {
    this.tables.setCells(this._requireTable(id).id, cells);
    this._saveTables();
    await this._refreshRows(id);
  },

  /** Napisi iz vrstic, ki so na programu ali v preview, se po spremembi podatkov osvežijo. */
  async _refreshRows(tableId) {
    const t = this.tables.get(tableId || this.tables.active);
    if (!t) return;
    for (const r of t.rows) {
      const id = `row:${t.id}:${r.id}`;
      const live = this._titleOnLayer(id) !== null || this.titlePvw === id;
      if (!live) continue;
      const before = this.titles.virtual.get(id);
      const nt = this._rowTitle(t, r);
      await this._refreshTitle(nt, !before || before.template !== nt.template).catch(() => {});
    }
    await this._refreshVarTitles(t.id);
  },

  // ---------- v živo ----------

  /** Pripravi osebo (po številki ali id vrstice) kot naslednji napis; pokaže ga v preview. */
  async cueRow({ tableId = null, rowId = null, num = null } = {}) {
    const t = this._requireTable(tableId);
    const r = rowId ? t.rows.find((x) => x.id === rowId) : this.tables.findByNum(t.id, num);
    if (!r) this._error(num ? `Oseba s številko ${num} ni v tabeli "${t.name}"` : 'Vrstica ne obstaja');
    const title = this._rowTitle(t, r);
    this.rowCued = { tableId: t.id, rowId: r.id };
    this._cueOpts = null;
    this.titleCued = null;
    this._nextKind = 'row';
    if (this.tables.active !== t.id) this.tables.active = t.id;
    this._changed();
    if (this.engine.status === 'running') await this.titlePreview(title.id).catch(() => {});
    this._rowAction(t, r, 'cue');
    return rowNum(t, r);
  },

  async _uncueRow() {
    const c = this.rowCued;
    this.rowCued = null;
    if (c && this.titlePvw === `row:${c.tableId}:${c.rowId}`) await this.titlePreview(null).catch(() => {});
    this._changed();
  },

  /** Kaj nadzira razdelek NAPIS (◀ ▶ in GO): 'list' = seznam Čez program, sicer id tabele. */
  async setGfxSource(src) {
    if (this.titleCued) await this._uncueTitle();
    if (!src || src === 'list') {
      this._nextKind = 'list';
      if (this.rowCued) await this._uncueRow();
      this._changed();
      return;
    }
    const t = this._requireTable(src);
    if (this.rowCued && this.rowCued.tableId !== t.id) await this._uncueRow();
    this.tables.active = t.id;
    this._nextKind = 'row';
    this._saveTables();
  },

  /** Oseba iz tabele, ki je zdaj na programu (ključ v ovlLive). */
  _rowOnAir(tableId) {
    for (const [k, r] of this.ovlLive) if (r.row && k.startsWith(`row:${tableId}:`) && this._titleOnLayer(k) !== null) return k;
    return null;
  },

  /** GO za pripravljeno osebo. swap: zamenja osebo na programu brez animacije (isti napis, nova besedila). */
  async _rowGo({ swap = false } = {}) {
    const c = this.rowCued;
    const t = this.tables.get(c.tableId);
    const r = t && t.rows.find((x) => x.id === c.rowId);
    if (!r) {
      await this._uncueRow();
      this._error('Pripravljene osebe ni več v tabeli');
    }
    this._requireEngine();
    const opts = this._cueOpts || {};
    this._cueOpts = null;
    const title = this._rowTitle(t, r);
    const key = title.id;
    const oldKey = swap ? this._rowOnAir(t.id) : null;
    if (oldKey && oldKey !== key) {
      // ista plast dobi novo osebo (CG UPDATE), ostali napisi ostanejo
      const L = this._titleOnLayer(oldKey);
      const old = this.ovlLive.get(oldKey);
      clearTimeout(old && old.timer);
      this.ovlLive.delete(oldKey);
      this.titleSlots.get(L).titleId = key;
      const prevT = this.titles.virtual.get(oldKey);
      await this._refreshTitle(title, !prevT || prevT.template !== title.template).catch(() => {});
      await this._liveTitle(key, key, t.seconds, { noRefresh: true });
    } else {
      await this._liveTitle(key, key, opts.seconds !== undefined && opts.seconds !== null ? opts.seconds : t.seconds, opts);
    }
    this.rowCursor.set(t.id, r.id);
    this._rowAction(t, r, 'go');
    await this._uncueRow();
    await this._refreshVarTitles(t.id);
  },

  /**
   * Napis gre čez program kot "en napis naenkrat" (kot GO): prejšnji iz seznama in osebe gredo dol.
   * key: ključ v ovlLive; seconds: dol po X s; opts.untilNext + anchor: dol ob naslednjem posnetku.
   */
  async _liveTitle(key, titleId, seconds, opts = {}) {
    if (!opts.noRefresh) await this._ovlReplace(key);
    const prev = this.ovlLive.get(key);
    if (prev) clearTimeout(prev.timer);
    const gen = ++this._ovlGen;
    const rec = { titleId, gen, row: true };
    this.ovlLive.set(key, rec);
    if (this._titleOnLayer(titleId) !== null) {
      if (!opts.noRefresh) await this._refreshTitle(this.titles.get(titleId), false).catch(() => {});
    } else {
      try {
        await this.titleOn(titleId);
      } catch (e) {
        this.ovlLive.delete(key);
        throw e;
      }
    }
    if (seconds) {
      rec.timer = setTimeout(() => {
        const cur = this.ovlLive.get(key);
        if (cur && cur.gen === gen) this.overlayOff(key).catch(() => {});
      }, seconds * 1000);
      if (rec.timer.unref) rec.timer.unref();
    }
    if (opts.untilNext) {
      this._entryTitles = this._entryTitles.filter((x) => x.key !== key);
      this._entryTitles.push({ key, gen, anchor: opts.anchor || null });
    }
    this._changed();
  },

  // ---------- napisi kot vnosi v playlisti ----------

  _titleEntryLabel(e) {
    const how = e.mode === 'next' ? 'pripravi' : '';
    if (e.tableId) {
      const t = this.tables.get(e.tableId);
      if (!t) return { name: '? (tabela je izbrisana)', missing: true };
      const who = e.row === 'next' ? 'naslednja oseba' : e.row === 'cur' ? 'trenutna oseba' : `oseba ${e.row}`;
      return { name: `${how ? `${how}: ` : ''}${t.name}, ${who}`, missing: false };
    }
    const tt = this.titles.items.find((x) => x.id === e.titleId);
    if (!tt) return { name: '? (napis je izbrisan)', missing: true };
    return { name: `${how ? `${how}: ` : ''}${titleLabel(tt)}`, missing: false };
  },

  /** Ročni sprožilec (▶ pri vnosu). */
  async fireTitleEntry(entryId) {
    const f = this.playlist.findEntry(entryId);
    if (!f || f.entry.kind !== 'title') this._error('Vnos ne obstaja');
    await this._fireTitleEntry(f.entry);
  },

  /** Vnos z napisom: gre na program (auto) ali se pripravi v razdelku NAPIS (next). */
  async _fireTitleEntry(e) {
    const anchorE = this.playlist.mediaAfter(e.id);
    const opts = { seconds: e.seconds, untilNext: e.untilNext && e.mode === 'auto', anchor: anchorE ? anchorE.id : null };
    if (e.tableId) {
      const t = this.tables.get(e.tableId);
      if (!t) throw new Error('Tabela iz playliste ne obstaja');
      const filled = this._filledRows(t);
      let r = null;
      if (typeof e.row === 'number') r = this.tables.findByNum(t.id, e.row);
      else {
        const cur = this.rowCursor.get(t.id);
        const i = cur ? filled.findIndex((x) => x.id === cur) : -1;
        r = e.row === 'cur' ? filled[i] || filled[0] : filled[i + 1];
      }
      if (!r) throw new Error(`Tabela "${t.name}": ni ${e.row === 'next' ? 'naslednje osebe' : 'te osebe'}`);
      await this.cueRow({ tableId: t.id, rowId: r.id });
      this._cueOpts = { seconds: e.seconds || null, untilNext: e.untilNext, anchor: opts.anchor };
      if (e.mode === 'auto') {
        this._requireEngine();
        this._cueOpts.untilNext = opts.untilNext;
        await this._rowGo();
      }
      return;
    }
    const tt = this.titles.items.find((x) => x.id === e.titleId);
    if (!tt) throw new Error('Napis iz playliste ne obstaja');
    if (e.mode === 'next') {
      if (this.rowCued) await this._uncueRow();
      if (this._nextKind !== 'title') this._titleCuedPrev = this._nextKind;
      this.titleCued = tt.id;
      this._nextKind = 'title';
      this._cueOpts = { seconds: e.seconds, untilNext: e.untilNext, anchor: opts.anchor };
      this._changed();
      if (this.engine.status === 'running') await this.titlePreview(tt.id).catch(() => {});
      return;
    }
    this._requireEngine();
    await this._liveTitle(`pl:${tt.id}`, tt.id, e.seconds, opts);
  },

  /** GO za napis, ki ga je pripravila playlista. */
  async _titleGo() {
    const id = this.titleCued;
    const opts = this._cueOpts || {};
    this._requireEngine();
    await this._uncueTitle();
    await this._liveTitle(`pl:${id}`, id, opts.seconds || 0, opts);
  },

  async _uncueTitle() {
    const id = this.titleCued;
    this.titleCued = null;
    this._cueOpts = null;
    if (this._nextKind === 'title') this._nextKind = this._titleCuedPrev || 'list';
    if (id && this.titlePvw === id) await this.titlePreview(null).catch(() => {});
    this._changed();
  },

  /** Nov posnetek na programu: napisi iz playliste, ki spadajo k prejšnjemu, gredo dol. */
  _dropEntryTitles(entryId) {
    const keep = [];
    for (const x of this._entryTitles || []) {
      if (x.anchor && x.anchor === entryId) {
        keep.push(x);
        continue;
      }
      const cur = this.ovlLive.get(x.key);
      if (cur && cur.gen === x.gen) this.overlayOff(x.key).catch(() => {});
    }
    this._entryTitles = keep;
  },

  _filledRows(t) {
    return t.rows.filter((r) => Object.keys(r.cells).length);
  },

  /**
   * Puščici: naslednja/prejšnja oseba v tabeli (ko NAPIS kaže tabelo), sicer seznam Čez program.
   * Brez pripravljene osebe je izhodišče oseba na programu (oz. zadnja), tako da ▶ pripravi naslednjo.
   * Tabela z "takoj zamenjaj" med napisom na programu osebo zamenja kar na programu.
   */
  async overlayStep(dir) {
    const d = dir > 0 ? 1 : -1;
    if (this.titleCued) await this._uncueTitle();
    if (this._nextKind === 'row' || (!this.playlist.overlays.length && this.tables.activeTable())) {
      const t = this._requireTable(this.rowCued ? this.rowCued.tableId : null);
      const filled = this._filledRows(t);
      if (!filled.length) return;
      const onAir = this._rowOnAir(t.id);
      const from = this.rowCued ? this.rowCued.rowId : this.rowCursor.get(t.id) || null;
      let i = from ? filled.findIndex((r) => r.id === from) : -1;
      i = i === -1 ? (d > 0 ? 0 : filled.length - 1) : Math.max(0, Math.min(filled.length - 1, i + d));
      await this.cueRow({ tableId: t.id, rowId: filled[i].id });
      if (t.liveUpdate && onAir && this.engine.status === 'running') await this._rowGo({ swap: true });
      return;
    }
    const list = this.playlist.overlays;
    if (!list.length) return;
    const i = list.findIndex((o) => o.id === this.ovlNext);
    const j = i === -1 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + d));
    this.setOverlayNext(list[j].id);
  },

  /** Za razdelek NAPIS: tabela, napis tabele, pripravljena in trenutna oseba. */
  _gfxTableState() {
    if (this._nextKind !== 'row') return null;
    const t = this.tables.activeTable();
    if (!t) return null;
    const filled = this._filledRows(t);
    const info = (r) => (r ? { id: r.id, num: rowNum(t, r), pos: filled.indexOf(r) + 1, name: this._rowName(t, r) } : null);
    const cued = this.rowCued && this.rowCued.tableId === t.id ? t.rows.find((x) => x.id === this.rowCued.rowId) : null;
    const curId = this.rowCursor.get(t.id);
    const tt = t.titleId ? this.titles.items.find((x) => x.id === t.titleId) : null;
    return {
      tableId: t.id,
      table: t.name,
      titleId: tt ? tt.id : null,
      titleName: tt ? titleLabel(tt) : '(privzet napis)',
      total: filled.length,
      cued: info(cued),
      current: info(curId ? t.rows.find((x) => x.id === curId) : null),
      onAir: !!this._rowOnAir(t.id),
      liveUpdate: t.liveUpdate,
    };
  },

  /** Ime naslednjega za prikaz ob GO (oseba ali vnos seznama). */
  _nextLabel() {
    if (this._nextKind === 'title' && this.titleCued) {
      const tt = this.titles.items.find((x) => x.id === this.titleCued);
      if (tt) return { kind: 'title', num: null, name: titleLabel(tt), table: null };
    }
    if (this._nextKind === 'row' && this.rowCued) {
      const t = this.tables.get(this.rowCued.tableId);
      const r = t && t.rows.find((x) => x.id === this.rowCued.rowId);
      if (r) return { kind: 'row', num: rowNum(t, r), name: this._rowName(t, r), table: t.name };
    }
    return null;
  },
};

function installTableMethods(Controller) {
  Object.assign(Controller.prototype, methods);
}

module.exports = { installTableMethods, flagCode };
