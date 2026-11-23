'use strict';
// Playlist: skupine posnetkov v vrstnem redu. Vsak vnos kaže na posnetek v knjižnici
// (isti posnetek je lahko v več skupinah ali večkrat v isti skupini).

const { newId } = require('./media');

const DEFAULT_IMAGE_SECONDS = 5;

// Kaj se zgodi na koncu posnetka: ustavi, naprej s CUT, naprej s prehodom, (samo vnos) ponavljaj posnetek.
const GROUP_ENDS = ['stop', 'cut', 'mix'];
const ENTRY_ENDS = ['stop', 'cut', 'mix', 'loop'];

function makeGroup(name) {
  return { id: newId(), name: name || 'Skupina', end: 'stop', loop: false, imageSeconds: DEFAULT_IMAGE_SECONDS, kenBurns: false, blur: false, collapsed: false, items: [] };
}

function optSeconds(v, min = 0) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) return null;
  return Math.round(n * 1000) / 1000;
}

/** Fade v sekundah: null = privzeto iz nastavitev, 0 = izklopljeno. */
function optFade(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(10, Math.round(n * 100) / 100));
}

/** Vnos z akcijo (ATEM, PTZ, XR18 ...): traja 0 s, sproži se, ko playlista pride do njega. */
function normActionEntry(e) {
  return {
    id: e.id,
    kind: 'action',
    mediaId: null,
    actionId: e.actionId,
    delay: Math.max(0, Math.min(3600, optSeconds(e.delay) || 0)), // koliko sekund pozneje
    layers: [],
  };
}

const isAction = (e) => !!(e && e.kind === 'action');

function normEntry(e) {
  if (e && (e.kind === 'action' || (!e.mediaId && typeof e.actionId === 'string'))) return normActionEntry(e);
  return {
    id: e.id,
    mediaId: e.mediaId,
    end: ENTRY_ENDS.includes(e.end) ? e.end : null, // null = kot skupina
    seconds: optSeconds(e.seconds, 1), // trajanje slike; null = kot skupina
    inSec: optSeconds(e.inSec),
    outSec: optSeconds(e.outSec),
    startAction: typeof e.startAction === 'string' && e.startAction ? e.startAction : null, // akcija ob začetku
    endAction: typeof e.endAction === 'string' && e.endAction ? e.endAction : null, // akcija ob koncu
    endLead: Math.max(0, Math.min(30, optSeconds(e.endLead) || 0)), // koliko sekund pred koncem
    titleId: typeof e.titleId === 'string' && e.titleId ? e.titleId : null, // napis, ki gre na zaslon s tem vnosom
    titleIn: Math.max(0, Math.min(3600, optSeconds(e.titleIn) || 0)), // čez koliko sekund
    titleOut: Math.max(0, Math.min(3600, optSeconds(e.titleOut) || 0)), // koliko časa ostane (0 = do konca vnosa)
    fadeIn: optFade(e.fadeIn),
    fadeOut: optFade(e.fadeOut),
    ...normLook(e),
    layers: (Array.isArray(e.layers) ? e.layers : []).filter((l) => l && typeof l.mediaId === 'string').slice(0, MAX_LAYERS).map(normLayer),
  };
}

const FITS = ['fit', 'fill', 'stretch', 'blur']; // blur = ohrani razmerje, ob straneh zamegljena ista slika
const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};

/** Jakost, mute in postavitev slike vnosa (vsak vnos ima svoje). */
function normLook(e) {
  return {
    volumeDb: clamp(e.volumeDb, -40, 10, 0),
    muted: !!e.muted,
    fit: FITS.includes(e.fit) ? e.fit : null, // null = privzeto (ohrani razmerje)
    zoom: clamp(e.zoom, 0.1, 5, 1),
    posX: clamp(e.posX, -100, 100, 0),
    posY: clamp(e.posY, -100, 100, 0),
    ...normColor(e),
  };
}

const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'add', 'subtract', 'difference',
  'soft_light', 'hard_light', 'color_dodge', 'color_burn', 'exclusion', 'luminosity', 'color'];
const COLOR_KEYS = ['opacity', 'brightness', 'contrast', 'saturation'];

/** Prosojnost in barve (1 = brez spremembe). */
function normColor(e) {
  return {
    opacity: clamp(e.opacity, 0, 1, 1),
    brightness: clamp(e.brightness, 0, 3, 1),
    contrast: clamp(e.contrast, 0, 3, 1),
    saturation: clamp(e.saturation, 0, 3, 1),
  };
}

const LAYER_KEYS = ['posX', 'posY', 'scale', 'blend', 'hidden', 'loop', 'volumeDb', 'muted', 'name', ...COLOR_KEYS];
const MAX_LAYERS = 16;

/** Plast nad osnovnim posnetkom vnosa (logo, slika, video ...). */
function normLayer(l) {
  return {
    id: typeof l.id === 'string' && l.id ? l.id : newId(),
    mediaId: l.mediaId,
    posX: clamp(l.posX, -150, 150, 0), // % širine slike
    posY: clamp(l.posY, -150, 150, 0),
    scale: clamp(l.scale, 0.02, 5, 1), // 1 = čez cel zaslon (z ohranjenim razmerjem)
    blend: BLENDS.includes(l.blend) ? l.blend : 'normal',
    hidden: !!l.hidden,
    loop: l.loop !== false,
    volumeDb: clamp(l.volumeDb, -40, 10, 0),
    muted: !!l.muted,
    ...normColor(l),
  };
}

// ---------- seznam "Čez program" (napisi in grafike čez program, s svojim NEXT/GO) ----------

const OVL_ENDS = ['clear', 'hold', 'loop']; // grafika (video): na koncu izgine, ostane zadnja sličica, ponavlja
const OVL_GEO = ['posX', 'posY', 'scale', 'opacity', 'volumeDb', 'muted'];

function normOverlay(o) {
  const base = {
    id: typeof o.id === 'string' && o.id ? o.id : newId(),
    kind: o.kind === 'media' ? 'media' : 'title',
    seconds: Math.max(0, Math.min(3600, optSeconds(o.seconds) || 0)), // 0 = ostane, dokler ga ne umakneš
    keep: !!o.keep, // ne umakne prejšnjega (ostaneta oba)
    fade: clamp(o.fade, 0, 5, 0.4), // sekunde za prikaz/umik grafike
  };
  if (base.kind === 'title') return { ...base, titleId: typeof o.titleId === 'string' ? o.titleId : '' };
  return {
    ...base,
    mediaId: typeof o.mediaId === 'string' ? o.mediaId : '',
    end: OVL_ENDS.includes(o.end) ? o.end : 'clear',
    posX: clamp(o.posX, -150, 150, 0),
    posY: clamp(o.posY, -150, 150, 0),
    scale: clamp(o.scale, 0.02, 5, 1),
    opacity: clamp(o.opacity, 0, 1, 1),
    volumeDb: clamp(o.volumeDb, -40, 10, 0),
    muted: o.muted === undefined ? true : !!o.muted, // grafike so privzeto brez zvoka
  };
}

function normalize(data) {
  const groups = Array.isArray(data && data.groups) ? data.groups : [];
  const out = groups
    .filter((g) => g && typeof g.id === 'string')
    .map((g) => ({
      id: g.id,
      name: typeof g.name === 'string' && g.name.trim() ? g.name : 'Skupina',
      // v0.3.0 je imel autoFollow + followCut
      end: GROUP_ENDS.includes(g.end) ? g.end : g.autoFollow ? (g.followCut ? 'cut' : 'mix') : 'stop',
      loop: !!g.loop,
      imageSeconds: clampSeconds(g.imageSeconds),
      kenBurns: !!g.kenBurns, // slike v skupini počasi povečuje/pomanjšuje
      blur: !!g.blur, // slike brez lastnega prileganja dobijo zamegljeno ozadje
      collapsed: !!g.collapsed,
      items: (Array.isArray(g.items) ? g.items : []).filter((e) => e && e.id && (e.mediaId || (typeof e.actionId === 'string' && e.actionId))).map(normEntry),
    }));
  if (!out.length) out.push({ ...makeGroup('Playlist') });
  const overlays = (Array.isArray(data && data.overlays) ? data.overlays : [])
    .filter((o) => o && (o.titleId || o.mediaId)).slice(0, 500).map(normOverlay);
  return { groups: out, overlays };
}

function clampSeconds(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IMAGE_SECONDS;
  return Math.max(1, Math.min(3600, Math.round(n)));
}

class Playlist {
  constructor(data) {
    const n = normalize(data);
    this.groups = n.groups;
    this.overlays = n.overlays;
  }

  toJSON() {
    return { groups: this.groups, overlays: this.overlays };
  }

  // ---------- seznam "Čez program" ----------

  overlay(id) {
    return this.overlays.find((o) => o.id === id) || null;
  }

  /** spec: { kind: 'title', titleId } ali { kind: 'media', mediaId }. */
  addOverlay(spec, index) {
    if (!spec || !(spec.titleId || spec.mediaId)) return null;
    const o = normOverlay({ ...spec, id: null });
    const at = Number.isInteger(index) ? Math.max(0, Math.min(this.overlays.length, index)) : this.overlays.length;
    this.overlays.splice(at, 0, o);
    return o;
  }

  setOverlay(id, patch) {
    const o = this.overlay(id);
    if (!o || !patch) return null;
    const keys = ['seconds', 'keep', 'fade', ...(o.kind === 'media' ? ['end', ...OVL_GEO] : [])];
    const p = { ...patch };
    if (p.reset) Object.assign(p, { posX: 0, posY: 0, scale: 1, opacity: 1 });
    const next = normOverlay({ ...o, ...Object.fromEntries(keys.filter((k) => k in p).map((k) => [k, p[k]])) });
    for (const k of keys) o[k] = next[k];
    return o;
  }

  removeOverlay(id) {
    this.overlays = this.overlays.filter((o) => o.id !== id);
  }

  moveOverlay(id, toIndex) {
    const from = this.overlays.findIndex((o) => o.id === id);
    if (from === -1) return;
    const [o] = this.overlays.splice(from, 1);
    this.overlays.splice(Math.max(0, Math.min(this.overlays.length, toIndex)), 0, o);
  }

  group(groupId) {
    return this.groups.find((g) => g.id === groupId) || null;
  }

  /** Najde vnos po id; vrne { group, entry, index } ali null. */
  findEntry(entryId) {
    for (const group of this.groups) {
      const index = group.items.findIndex((e) => e.id === entryId);
      if (index !== -1) return { group, entry: group.items[index], index };
    }
    return null;
  }

  addGroup(name) {
    const g = makeGroup(name || `Skupina ${this.groups.length + 1}`);
    this.groups.push(g);
    return g;
  }

  removeGroup(groupId) {
    this.groups = this.groups.filter((g) => g.id !== groupId);
    if (!this.groups.length) this.groups.push(makeGroup('Playlist'));
  }

  setGroup(groupId, patch) {
    const g = this.group(groupId);
    if (!g) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) g.name = patch.name.trim().slice(0, 80);
    if ('end' in patch && GROUP_ENDS.includes(patch.end)) g.end = patch.end;
    if ('loop' in patch) g.loop = !!patch.loop;
    if ('collapsed' in patch) g.collapsed = !!patch.collapsed;
    if ('imageSeconds' in patch) g.imageSeconds = clampSeconds(patch.imageSeconds);
    if ('kenBurns' in patch) g.kenBurns = !!patch.kenBurns;
    if ('blur' in patch) g.blur = !!patch.blur;
    return g;
  }

  moveGroup(groupId, toIndex) {
    const from = this.groups.findIndex((g) => g.id === groupId);
    if (from === -1) return;
    const [g] = this.groups.splice(from, 1);
    this.groups.splice(Math.max(0, Math.min(this.groups.length, toIndex)), 0, g);
  }

  /** Doda posnetke v skupino (na konec ali na index). Vrne nove vnose. */
  addMedia(groupId, mediaIds, index) {
    const g = this.group(groupId);
    if (!g) return [];
    const entries = mediaIds.map((mediaId) => normEntry({ id: newId(), mediaId }));
    const at = Number.isInteger(index) ? Math.max(0, Math.min(g.items.length, index)) : g.items.length;
    g.items.splice(at, 0, ...entries);
    return entries;
  }

  /** Doda akcijo kot vnos v skupino (na konec ali na index). */
  addAction(groupId, actionId, index) {
    const g = this.group(groupId);
    if (!g || typeof actionId !== 'string' || !actionId) return null;
    const e = normActionEntry({ id: newId(), actionId });
    const at = Number.isInteger(index) ? Math.max(0, Math.min(g.items.length, index)) : g.items.length;
    g.items.splice(at, 0, e);
    return e;
  }

  /** Nastavitve vnosa: end, seconds, inSec, outSec (null = privzeto). */
  setEntry(entryId, patch) {
    const f = this.findEntry(entryId);
    if (!f) return null;
    const e = f.entry;
    if (isAction(e)) {
      if (typeof patch.actionId === 'string' && patch.actionId) e.actionId = patch.actionId;
      if ('delay' in patch) e.delay = Math.max(0, Math.min(3600, optSeconds(patch.delay) || 0));
      return e;
    }
    if ('end' in patch) e.end = ENTRY_ENDS.includes(patch.end) ? patch.end : null;
    if ('seconds' in patch) e.seconds = optSeconds(patch.seconds, 1);
    if ('inSec' in patch) e.inSec = optSeconds(patch.inSec);
    if ('outSec' in patch) e.outSec = optSeconds(patch.outSec);
    if ('startAction' in patch) e.startAction = typeof patch.startAction === 'string' && patch.startAction ? patch.startAction : null;
    if ('endAction' in patch) e.endAction = typeof patch.endAction === 'string' && patch.endAction ? patch.endAction : null;
    if ('fadeIn' in patch) e.fadeIn = optFade(patch.fadeIn);
    if ('fadeOut' in patch) e.fadeOut = optFade(patch.fadeOut);
    if ('endLead' in patch) e.endLead = Math.max(0, Math.min(30, optSeconds(patch.endLead) || 0));
    if ('titleId' in patch) e.titleId = typeof patch.titleId === 'string' && patch.titleId ? patch.titleId : null;
    if ('titleIn' in patch) e.titleIn = Math.max(0, Math.min(3600, optSeconds(patch.titleIn) || 0));
    if ('titleOut' in patch) e.titleOut = Math.max(0, Math.min(3600, optSeconds(patch.titleOut) || 0));
    if (patch.reset) Object.assign(patch, { fit: null, zoom: 1, posX: 0, posY: 0 });
    if (patch.resetColor) Object.assign(patch, { opacity: 1, brightness: 1, contrast: 1, saturation: 1 });
    for (const k of ['volumeDb', 'muted', 'fit', 'zoom', 'posX', 'posY', ...COLOR_KEYS]) {
      if (k in patch) e[k] = normLook({ ...e, [k]: k === 'volumeDb' ? Math.round(Number(patch[k]) * 2) / 2 : patch[k] })[k];
    }
    if (e.inSec !== null && e.outSec !== null && e.outSec <= e.inSec) e.outSec = null;
    return e;
  }

  // ---------- plasti vnosa ----------

  addLayer(entryId, mediaId) {
    const f = this.findEntry(entryId);
    if (!f) return null;
    if (f.entry.layers.length >= MAX_LAYERS) throw new Error(`Največ ${MAX_LAYERS} plasti na vnos`);
    const l = normLayer({ mediaId });
    f.entry.layers.push(l);
    return l;
  }

  _layer(entryId, layerId) {
    const f = this.findEntry(entryId);
    const l = f && f.entry.layers.find((x) => x.id === layerId);
    return l ? { entry: f.entry, layer: l } : null;
  }

  setLayer(entryId, layerId, patch) {
    const hit = this._layer(entryId, layerId);
    if (!hit) return null;
    const p = { ...patch };
    if (p.reset) Object.assign(p, { posX: 0, posY: 0, scale: 1 });
    if (p.resetColor) Object.assign(p, { opacity: 1, brightness: 1, contrast: 1, saturation: 1, blend: 'normal' });
    for (const k of LAYER_KEYS) {
      if (!(k in p)) continue;
      if (k === 'name') continue;
      const v = k === 'volumeDb' ? Math.round(Number(p[k]) * 2) / 2 : p[k];
      hit.layer[k] = normLayer({ ...hit.layer, [k]: v })[k];
    }
    return hit.layer;
  }

  removeLayer(entryId, layerId) {
    const hit = this._layer(entryId, layerId);
    if (hit) hit.entry.layers = hit.entry.layers.filter((x) => x.id !== layerId);
    return !!hit;
  }

  /** dir: +1 = višje (bolj spredaj), -1 = nižje. */
  moveLayer(entryId, layerId, dir) {
    const hit = this._layer(entryId, layerId);
    if (!hit) return;
    const a = hit.entry.layers;
    const i = a.indexOf(hit.layer);
    const j = Math.max(0, Math.min(a.length - 1, i + (dir > 0 ? 1 : -1)));
    a.splice(i, 1);
    a.splice(j, 0, hit.layer);
  }

  removeEntry(entryId) {
    const f = this.findEntry(entryId);
    if (f) f.group.items.splice(f.index, 1);
  }

  /** Premakne vnos (tudi v drugo skupino). */
  moveEntry(entryId, toGroupId, toIndex) {
    const f = this.findEntry(entryId);
    const target = this.group(toGroupId || (f && f.group.id));
    if (!f || !target) return;
    f.group.items.splice(f.index, 1);
    const at = Number.isInteger(toIndex) ? Math.max(0, Math.min(target.items.length, toIndex)) : target.items.length;
    target.items.splice(at, 0, f.entry);
  }

  /** Ko je posnetek odstranjen iz knjižnice, ga odstranimo tudi iz playliste. */
  removeMedia(mediaId) {
    this.overlays = this.overlays.filter((o) => o.mediaId !== mediaId);
    for (const g of this.groups) {
      g.items = g.items.filter((e) => isAction(e) || e.mediaId !== mediaId);
      for (const e of g.items) e.layers = e.layers.filter((l) => l.mediaId !== mediaId);
    }
  }

  /**
   * Naslednji posnetek po danem vnosu (akcije preskoči): naslednji v skupini; na koncu skupine prvi
   * (če se skupina ponavlja) ali prvi posnetek naslednje skupine. Vrne { group, entry } ali null.
   */
  nextAfter(entryId) {
    const f = this.findEntry(entryId);
    if (!f) return null;
    const { group, index } = f;
    const media = (g, from) => g.items.slice(from).find((e) => !isAction(e));
    const inGroup = media(group, index + 1);
    if (inGroup) return { group, entry: inGroup };
    if (group.loop) {
      const first = media(group, 0);
      return first ? { group, entry: first } : null;
    }
    const gi = this.groups.indexOf(group);
    for (let i = gi + 1; i < this.groups.length; i++) {
      const e = media(this.groups[i], 0);
      if (e) return { group: this.groups[i], entry: e };
    }
    return null;
  }

  /** Prvi posnetek skupine (brez akcij). */
  firstMedia(groupId) {
    const g = this.group(groupId);
    return g ? g.items.find((e) => !isAction(e)) || null : null;
  }

  /**
   * Akcije tik pred in tik za vnosom (zaporedne, preko meja skupin, do prvega posnetka).
   * Na koncu skupine, ki se ponavlja, se za vnosom nadaljuje na začetku iste skupine.
   */
  actionsAround(entryId) {
    const f = this.findEntry(entryId);
    if (!f) return { before: [], after: [] };
    const flat = this.flat();
    const at = flat.findIndex((x) => x.entry.id === entryId);
    const before = [];
    for (let i = at - 1; i >= 0 && isAction(flat[i].entry) && (!f.group.loop || flat[i].group === f.group); i--) before.unshift(flat[i].entry);
    const after = [];
    if (f.group.loop) {
      const items = f.group.items;
      for (let k = 1; k < items.length && isAction(items[(f.index + k) % items.length]); k++) after.push(items[(f.index + k) % items.length]);
    } else {
      for (let i = at + 1; i < flat.length && isAction(flat[i].entry); i++) after.push(flat[i].entry);
    }
    return { before, after };
  }

  /** Vsi vnosi po vrsti (tudi akcije). */
  flat() {
    const out = [];
    for (const group of this.groups) for (const entry of group.items) out.push({ group, entry });
    return out;
  }

  /** Samo posnetki po vrsti (za puščici gor/dol). */
  flatMedia() {
    return this.flat().filter((x) => !isAction(x.entry));
  }
}

module.exports = { Playlist, isAction, DEFAULT_IMAGE_SECONDS, GROUP_ENDS, ENTRY_ENDS, optSeconds, BLENDS, COLOR_KEYS, MAX_LAYERS };
