'use strict';
// Projekti: vsak ima svojo medijsko mapo, seznam medijev in playlisto.
// Podatki: <dataDir>/projects/index.json in <dataDir>/projects/<id>/{project,library,playlist}.json

const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./store');
const { mediaType, newId } = require('./media');

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules']);
const MAX_FILES = 10000;
const MAX_DEPTH = 12;

class ProjectStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.root = path.join(dataDir, 'projects');
    this.indexFile = path.join(this.root, 'index.json');
    this.index = readJson(this.indexFile, null);
  }

  /** Prvi zagon nove verzije: dosedanji seznam medijev in playlista postaneta projekt "Moj projekt". */
  ensure({ panicSource = '' } = {}) {
    if (this.index && Array.isArray(this.index.list) && this.index.list.length) {
      if (!this.index.list.some((p) => p.id === this.index.current)) this.index.current = this.index.list[0].id;
      return;
    }
    const id = newId();
    const dir = this.dir(id);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['library.json', 'playlist.json']) {
      const src = path.join(this.dataDir, f);
      for (const suffix of ['', '.bak']) {
        try {
          if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, path.join(dir, f + suffix));
        } catch { /* ni kritično */ }
      }
    }
    writeJson(path.join(dir, 'project.json'), { name: 'Moj projekt', mediaDir: null, panicSource });
    this.index = { current: id, list: [{ id, name: 'Moj projekt' }] };
    this._saveIndex();
  }

  _saveIndex() {
    writeJson(this.indexFile, this.index);
  }

  dir(id) {
    return path.join(this.root, id);
  }

  get currentId() {
    return this.index.current;
  }

  list() {
    return this.index.list.map((p) => ({ ...p }));
  }

  has(id) {
    return this.index.list.some((p) => p.id === id);
  }

  meta(id) {
    const m = readJson(path.join(this.dir(id), 'project.json'), {});
    const entry = this.index.list.find((p) => p.id === id);
    return {
      name: (entry && entry.name) || m.name || 'Projekt',
      mediaDir: typeof m.mediaDir === 'string' && m.mediaDir ? m.mediaDir : null,
      panicSource: typeof m.panicSource === 'string' ? m.panicSource : '',
      brand: m.brand && typeof m.brand === 'object' ? m.brand : null,
    };
  }

  saveMeta(id, meta) {
    writeJson(path.join(this.dir(id), 'project.json'), meta);
    const entry = this.index.list.find((p) => p.id === id);
    if (entry && entry.name !== meta.name) {
      entry.name = meta.name;
      this._saveIndex();
    }
  }

  uniqueName(name) {
    const base = String(name || '').trim() || 'Nov projekt';
    const names = new Set(this.index.list.map((p) => p.name.toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
  }

  create(name, mediaDir = null) {
    const id = newId();
    const nm = this.uniqueName(name);
    fs.mkdirSync(this.dir(id), { recursive: true });
    writeJson(path.join(this.dir(id), 'project.json'), { name: nm, mediaDir, panicSource: '' });
    this.index.list.push({ id, name: nm });
    this._saveIndex();
    return id;
  }

  setCurrent(id) {
    if (!this.has(id)) throw new Error('Projekt ne obstaja');
    this.index.current = id;
    this._saveIndex();
  }

  remove(id) {
    if (id === this.index.current) throw new Error('Trenutno odprtega projekta ni mogoče izbrisati. Najprej odpri drugega.');
    this.index.list = this.index.list.filter((p) => p.id !== id);
    this._saveIndex();
    try {
      fs.rmSync(this.dir(id), { recursive: true, force: true });
    } catch { /* ni kritično */ }
  }
}

/** Relativna pot z "/" (enako na vseh sistemih). */
function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function isInside(root, abs) {
  if (!root) return false;
  const r = path.relative(path.resolve(root), path.resolve(abs));
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
}

/** Vse medijske datoteke in podmape v mapi (rekurzivno). */
function scanMedia(root) {
  const files = [];
  const folders = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        folders.push(toRel(root, abs));
        try {
          walk(abs, depth + 1);
        } catch { /* mapa ni berljiva */ }
      } else if (e.isFile() && mediaType(e.name)) {
        try {
          const st = fs.statSync(abs);
          files.push({ rel: toRel(root, abs), abs, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        } catch { /* datoteka je izginila */ }
        if (files.length >= MAX_FILES) return;
      }
    }
  };
  walk(root, 0);
  folders.sort((a, b) => a.localeCompare(b));
  return { files, folders };
}

/** Prosto ime v mapi: "ime.mp4", "ime (2).mp4", ... */
function freeName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let cand = name;
  for (let i = 2; fs.existsSync(path.join(dir, cand)); i++) cand = `${base} (${i})${ext}`;
  return cand;
}

/** Ime mape brez znakov, ki jih Windows ne dovoli. */
function safeFolderName(name) {
  const n = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().replace(/[. ]+$/, '');
  if (!n) throw new Error('Neveljavno ime mape');
  return n;
}

/** Normalizira relativno pot podmape ("" = koren). Ne dovoli izhoda iz projektne mape. */
function safeRelFolder(rel) {
  const parts = String(rel || '').split(/[\\/]+/).filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new Error('Neveljavna mapa');
  return parts.join('/');
}

module.exports = { ProjectStore, scanMedia, freeName, safeFolderName, safeRelFolder, isInside, toRel };
