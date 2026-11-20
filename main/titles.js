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
];

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
  return TEMPLATES.find((t) => t.id === id) || TEMPLATES[0];
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
    template: tpl.id,
    f0: str(x.f0),
    f1: str(x.f1),
    f2: str(x.f2, 60),
    align: tpl.aligns.includes(x.align) ? x.align : tpl.aligns[0] || '',
    bg: isColor(x.bg) ? x.bg : null,
    accent: isColor(x.accent) ? x.accent : null,
    text: isColor(x.text) ? x.text : null,
    logo: x.logo === '' ? '' : typeof x.logo === 'string' && x.logo ? x.logo : null,
    duration: Number.isFinite(dur) && dur > 0 ? Math.min(3600, Math.round(dur)) : 0, // s, 0 = ostane
    // ura: clock = trenutni čas, until = odštevanje do ure (target), timer = odštevanje (seconds), stopwatch = štoparica
    mode: CLOCK_MODES.includes(x.mode) ? x.mode : 'clock',
    target: typeof x.target === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(x.target) ? x.target : '',
    seconds: Number.isFinite(Number(x.seconds)) && Number(x.seconds) > 0 ? Math.min(86400, Math.round(Number(x.seconds))) : 300,
  };
}

const TITLE_KEYS = ['template', 'f0', 'f1', 'f2', 'align', 'bg', 'accent', 'text', 'logo', 'duration', 'mode', 'target', 'seconds'];

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

/** Predloge iz aplikacije prekopira v mapo predlog motorja (samo spremenjene). */
function installTemplates(targetDir) {
  if (!targetDir) return;
  const src = path.join(__dirname, 'gfx');
  fs.mkdirSync(targetDir, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (!f.endsWith('.html')) continue;
    const data = fs.readFileSync(path.join(src, f));
    const dst = path.join(targetDir, `playout-${f}`);
    let same = false;
    try {
      same = fs.readFileSync(dst).equals(data);
    } catch { /* še ne obstaja */ }
    if (!same) fs.writeFileSync(dst, data);
  }
}

module.exports = { CLOCK_MODES, TEMPLATES, FONTS, DEFAULT_BRAND, normBrand, normTitle, Titles, titleLabel, templateOf, installTemplates };
