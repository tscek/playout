'use strict';
// Seznam "Čez program": napisi in grafike čez program s svojim NEXT in GO (ne zamenjajo programa).
/* global state, run, el, $, drag:writable */

let ovlOpenId = null; // vnos z odprtimi podrobnostmi
let ovlDrag = null; // id vnosa, ki ga vlečemo

const OVL_TYPE = { title: 'NAPIS', video: 'GRAFIKA', image: 'SLIKA', audio: 'ZVOK' };
const OVL_END = { clear: 'na koncu izgine', hold: 'ostane zadnja sličica', loop: 'ponavlja' };

function ovlSt() {
  return (state && state.overlays) || { items: [], next: null };
}

function ovlFill() {
  const tSel = $('#ovl-add-title');
  const mSel = $('#ovl-add-media');
  if (document.activeElement === tSel || document.activeElement === mSel) return;
  tSel.innerHTML = '';
  tSel.add(new Option('+ napis', ''));
  for (const t of (state.titles && state.titles.items) || []) tSel.add(new Option(t.label, t.id));
  mSel.innerHTML = '';
  mSel.add(new Option('+ grafika', ''));
  const media = state.library.filter((it) => it.type === 'video' || it.type === 'image')
    .sort((a, b) => (a.rel || a.name).localeCompare(b.rel || b.name, 'sl'));
  for (const it of media) mSel.add(new Option(it.rel || it.name, it.id));
}

function ovlNum(value, min, max, step, onSet, title) {
  const n = el('input');
  n.type = 'number';
  n.min = min;
  n.max = max;
  n.step = step;
  n.value = value;
  if (title) n.title = title;
  n.onclick = (ev) => ev.stopPropagation();
  n.onchange = () => onSet(Number(n.value) || 0);
  n.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === 'Escape') n.blur(); };
  n.onblur = () => setTimeout(renderOverlays, 0);
  return n;
}

function ovlDetails(o) {
  const set = (patch) => run('ovl.set', { id: o.id, patch });
  const box = el('div', 'ovl-detail');
  box.onclick = (ev) => ev.stopPropagation();
  const lab = (text, input, title) => {
    const l = el('label', 'group-opt');
    if (title) l.title = title;
    l.append(document.createTextNode(text), input);
    return l;
  };
  box.append(lab('dol po', ovlNum(o.seconds || '', 0, 3600, 1, (v) => set({ seconds: v }), '0 ali prazno = ostane, dokler ne pritisneš GO za naslednjega ali ■'), 'Samodejno dol po toliko sekundah'),
    el('span', 'hint-inline', 's'));
  const keep = el('input');
  keep.type = 'checkbox';
  keep.checked = !!o.keep;
  keep.onchange = () => set({ keep: keep.checked });
  box.append(lab('ostane ob naslednjem', keep, 'Ko greš na naslednjega, ta ostane (npr. logo, ura). Sicer ga naslednji zamenja.'));
  if (o.kind === 'media') {
    if (o.type === 'video') {
      const end = el('select', 'mini-select');
      for (const [k, v] of Object.entries(OVL_END)) end.add(new Option(v, k));
      end.value = o.end;
      end.onchange = () => set({ end: end.value });
      box.append(lab('konec', end));
    }
    box.append(lab('prikaz/umik', ovlNum(o.fade, 0, 5, 0.1, (v) => set({ fade: v })), 'Sekunde za mehak prikaz in umik'), el('span', 'hint-inline', 's'));
    const slider = (text, key, min, max, step, title) => {
      const r = el('input');
      r.type = 'range';
      r.min = min;
      r.max = max;
      r.step = step;
      r.value = o[key];
      let t = null;
      r.oninput = () => {
        clearTimeout(t);
        t = setTimeout(() => set({ [key]: Number(r.value) }), 40);
      };
      return lab(text, r, title);
    };
    box.append(
      slider('velikost', 'scale', 0.05, 1.5, 0.01, '1 = čez cel zaslon'),
      slider('X', 'posX', -60, 60, 0.5, 'Vodoravni položaj'),
      slider('Y', 'posY', -60, 60, 0.5, 'Navpični položaj'),
      slider('prosojnost', 'opacity', 0, 1, 0.01),
    );
    const mute = el('input');
    mute.type = 'checkbox';
    mute.checked = !!o.muted;
    mute.onchange = () => set({ muted: mute.checked });
    if (o.type === 'video') box.append(lab('brez zvoka', mute));
    const reset = el('button', 'item-btn', 'Ponastavi položaj');
    reset.onclick = () => set({ reset: true });
    box.append(reset);
  }
  return box;
}

function renderOverlays() {
  if (!state || !$('#ovl-list')) return;
  const list = $('#ovl-list');
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('#ovl-list');
  if (focused && ['number', 'range'].includes(document.activeElement.type)) return;
  ovlFill();
  const S = ovlSt();
  const nOn = S.items.filter((o) => o.onAir).length;
  $('#ovl-off').disabled = !nOn;
  $('#ovl-go').disabled = !S.next;
  const nx = S.items.find((o) => o.id === S.next);
  $('#ovl-go').title = nx ? `Naslednji čez program: ${nx.name}` : 'Ni naslednjega (klikni vnos, da ga izbereš)';
  list.innerHTML = '';
  if (!S.items.length) {
    list.append(el('div', 'group-empty', 'Prazno. Dodaj napis ali grafiko (+ zgoraj) ali povleci medij oz. napis sem.'));
    return;
  }
  S.items.forEach((o, i) => {
    const li = el('li');
    if (o.onAir) li.classList.add('onair');
    if (o.id === S.next) li.classList.add('next');
    if (o.missing) li.classList.add('missing');
    li.draggable = true;
    li.ondragstart = (ev) => {
      ovlDrag = o.id;
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', o.name);
    };
    li.ondragend = () => { ovlDrag = null; };
    li.ondragover = (ev) => {
      if (!ovlDrag && !drag && !window.__titleDrag) return;
      ev.preventDefault();
      ev.stopPropagation();
      li.classList.add('drop-before');
    };
    li.ondragleave = () => li.classList.remove('drop-before');
    li.ondrop = (ev) => ovlDrop(ev, i);
    const row = el('div', 'ovl-row');
    row.append(el('span', 'num', String(i + 1)), el('span', `type ${o.kind === 'title' ? 'title' : o.type}`, OVL_TYPE[o.kind === 'title' ? 'title' : o.type] || ''),
      el('span', 'name', o.name));
    if (o.id === S.next) row.append(el('span', 'badge next', 'NEXT'));
    if (o.onAir) row.append(el('span', 'badge pgm', 'ČEZ PGM'));
    if (o.seconds) row.append(el('span', 'badge info', `${o.seconds} s`));
    if (o.keep) row.append(el('span', 'badge info', 'ostane'));
    if (o.kind === 'media' && o.type === 'video' && o.end !== 'clear') row.append(el('span', 'badge info', o.end === 'loop' ? '⟲' : '⏸'));
    const btn = (txt, title, fn, cls = 'item-btn') => {
      const b = el('button', cls, txt);
      b.title = title;
      b.onclick = (ev) => { ev.stopPropagation(); fn(); };
      return b;
    };
    row.append(
      btn('▶', 'Takoj čez program', () => run('ovl.go', { id: o.id })),
      o.onAir ? btn('■', 'Dol s programa', () => run('ovl.off', { id: o.id })) : el('span', 'item-btn-gap'),
      btn('⚙', 'Nastavitve: trajanje, ostane, položaj, velikost', () => { ovlOpenId = ovlOpenId === o.id ? null : o.id; renderOverlays(); },
        'item-btn' + (ovlOpenId === o.id ? ' active' : '')),
      btn('▲', 'Gor', () => run('ovl.move', { id: o.id, index: i - 1 })),
      btn('▼', 'Dol', () => run('ovl.move', { id: o.id, index: i + 1 })),
      btn('✕', 'Odstrani iz seznama', () => run('ovl.remove', { id: o.id })),
    );
    li.append(row);
    if (ovlOpenId === o.id) li.append(ovlDetails(o));
    li.onclick = () => run('ovl.next', { id: o.id });
    li.ondblclick = () => run('ovl.go', { id: o.id });
    list.append(li);
  });
}

function ovlDrop(ev, index) {
  ev.preventDefault();
  ev.stopPropagation();
  document.querySelectorAll('#ovl-list .drop-before, #ovl-panel.dragover').forEach((x) => x.classList.remove('drop-before', 'dragover'));
  if (ovlDrag) {
    const from = ovlSt().items.findIndex((o) => o.id === ovlDrag);
    const to = index === undefined ? ovlSt().items.length - 1 : from !== -1 && index > from ? index - 1 : index;
    run('ovl.move', { id: ovlDrag, index: to });
  } else if (window.__titleDrag) {
    run('ovl.add', { spec: { kind: 'title', titleId: window.__titleDrag }, index });
  } else if (drag && drag.kind === 'media') {
    run('ovl.add', { spec: { kind: 'media', mediaId: drag.id }, index });
    drag = null;
  }
  ovlDrag = null;
  window.__titleDrag = null;
}

(function initOverlays() {
  const panel = $('#ovl-panel');
  if (!panel) return;
  panel.ondragover = (ev) => {
    if (!ovlDrag && !drag && !window.__titleDrag) return;
    ev.preventDefault();
    panel.classList.add('dragover');
  };
  panel.ondragleave = (ev) => { if (!panel.contains(ev.relatedTarget)) panel.classList.remove('dragover'); };
  panel.ondrop = (ev) => ovlDrop(ev, undefined);
  $('#ovl-add-title').onchange = (ev) => {
    if (ev.target.value) run('ovl.add', { spec: { kind: 'title', titleId: ev.target.value } });
    ev.target.blur();
  };
  $('#ovl-add-media').onchange = (ev) => {
    if (ev.target.value) run('ovl.add', { spec: { kind: 'media', mediaId: ev.target.value } });
    ev.target.blur();
  };
  $('#ovl-go').onclick = () => run('ovl.go');
  $('#ovl-off').onclick = () => run('ovl.off');
  const fold = $('#ovl-fold');
  const apply = () => {
    const c = panel.classList.contains('collapsed');
    fold.textContent = c ? '▸' : '▾';
    try { localStorage.setItem('playout.ovlCollapsed', c ? '1' : ''); } catch { /* ni pomembno */ }
  };
  try { if (localStorage.getItem('playout.ovlCollapsed')) panel.classList.add('collapsed'); } catch { /* ni pomembno */ }
  fold.onclick = () => { panel.classList.toggle('collapsed'); apply(); };
  apply();
})();
