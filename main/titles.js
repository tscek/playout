'use strict';
// Napisi (grafika iz HTML predlog): seznam napisov projekta, predloge in celostna podoba.
// Podatki: <projekt>/titles.json  { items: [...] }, celostna podoba v project.json (brand).

const fs = require('fs');
const path = require('path');
const { newId } = require('./media');

/** Vgrajene predloge (datoteke v main/gfx). */
const TEMPLATES = [
  {
    id: 'klasicni',
    name: 'Klasični napis',
    fields: [{ key: 'f0', label: 'Ime / naslov' }, { key: 'f1', label: 'Funkcija / podnaslov' }],
    aligns: ['left', 'center', 'right'],
  },
  {
    id: 'moderni',
    name: 'Moderni napis (brez ozadja)',
    fields: [{ key: 'f0', label: 'Ime / naslov' }, { key: 'f1', label: 'Funkcija / podnaslov' }],
    aligns: ['left', 'center', 'right'],
  },
  {
    id: 'pas',
    name: 'Pas čez cel zaslon',
    fields: [{ key: 'f0', label: 'Naslov' }, { key: 'f1', label: 'Besedilo' }, { key: 'f2', label: 'Oznaka (npr. V ŽIVO)' }],
    aligns: [],
  },
  {
    id: 'naslov',
    name: 'Naslov na sredini',
    fields: [{ key: 'f0', label: 'Naslov' }, { key: 'f1', label: 'Podnaslov' }],
    aligns: [],
  },
  {
    id: 'ura',
    name: 'Ura / odštevanje',
    fields: [{ key: 'f0', label: 'Napis nad uro (neobvezno)' }],
    aligns: ['tr', 'tl', 'br', 'bl', 'center'],
    clock: true,
  },
  {
    id: 'logo',
    name: 'Logotip v kotu',
    fields: [],
    aligns: ['tr', 'tl', 'br', 'bl'],
  },
  {
    id: 'trak',
    name: 'Tekoči trak (novice)',
    fields: [{ key: 'f0', label: 'Besedilo (več novic loči z znakom |)' }, { key: 'f1', label: 'Oznaka (npr. NOVICE)' }],
    aligns: [],
  },
  {
    id: 'oddaja',
    name: 'Naslov oddaje v kotu',
    fields: [{ key: 'f0', label: 'Naslov oddaje' }, { key: 'f1', label: 'Podnaslov' }, { key: 'f2', label: 'Oznaka (npr. V ŽIVO)' }],
    aligns: ['tl', 'tr'],
  },
];

// Lastne predloge (HTML v mapi "predloge" v podatkih aplikacije). Nastavi jih loadUserTemplates.
let userTemplates = [];

function allTemplates() {
  return TEMPLATES.concat(userTemplates);
}

/**
 * Prebere lastne predloge iz mape. Vsaka predloga je .html z enakimi funkcijami kot vgrajene (update, play, stop).
 * Neobvezno v <head>: <meta name="playout-name" content="Ime">, <meta name="playout-fields" content="Ime|Funkcija">,
 * <meta name="playout-aligns" content="left,center,right">.
 */
function loadUserTemplates(dir) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.html?$/i.test(f)).sort((a, b) => a.localeCompare(b, 'sl'));
  } catch { /* mape še ni */ }
  const used = new Set();
  for (const f of files.slice(0, 100)) {
    let html = '';
    try {
      html = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const meta = (name) => {
      const m = new RegExp(`<meta\\s+name=["']playout-${name}["']\\s+content=["']([^"']*)["']`, 'i').exec(html);
      return m ? m[1].trim() : '';
    };
    const base = f.replace(/\.html?$/i, '');
    let slug = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'predloga';
    while (used.has(slug)) slug += '-2';
    used.add(slug);
    const labels = (meta('fields') || 'Besedilo 1|Besedilo 2|Besedilo 3').split('|').map((x) => x.trim()).filter(Boolean).slice(0, 3);
    const aligns = meta('aligns').split(',').map((x) => x.trim()).filter((x) => ['left', 'center', 'right', 'tl', 'tr', 'bl', 'br'].includes(x));
    out.push({
      id: `user-${slug}`,
      name: `${meta('name') || base} (moja)`,
      fields: labels.map((label, i) => ({ key: `f${i}`, label })),
      aligns,
      user: true,
      file: path.join(dir, f),
    });
  }
  userTemplates = out;
  return out;
}

const FONTS = ['Segoe UI', 'Arial', 'Calibri', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Bahnschrift', 'Georgia', 'Montserrat', 'Roboto'];

const DEFAULT_BRAND = { logo: null, bg: '#0b3d91', accent: '#f5a623', text: '#ffffff', font: 'Segoe UI' };

const CLOCK_MODES = ['clock', 'until', 'timer', 'stopwatch'];

const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

function normBrand(b) {
  const x = b && typeof b === 'object' ? b : {};
  return {
    logo: typeof x.logo === 'string' && x.logo ? x.logo : null,
    bg: isColor(x.bg) ? x.bg : DEFAULT_BRAND.bg,
    accent: isColor(x.accent) ? x.accent : DEFAULT_BRAND.accent,
    text: isColor(x.text) ? x.text : DEFAULT_BRAND.text,
    font: typeof x.font === 'string' && x.font.trim() ? x.font.trim().slice(0, 60) : DEFAULT_BRAND.font,
  };
}

function templateOf(id) {
  return allTemplates().find((t) => t.id === id) || TEMPLATES[0];
}

/**
 * Napis. Barve in logo: null = iz celostne podobe projekta, sicer svoja vrednost.
 * logo: null = logo projekta, '' = brez logotipa, id medija = drug logo.
 */
function normTitle(t) {
  const x = t && typeof t === 'object' ? t : {};
  const tpl = templateOf(x.template);
  const dur = Number(x.duration);
  return {
    id: typeof x.id === 'string' && x.id ? x.id : newId(),
    // lastna predloga, ki je trenutno ni v mapi, ohrani svoje ime (prikaže se kot klasični napis)
    template: tpl.id !== x.template && typeof x.template === 'string' && /^user-[a-z0-9-]+$/.test(x.template) ? x.template : tpl.id,
    f0: str(x.f0),
    f1: str(x.f1),
    f2: str(x.f2, 60),
    align: tpl.aligns.includes(x.align) ? x.align : tpl.aligns[0] || '',
    bg: isColor(x.bg) ? x.bg : null,
    accent: isColor(x.accent) ? x.accent : null,
    text: isColor(x.text) ? x.text : null,
    logo: x.logo === '' ? '' : typeof x.logo === 'string' && x.logo ? x.logo : null,
    duration: Number.isFinite(dur) && dur > 0 ? Math.min(3600, Math.round(dur)) : 0, // s, 0 = ostane
    size: Number.isFinite(Number(x.size)) && Number(x.size) > 0 ? Math.max(0.4, Math.min(2, Math.round(Number(x.size) * 100) / 100)) : 1, // 1 = običajna velikost
    // ura: clock = trenutni čas, until = odštevanje do ure (target), timer = odštevanje (seconds), stopwatch = štoparica
    mode: CLOCK_MODES.includes(x.mode) ? x.mode : 'clock',
    target: typeof x.target === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(x.target) ? x.target : '',
    seconds: Number.isFinite(Number(x.seconds)) && Number(x.seconds) > 0 ? Math.min(86400, Math.round(Number(x.seconds))) : 300,
  };
}

const TITLE_KEYS = ['template', 'f0', 'f1', 'f2', 'align', 'bg', 'accent', 'text', 'logo', 'duration', 'mode', 'target', 'seconds', 'size'];

class Titles {
  constructor(data) {
    const items = data && Array.isArray(data.items) ? data.items : [];
    this.items = items.slice(0, 500).map(normTitle);
  }

  toJSON() {
    return { items: this.items };
  }

  get(id) {
    return this.items.find((t) => t.id === id) || null;
  }

  add(patch = {}, afterId = null) {
    const t = normTitle({ ...patch, id: undefined });
    const i = afterId ? this.items.findIndex((x) => x.id === afterId) : -1;
    if (i === -1) this.items.push(t);
    else this.items.splice(i + 1, 0, t);
    return t;
  }

  set(id, patch = {}) {
    const t = this.get(id);
    if (!t) return null;
    const merged = { ...t };
    for (const k of TITLE_KEYS) if (k in patch) merged[k] = patch[k];
    if (patch.resetStyle) Object.assign(merged, { bg: null, accent: null, text: null, logo: null });
    if ('template' in patch && patch.template !== t.template) merged.align = undefined;
    Object.assign(t, normTitle(merged));
    return t;
  }

  remove(id) {
    this.items = this.items.filter((t) => t.id !== id);
  }

  move(id, toIndex) {
    const i = this.items.findIndex((t) => t.id === id);
    if (i === -1) return;
    const [t] = this.items.splice(i, 1);
    this.items.splice(Math.max(0, Math.min(this.items.length, toIndex)), 0, t);
  }

  /** Mediji, ki jih napisi uporabljajo kot logo, ne obstajajo več: nazaj na logo projekta. */
  forgetMedia(mediaId) {
    for (const t of this.items) if (t.logo === mediaId) t.logo = null;
  }
}

/** Ime za prikaz (seznam, bližnjice, API). */
function titleLabel(t) {
  const tpl = templateOf(t.template);
  if (tpl.clock) {
    const m = { clock: 'Ura', until: `Odštevanje do ${t.target || '?'}`, timer: `Odštevanje ${Math.floor(t.seconds / 60)}:${String(t.seconds % 60).padStart(2, '0')}`, stopwatch: 'Štoparica' }[t.mode];
    return t.f0 ? `${m} – ${t.f0}` : m;
  }
  const txt = [t.f0, t.f1].filter(Boolean).join(' – ');
  return txt || tpl.name;
}

/** Predloge iz aplikacije in lastne predloge prekopira v mapo predlog motorja (samo spremenjene). */
function installTemplates(targetDir) {
  if (!targetDir) return;
  const src = path.join(__dirname, 'gfx');
  fs.mkdirSync(targetDir, { recursive: true });
  const list = fs.readdirSync(src).filter((f) => f.endsWith('.html')).map((f) => ({ from: path.join(src, f), name: f }));
  for (const t of userTemplates) list.push({ from: t.file, name: `${t.id}.html` });
  for (const { from, name } of list) {
    let data;
    try {
      data = fs.readFileSync(from);
    } catch {
      continue;
    }
    const dst = path.join(targetDir, `playout-${name}`);
    let same = false;
    try {
      same = fs.readFileSync(dst).equals(data);
    } catch { /* še ne obstaja */ }
    if (!same) fs.writeFileSync(dst, data);
  }
}

module.exports = { CLOCK_MODES, TEMPLATES, FONTS, DEFAULT_BRAND, normBrand, normTitle, Titles, titleLabel, templateOf, installTemplates,
  loadUserTemplates, allTemplates };
