'use strict';
// Playlist: skupine posnetkov v vrstnem redu. Vsak vnos kaže na posnetek v knjižnici
// (isti posnetek je lahko v več skupinah ali večkrat v isti skupini).

const { newId } = require('./media');

const DEFAULT_IMAGE_SECONDS = 5;

function makeGroup(name) {
  return { id: newId(), name: name || 'Skupina', autoFollow: false, followCut: false, loop: false, imageSeconds: DEFAULT_IMAGE_SECONDS, items: [] };
}

function normalize(data) {
  const groups = Array.isArray(data && data.groups) ? data.groups : [];
  const out = groups
    .filter((g) => g && typeof g.id === 'string')
    .map((g) => ({
      id: g.id,
      name: typeof g.name === 'string' && g.name.trim() ? g.name : 'Skupina',
      autoFollow: !!g.autoFollow,
      followCut: !!g.followCut, // samodejno naprej s CUT namesto s prehodom
      loop: !!g.loop,
      imageSeconds: clampSeconds(g.imageSeconds),
      items: (Array.isArray(g.items) ? g.items : []).filter((e) => e && e.id && e.mediaId).map((e) => ({ id: e.id, mediaId: e.mediaId })),
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
    if ('autoFollow' in patch) g.autoFollow = !!patch.autoFollow;
    if ('loop' in patch) g.loop = !!patch.loop;
    if ('followCut' in patch) g.followCut = !!patch.followCut;
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
    const entries = mediaIds.map((mediaId) => ({ id: newId(), mediaId }));
    const at = Number.isInteger(index) ? Math.max(0, Math.min(g.items.length, index)) : g.items.length;
    g.items.splice(at, 0, ...entries);
    return entries;
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

module.exports = { Playlist, DEFAULT_IMAGE_SECONDS };
