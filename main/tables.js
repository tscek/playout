'use strict';
// Tabele oseb (podatki za napise): stolpci kot v Excelu, vsaka vrstica ima svojo številko za klic.
// Podatki: <projekt>/tables.json  { tables: [...] }
// Iz vrstice nastane napis: predloga in slog iz izbranega "vzorčnega" napisa, besedila iz stolpcev po vzorcu
// (npr. naslov "{Ime} {Priimek}", podnaslov "{Funkcija}, {Klub}").

const { newId } = require('./media');

const KINDS = ['text', 'flag', 'image', 'action']; // besedilo, država (zastava), slika iz Medijev, kamera/akcija
const WHEN = ['cue', 'go', 'off']; // kdaj se sproži akcija iz stolpca: ob pripravi, ob GO, nikoli
const MAX_ROWS = 2000;
const MAX_COLS = 30;

// ime tabele se uporablja v {Tabela.Stolpec}, zato brez pik in zavitih oklepajev
const cleanName = (v) => (v === null || v === undefined ? '' : String(v)).slice(0, 60).replace(/[{}.]/g, '').replace(/\s+/g, ' ').trim();
const str = (v, max = 500) => (v === null || v === undefined ? '' : String(v)).slice(0, max);

function normCol(c) {
  return {
    id: typeof c.id === 'string' && c.id ? c.id : newId(),
    name: str(c.name, 40).replace(/[{}]/g, '').trim() || 'Stolpec',
    kind: KINDS.includes(c.kind) ? c.kind : 'text',
  };
}

function normRow(r, cols) {
  const cells = {};
  const src = r && typeof r.cells === 'object' && r.cells ? r.cells : {};
  for (const c of cols) if (src[c.id] !== undefined && src[c.id] !== '') cells[c.id] = str(src[c.id]);
  const n = Number(r && r.num);
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newId(),
    num: Number.isInteger(n) && n > 0 && n < 100000 ? n : null,
    cells,
  };
}

function defaultColumns() {
  return [
    { name: 'Ime', kind: 'text' },
    { name: 'Funkcija', kind: 'text' },
    { name: 'Država', kind: 'flag' },
    { name: 'Slika', kind: 'image' },
    { name: 'Kamera', kind: 'action' },
  ].map(normCol);
}

function normTable(t) {
  const x = t && typeof t === 'object' ? t : {};
  const columns = (Array.isArray(x.columns) && x.columns.length ? x.columns : defaultColumns()).slice(0, MAX_COLS).map(normCol);
  const rows = (Array.isArray(x.rows) ? x.rows : []).slice(0, MAX_ROWS).map((r) => normRow(r || {}, columns));
  const first = columns[0] ? `{${columns[0].name}}` : '';
  const second = columns[1] && columns[1].kind === 'text' ? `{${columns[1].name}}` : '';
  const m = x.map && typeof x.map === 'object' ? x.map : { f0: first, f1: second, f2: '' };
  const dur = Number(x.seconds);
  return {
    id: typeof x.id === 'string' && x.id ? x.id : newId(),
    name: cleanName(x.name) || 'Osebe',
    columns,
    rows,
    styleTitleId: typeof x.styleTitleId === 'string' && x.styleTitleId ? x.styleTitleId : null, // (staro, v0.17) vzorčni napis
    titleId: typeof x.titleId === 'string' && x.titleId ? x.titleId : null, // napis za GO (polja s {Tabela.Stolpec})
    liveUpdate: !!x.liveUpdate, // ◀ ▶ med napisom na programu: takoj zamenja osebo (brez animacije)
    template: typeof x.template === 'string' && x.template ? x.template : 'klasicni', // če vzorčnega napisa ni
    map: { f0: str(m.f0, 200), f1: str(m.f1, 200), f2: str(m.f2, 200) },
    seconds: Number.isFinite(dur) && dur > 0 ? Math.min(3600, Math.round(dur)) : 0, // dol po X s (0 = ostane)
    actionWhen: WHEN.includes(x.actionWhen) ? x.actionWhen : 'cue',
  };
}

/** Številka vrstice: lastna ali zaporedna (1, 2, 3 ...). */
function rowNum(table, row) {
  return row.num || table.rows.indexOf(row) + 1;
}

/** Počisti ločila, ki ostanejo ob praznih vrednostih (vsaka vrstica posebej). */
function tidy(s) {
  return String(s).split('\n').map((line) => line.replace(/[ \t]+/g, ' ')
    .replace(/\(\s*\)/g, '')
    .replace(/(\s*[,;|·–-]\s*)+(?=\s*[,;|·–-])/g, '')
    .replace(/^\s*[,;|·–-]\s*/, '')
    .replace(/\s*[,;|·–-]\s*$/, '')
    .replace(/\s*[,;]\s*(?=\()/g, ' ')
    .trim()).join('\n').trim();
}

/** Vstavi vrednosti stolpcev v vzorec in počisti ločila, ki ostanejo ob praznih stolpcih. */
function fill(pattern, table, row) {
  const byName = new Map(table.columns.map((c) => [c.name.toLowerCase(), c]));
  let s = String(pattern || '').replace(/\{([^{}]+)\}/g, (all, name) => {
    const k = name.trim().toLowerCase();
    if (k === '#' || k === 'št' || k === 'st') return String(rowNum(table, row));
    const c = byName.get(k);
    return c ? row.cells[c.id] || '' : '';
  });
  return tidy(s);
}

class Tables {
  constructor(data) {
    const list = data && Array.isArray(data.tables) ? data.tables : [];
    this.tables = [];
    for (const x of list.slice(0, 50)) {
      const t = normTable(x);
      t.name = this.uniqueName(t.name);
      this.tables.push(t);
    }
    const a = data && data.active;
    this.active = this.tables.some((t) => t.id === a) ? a : this.tables[0] ? this.tables[0].id : null;
  }

  toJSON() {
    return { tables: this.tables, active: this.active };
  }

  /** Ime, ki ga nima nobena druga tabela (za sklice {Tabela.Stolpec}). */
  uniqueName(name, exceptId = null) {
    const base = cleanName(name) || 'Osebe';
    const taken = (n) => this.tables.some((t) => t.id !== exceptId && t.name.toLowerCase() === n.toLowerCase());
    if (!taken(base)) return base;
    for (let i = 2; ; i++) if (!taken(`${base} ${i}`)) return `${base} ${i}`;
  }

  byName(name) {
    const k = String(name || '').trim().toLowerCase();
    return this.tables.find((t) => t.name.toLowerCase() === k) || null;
  }

  get(id) {
    return this.tables.find((t) => t.id === id) || null;
  }

  activeTable() {
    return this.get(this.active) || this.tables[0] || null;
  }

  add(name) {
    const t = normTable({ name: this.uniqueName(name || `Tabela ${this.tables.length + 1}`) });
    this.tables.push(t);
    this.active = t.id;
    return t;
  }

  remove(id) {
    this.tables = this.tables.filter((t) => t.id !== id);
    if (this.active === id) this.active = this.tables[0] ? this.tables[0].id : null;
  }

  /** Nastavitve tabele: name, titleId, liveUpdate, seconds, actionWhen (in staro: styleTitleId, template, map). */
  set(id, patch = {}) {
    const t = this.get(id);
    if (!t) return null;
    const keys = ['name', 'styleTitleId', 'template', 'map', 'seconds', 'actionWhen', 'titleId', 'liveUpdate'];
    const merged = { ...t };
    for (const k of keys) if (k in patch) merged[k] = k === 'map' ? { ...t.map, ...patch.map } : patch[k];
    const n = normTable(merged);
    for (const k of keys) t[k] = n[k];
    t.name = this.uniqueName(t.name, t.id);
    return t;
  }

  // ---------- stolpci ----------

  addColumn(id, name, kind) {
    const t = this.get(id);
    if (!t) return null;
    if (t.columns.length >= MAX_COLS) throw new Error(`Največ ${MAX_COLS} stolpcev`);
    const c = normCol({ name: name || `Stolpec ${t.columns.length + 1}`, kind });
    t.columns.push(c);
    return c;
  }

  setColumn(id, colId, patch) {
    const t = this.get(id);
    const c = t && t.columns.find((x) => x.id === colId);
    if (!c) return null;
    const old = c.name;
    const n = normCol({ ...c, ...patch, id: c.id });
    c.name = n.name;
    c.kind = n.kind;
    if (old !== c.name) {
      // vzorci napisa sledijo preimenovanju stolpca
      for (const k of ['f0', 'f1', 'f2']) t.map[k] = t.map[k].split(`{${old}}`).join(`{${c.name}}`);
    }
    return c;
  }

  removeColumn(id, colId) {
    const t = this.get(id);
    if (!t) return;
    t.columns = t.columns.filter((c) => c.id !== colId);
    for (const r of t.rows) delete r.cells[colId];
  }

  moveColumn(id, colId, toIndex) {
    const t = this.get(id);
    const i = t ? t.columns.findIndex((c) => c.id === colId) : -1;
    if (i === -1) return;
    const [c] = t.columns.splice(i, 1);
    t.columns.splice(Math.max(0, Math.min(t.columns.length, toIndex)), 0, c);
  }

  // ---------- vrstice in celice ----------

  addRows(id, count = 1, index) {
    const t = this.get(id);
    if (!t) return [];
    const n = Math.max(1, Math.min(MAX_ROWS - t.rows.length, Math.round(count)));
    const rows = Array.from({ length: n }, () => normRow({}, t.columns));
    const at = Number.isInteger(index) ? Math.max(0, Math.min(t.rows.length, index)) : t.rows.length;
    t.rows.splice(at, 0, ...rows);
    return rows;
  }

  removeRows(id, rowIds) {
    const t = this.get(id);
    if (!t) return;
    const set = new Set(rowIds || []);
    t.rows = t.rows.filter((r) => !set.has(r.id));
  }

  moveRow(id, rowId, toIndex) {
    const t = this.get(id);
    const i = t ? t.rows.findIndex((r) => r.id === rowId) : -1;
    if (i === -1) return;
    const [r] = t.rows.splice(i, 1);
    t.rows.splice(Math.max(0, Math.min(t.rows.length, toIndex)), 0, r);
  }

  /**
   * Zapiše celice. cells: [{ row (indeks vrstice), col (indeks stolpca ali '#'), value }].
   * Vrstice, ki jih še ni (lepljenje iz Excela), se dodajo.
   */
  setCells(id, cells) {
    const t = this.get(id);
    if (!t || !Array.isArray(cells)) return null;
    for (const c of cells.slice(0, 20000)) {
      const ri = Number(c.row);
      if (!Number.isInteger(ri) || ri < 0 || ri >= MAX_ROWS) continue;
      while (t.rows.length <= ri) t.rows.push(normRow({}, t.columns));
      const row = t.rows[ri];
      if (c.col === '#') {
        const n = parseInt(String(c.value).trim(), 10);
        row.num = Number.isInteger(n) && n > 0 && n < 100000 ? n : null;
        continue;
      }
      const col = t.columns[Number(c.col)];
      if (!col) continue;
      const v = str(c.value).replace(/\r?\n/g, ' ').trim();
      if (v) row.cells[col.id] = v;
      else delete row.cells[col.id];
    }
    return t;
  }

  /** Vrstica po številki za klic (lastna številka ima prednost pred zaporedno). */
  findByNum(id, num) {
    const t = this.get(id);
    const n = Number(num);
    if (!t || !Number.isInteger(n) || n <= 0) return null;
    return t.rows.find((r) => r.num === n) || t.rows.find((r, i) => !r.num && i + 1 === n && Object.keys(r.cells).length) || null;
  }

  forgetTitle(titleId) {
    for (const t of this.tables) {
      if (t.styleTitleId === titleId) t.styleTitleId = null;
      if (t.titleId === titleId) t.titleId = null;
    }
  }
}

const VAR_RE = /\{([^{}.]+)\.([^{}]+)\}/g;

/** Tabele, ki jih besedila omenjajo ({Tabela.Stolpec}), v vrstnem redu prve omembe. */
function tablesIn(texts, tables) {
  const out = [];
  for (const s of texts) {
    for (const m of String(s || '').matchAll(VAR_RE)) {
      const t = tables.find((x) => x.name.trim().toLowerCase() === m[1].trim().toLowerCase());
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/**
 * Zamenja {Tabela.Stolpec} z vrednostmi; rowOf(tabela) vrne vrstico, ki se uporabi (ali null).
 * {Tabela.#} je številka vrstice. Ločila ob praznih vrednostih se počistijo kot pri fill.
 */
function fillVars(text, tables, rowOf) {
  const src = String(text || '');
  if (!src.includes('{')) return src;
  let touched = false;
  const out = src.replace(VAR_RE, (all, tn, cn) => {
    const t = tables.find((x) => x.name.trim().toLowerCase() === tn.trim().toLowerCase());
    if (!t) return all;
    touched = true;
    const row = rowOf(t);
    if (!row) return '';
    const k = cn.trim().toLowerCase();
    if (k === '#' || k === 'št' || k === 'st') return String(rowNum(t, row));
    const c = t.columns.find((x) => x.name.toLowerCase() === k);
    return c ? row.cells[c.id] || '' : '';
  });
  if (!touched) return out;
  return tidy(out);
}

/** Ob preimenovanju tabele ali stolpca popravi sklice v besedilu. */
function renameVars(text, tableName, oldCol, newCol, newTable = null) {
  return String(text || '').replace(VAR_RE, (all, tn, cn) => {
    if (tn.trim().toLowerCase() !== tableName.trim().toLowerCase()) return all;
    const col = oldCol !== null && cn.trim().toLowerCase() === oldCol.toLowerCase() ? newCol : cn;
    return `{${newTable || tn}.${col}}`;
  });
}

module.exports = { Tables, normTable, fill, fillVars, tablesIn, renameVars, rowNum, KINDS, WHEN };
