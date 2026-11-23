'use strict';
// Tabele oseb v živo: priprava vrstice (po številki ali kliku) kot naslednji napis, GO, akcija iz stolpca (kamera).
// Dodano h Controller.prototype; napis iz vrstice je "navidezen" napis (titles.virtual) z id row:<tabela>:<vrstica>.

const fs = require('fs');
const path = require('path');
const { writeJson, readJson } = require('./store');
const { Tables, fill, rowNum } = require('./tables');
const { normTitle } = require('./titles');

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
    this._nextKind = 'list'; // kaj naredi GO: 'row' = pripravljena oseba, 'list' = seznam Čez program
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

  _rowName(t, r) {
    return fill(t.map.f0, t, r) || fill(`{${t.columns[0] ? t.columns[0].name : ''}}`, t, r) || `Vrstica ${rowNum(t, r)}`;
  },

  /** Navidezen napis iz vrstice: vzorčni napis (slog) + besedila iz stolpcev + zastava in slika. */
  _rowTitle(t, r) {
    const base = t.styleTitleId ? this.titles.items.find((x) => x.id === t.styleTitleId) : null;
    const id = `row:${t.id}:${r.id}`;
    const title = normTitle({
      ...(base || { template: t.template }),
      id,
      f0: fill(t.map.f0, t, r),
      f1: fill(t.map.f1, t, r),
      f2: fill(t.map.f2, t, r),
      duration: 0,
    });
    title.flag = this._rowFlag(t, r);
    const img = t.columns.find((x) => x.kind === 'image' && r.cells[x.id]);
    const media = img ? this._cellMedia(r.cells[img.id]) : null;
    if (media && media.type === 'image') title.logo = media.id;
    if (media && media.type !== 'audio' && title.template === 'naslov-grafika') title.image = media.id;
    title.rowName = this._rowName(t, r);
    this.titles.virtual.set(id, title);
    return title;
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
    this._requireTable(id);
    this.tables.set(id, patch || {});
    this._saveTables();
    await this._refreshRows(id);
  },

  addColumn(id, name, kind) {
    const c = this.tables.addColumn(this._requireTable(id).id, name, kind);
    this._saveTables();
    return c.id;
  },

  async setColumn(id, colId, patch) {
    if (!this.tables.setColumn(this._requireTable(id).id, colId, patch || {})) this._error('Stolpec ne obstaja');
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
  },

  // ---------- v živo ----------

  /** Pripravi osebo (po številki ali id vrstice) kot naslednji napis; pokaže ga v preview. */
  async cueRow({ tableId = null, rowId = null, num = null } = {}) {
    const t = this._requireTable(tableId);
    const r = rowId ? t.rows.find((x) => x.id === rowId) : this.tables.findByNum(t.id, num);
    if (!r) this._error(num ? `Oseba s številko ${num} ni v tabeli "${t.name}"` : 'Vrstica ne obstaja');
    const title = this._rowTitle(t, r);
    this.rowCued = { tableId: t.id, rowId: r.id };
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
    if (this._nextKind === 'row') this._nextKind = 'list';
    if (c && this.titlePvw === `row:${c.tableId}:${c.rowId}`) await this.titlePreview(null).catch(() => {});
    this._changed();
  },

  /** GO za pripravljeno osebo. */
  async _rowGo() {
    const c = this.rowCued;
    const t = this.tables.get(c.tableId);
    const r = t && t.rows.find((x) => x.id === c.rowId);
    if (!r) {
      await this._uncueRow();
      this._error('Pripravljene osebe ni več v tabeli');
    }
    this._requireEngine();
    const title = this._rowTitle(t, r);
    const key = title.id;
    await this._ovlReplace(key);
    const prev = this.ovlLive.get(key);
    if (prev) clearTimeout(prev.timer);
    const gen = ++this._ovlGen;
    this.ovlLive.set(key, { titleId: key, gen, row: true });
    if (this._titleOnLayer(key) !== null) await this._refreshTitle(title, false).catch(() => {});
    else await this.titleOn(key);
    if (t.seconds) {
      const rec = this.ovlLive.get(key);
      rec.timer = setTimeout(() => {
        const cur = this.ovlLive.get(key);
        if (cur && cur.gen === gen) this.overlayOff(key).catch(() => {});
      }, t.seconds * 1000);
      if (rec.timer.unref) rec.timer.unref();
    }
    this._rowAction(t, r, 'go');
    await this._uncueRow();
  },

  /** Puščici: naslednja/prejšnja oseba v tabeli (če je pripravljena oseba), sicer seznam Čez program. */
  async overlayStep(dir) {
    const d = dir > 0 ? 1 : -1;
    if (this._nextKind === 'row' && this.rowCued || (!this.playlist.overlays.length && this.tables.activeTable())) {
      const t = this._requireTable(this.rowCued ? this.rowCued.tableId : null);
      const filled = t.rows.filter((r) => Object.keys(r.cells).length);
      if (!filled.length) return;
      let i = this.rowCued ? filled.findIndex((r) => r.id === this.rowCued.rowId) : -1;
      i = i === -1 ? (d > 0 ? 0 : filled.length - 1) : Math.max(0, Math.min(filled.length - 1, i + d));
      await this.cueRow({ tableId: t.id, rowId: filled[i].id });
      return;
    }
    const list = this.playlist.overlays;
    if (!list.length) return;
    const i = list.findIndex((o) => o.id === this.ovlNext);
    const j = i === -1 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + d));
    this.setOverlayNext(list[j].id);
  },

  /** Ime naslednjega za prikaz ob GO (oseba ali vnos seznama). */
  _nextLabel() {
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
