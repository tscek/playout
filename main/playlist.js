'use strict';
// Playlist: skupine posnetkov v vrstnem redu. Vsak vnos kaže na posnetek v knjižnici
// (isti posnetek je lahko v več skupinah ali večkrat v isti skupini).

const { newId } = require('./media');

const DEFAULT_IMAGE_SECONDS = 5;

// Kaj se zgodi na koncu posnetka: ustavi, naprej s CUT, naprej s prehodom, (samo vnos) ponavljaj posnetek.
const GROUP_ENDS = ['stop', 'cut', 'mix'];
const ENTRY_ENDS = ['stop', 'cut', 'mix', 'loop'];

function makeGroup(name) {
  return { id: newId(), name: name || 'Skupina', end: 'stop', loop: false, imageSeconds: DEFAULT_IMAGE_SECONDS, collapsed: false, items: [] };
}

function optSeconds(v, min = 0) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) return null;
  return Math.round(n * 1000) / 1000;
}

function normEntry(e) {
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
      collapsed: !!g.collapsed,
      items: (Array.isArray(g.items) ? g.items : []).filter((e) => e && e.id && e.mediaId).map(normEntry),
    }));
  if (!out.length) out.push({ ...makeGroup('Playlist') });
  return { groups: out };
}

function clampSeconds(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IMAGE_SECONDS;
  return Math.max(1, Math.min(3600, Math.round(n)));
}

class Playlist {
  constructor(data) {
    this.groups = normalize(data).groups;
  }

  toJSON() {
    return { groups: this.groups };
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

  /** Nastavitve vnosa: end, seconds, inSec, outSec (null = privzeto). */
  setEntry(entryId, patch) {
    const f = this.findEntry(entryId);
    if (!f) return null;
    const e = f.entry;
    if ('end' in patch) e.end = ENTRY_ENDS.includes(patch.end) ? patch.end : null;
    if ('seconds' in patch) e.seconds = optSeconds(patch.seconds, 1);
    if ('inSec' in patch) e.inSec = optSeconds(patch.inSec);
    if ('outSec' in patch) e.outSec = optSeconds(patch.outSec);
    if ('startAction' in patch) e.startAction = typeof patch.startAction === 'string' && patch.startAction ? patch.startAction : null;
    if ('endAction' in patch) e.endAction = typeof patch.endAction === 'string' && patch.endAction ? patch.endAction : null;
    if ('endLead' in patch) e.endLead = Math.max(0, Math.min(30, optSeconds(patch.endLead) || 0));
    if (e.inSec !== null && e.outSec !== null && e.outSec <= e.inSec) e.outSec = null;
    return e;
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
    for (const g of this.groups) g.items = g.items.filter((e) => e.mediaId !== mediaId);
  }

  /**
   * Naslednji vnos po danem: naslednji v skupini; na koncu skupine prvi (če se skupina ponavlja)
   * ali prvi vnos naslednje nepraznne skupine. Vrne { group, entry } ali null.
   */
  nextAfter(entryId) {
    const f = this.findEntry(entryId);
    if (!f) return null;
    const { group, index } = f;
    if (index + 1 < group.items.length) return { group, entry: group.items[index + 1] };
    if (group.loop) return { group, entry: group.items[0] };
    const gi = this.groups.indexOf(group);
    for (let i = gi + 1; i < this.groups.length; i++) {
      if (this.groups[i].items.length) return { group: this.groups[i], entry: this.groups[i].items[0] };
    }
    return null;
  }

  /** Vsi vnosi po vrsti (za puščici gor/dol). */
  flat() {
    const out = [];
    for (const group of this.groups) for (const entry of group.items) out.push({ group, entry });
    return out;
  }
}

module.exports = { Playlist, DEFAULT_IMAGE_SECONDS, GROUP_ENDS, ENTRY_ENDS, optSeconds };
