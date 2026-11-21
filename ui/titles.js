'use strict';
// Napisi: seznam napisov projekta, vklop na program, preview, urejanje in celostna podoba.
/* global state, run, el, $, showError, previewMode, lsGet, lsSet */

let selTitleId = null;
let titleEditKey = '';
let leftTab = lsGet('leftTab', 'media');

const ALIGN_LABEL = { left: 'levo', center: 'sredina', right: 'desno', tl: 'levo zgoraj', tr: 'desno zgoraj', bl: 'levo spodaj', br: 'desno spodaj' };

function titlesSt() {
  return (state && state.titles) || { templates: [], items: [], onAir: [], brand: {}, fonts: [] };
}

function tplOf(id) {
  const T = titlesSt().templates;
  return T.find((t) => t.id === id) || T[0];
}

function imageOptions() {
  return state.library.filter((it) => it.type === 'image').sort((a, b) => (a.rel || a.name).localeCompare(b.rel || b.name, 'sl'));
}

// ---------- zavihka Mediji / Napisi ----------

function setLeftTab(t) {
  leftTab = ['titles', 'atem', 'ptz'].includes(t) ? t : 'media';
  lsSet('leftTab', leftTab);
  for (const b of document.querySelectorAll('#left-tabs button')) b.classList.toggle('on', b.dataset.t === leftTab);
  $('#tab-media').classList.toggle('hidden', leftTab !== 'media');
  $('#tab-titles').classList.toggle('hidden', leftTab !== 'titles');
  $('#tab-atem').classList.toggle('hidden', leftTab !== 'atem');
  $('#tab-ptz').classList.toggle('hidden', leftTab !== 'ptz');
  $('#btn-add').classList.toggle('hidden', leftTab !== 'media');
  $('#lib-hint').classList.toggle('hidden', leftTab !== 'media');
  $('#btn-brand').classList.toggle('hidden', leftTab !== 'titles');
}
for (const b of document.querySelectorAll('#left-tabs button')) b.onclick = () => setLeftTab(b.dataset.t);
setLeftTab(leftTab);

// ---------- seznam ----------

function renderTitles() {
  if (!state || !state.titles) return;
  const T = titlesSt();
  const onAir = new Set(T.onAir);
  const cnt = $('#titles-onair-count');
  cnt.classList.toggle('hidden', !onAir.size);
  cnt.textContent = onAir.size ? `${onAir.size} na zaslonu` : '';

  const sel = $('#title-new-tpl');
  if (sel.options.length !== T.templates.length) {
    sel.innerHTML = '';
    for (const t of T.templates) sel.add(new Option(t.name, t.id));
    sel.value = lsGet('newTitleTpl', T.templates[0] && T.templates[0].id);
  }
  $('#btn-titles-off').disabled = !onAir.size;

  const ul = $('#titles');
  ul.innerHTML = '';
  if (!T.items.length) {
    ul.append(el('li', 'empty', 'Ni napisov. Izberi predlogo zgoraj in klikni "+ Nov napis".'));
  }
  if (selTitleId && !T.items.some((t) => t.id === selTitleId)) selTitleId = null;
  for (const t of T.items) ul.append(titleRow(t, onAir.has(t.id)));
  renderTitleEditor();
}

function titleRow(t, on) {
  const li = el('li', 'title-row');
  li.dataset.id = t.id;
  if (t.id === selTitleId) li.classList.add('selected');
  if (on) li.classList.add('onair');
  if (T_pvw() === t.id) li.classList.add('inpvw');

  const go = el('button', `title-go${on ? ' on' : ''}`, on ? 'NA ZASLONU' : 'VKLOPI');
  go.title = on ? 'Klikni za umik napisa z zaslona' : 'Napis na program (nad tem, kar se predvaja)';
  go.onclick = (ev) => {
    ev.stopPropagation();
    run('titles.toggle', { id: t.id });
  };
  li.append(go);

  const txt = el('div', 'title-txt');
  const tpl = tplOf(t.template);
  txt.append(el('span', 'name', tpl && tpl.clock ? t.label : t.f0 || (tpl && tpl.name) || 'Napis'));
  const sub = [t.f1, tpl && tpl.name].filter(Boolean).join(' · ');
  txt.append(el('span', 'sub', sub + (t.duration ? ` · ${t.duration} s` : '')));
  li.append(txt);

  const pv = el('button', `item-btn${T_pvw() === t.id ? ' on' : ''}`, '👁');
  pv.title = T_pvw() === t.id ? 'Umakni iz preview' : 'Pokaži v preview';
  pv.onclick = (ev) => {
    ev.stopPropagation();
    run('titles.preview', { id: T_pvw() === t.id ? null : t.id });
  };
  const dup = el('button', 'item-btn', '⧉');
  dup.title = 'Podvoji napis';
  dup.onclick = async (ev) => {
    ev.stopPropagation();
    const { id, label, ...rest } = t;
    const nid = await run('titles.add', { patch: rest, after: t.id });
    if (nid) selectTitle(nid);
  };
  const del = el('button', 'item-btn', '✕');
  del.title = 'Izbriši napis';
  del.onclick = (ev) => {
    ev.stopPropagation();
    if (confirm(`Izbrišem napis "${t.label}"?`)) run('titles.remove', { id: t.id });
  };
  li.append(pv, dup, del);

  li.onclick = () => selectTitle(t.id);
  li.draggable = true;
  li.ondragstart = (ev) => {
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', t.label);
    li.classList.add('dragging');
    window.__titleDrag = t.id;
  };
  li.ondragend = () => { window.__titleDrag = null; li.classList.remove('dragging'); };
  li.ondragover = (ev) => {
    if (!window.__titleDrag) return;
    ev.preventDefault();
    li.classList.add('drop-before');
  };
  li.ondragleave = () => li.classList.remove('drop-before');
  li.ondrop = (ev) => {
    li.classList.remove('drop-before');
    const id = window.__titleDrag;
    if (!id || id === t.id) return;
    ev.preventDefault();
    ev.stopPropagation();
    const items = titlesSt().items;
    let to = items.findIndex((x) => x.id === t.id);
    if (items.findIndex((x) => x.id === id) < to) to -= 1;
    run('titles.move', { id, index: to });
  };
  return li;
}

function T_pvw() {
  return titlesSt().pvw;
}

function selectTitle(id) {
  selTitleId = id;
  titleEditKey = '';
  renderTitles();
  if (previewMode() && id && T_pvw() !== id) run('titles.preview', { id });
}

$('#btn-title-add').onclick = async () => {
  const tpl = $('#title-new-tpl').value;
  lsSet('newTitleTpl', tpl);
  const t = tplOf(tpl);
  const patch = { template: tpl };
  if (t && t.fields.length && !t.clock) patch.f0 = t.id === 'pas' ? 'Naslov' : 'Ime Priimek';
  if (t && t.fields.length > 1) patch.f1 = t.id === 'pas' ? '' : 'funkcija';
  const id = await run('titles.add', { patch, after: selTitleId });
  if (id) selectTitle(id);
};
$('#btn-titles-off').onclick = () => run('titles.allOff');

// ---------- urejanje izbranega napisa ----------

function renderTitleEditor() {
  const box = $('#title-edit');
  const t = titlesSt().items.find((x) => x.id === selTitleId);
  if (!t) {
    box.classList.add('hidden');
    box.innerHTML = '';
    titleEditKey = '';
    return;
  }
  box.classList.remove('hidden');
  const on = titlesSt().onAir.includes(t.id);
  const key = `${t.id}|${t.template}|${on}|${imageOptions().length}|${t.mode}`;
  if (key !== titleEditKey) {
    titleEditKey = key;
    buildTitleEditor(box, t, on);
  }
  syncTitleEditor(box, t);
}

function titlePatch(id, patch) {
  return run('titles.set', { id, patch });
}

function buildTitleEditor(box, t, on) {
  box.innerHTML = '';
  const tpl = tplOf(t.template);
  const T = titlesSt();

  const head = el('div', 'te-head');
  head.append(el('b', '', 'Urejanje napisa'));
  if (on) head.append(el('span', 'te-onair', 'NA ZASLONU – besedilo se spremeni, ko pritisneš Enter'));
  box.append(head);

  const grid = el('div', 'te-grid');
  const row = (label, input) => {
    const l = el('label', 'te-row');
    l.append(el('span', '', label), input);
    grid.append(l);
    return input;
  };

  const tsel = document.createElement('select');
  for (const x of T.templates) tsel.add(new Option(x.name, x.id));
  tsel.value = t.template;
  tsel.onchange = () => titlePatch(t.id, { template: tsel.value });
  row('Predloga', tsel);

  for (const f of tpl.fields) {
    const inp = document.createElement('input');
    inp.className = 'text-input';
    inp.dataset.key = f.key;
    inp.maxLength = f.key === 'f2' ? 60 : 200;
    let timer = null;
    const send = () => titlePatch(t.id, { [f.key]: inp.value });
    if (on) {
      inp.onchange = send;
    } else {
      inp.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(send, 300);
      };
    }
    inp.onkeydown = (ev) => {
      if (ev.key === 'Enter') inp.blur();
    };
    row(f.label, inp);
  }

  if (tpl.clock) {
    const m = document.createElement('select');
    m.dataset.key = 'mode';
    for (const [v, l] of [['clock', 'Trenutna ura'], ['until', 'Odštevanje do ure'], ['timer', 'Odštevanje (trajanje)'], ['stopwatch', 'Štoparica']]) m.add(new Option(l, v));
    m.onchange = () => titlePatch(t.id, { mode: m.value });
    row('Način', m);
    if (t.mode === 'until') {
      const tg = document.createElement('input');
      tg.type = 'time';
      tg.step = 1;
      tg.className = 'text-input';
      tg.dataset.key = 'target';
      tg.onchange = () => titlePatch(t.id, { target: tg.value });
      row('Do ure', tg);
    }
    if (t.mode === 'timer') {
      const sec = document.createElement('input');
      sec.className = 'text-input small-num';
      sec.dataset.key = 'secondsTxt';
      sec.placeholder = 'mm:ss';
      sec.title = 'Npr. 5:00 ali 90 (sekunde). Odštevanje začne, ko napis vklopiš.';
      sec.onchange = () => {
        const p = sec.value.trim().split(':').map(Number);
        const v = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
        if (Number.isFinite(v) && v > 0) titlePatch(t.id, { seconds: v });
      };
      row('Trajanje (mm:ss)', sec);
    }
  }

  if (tpl.aligns.length) {
    const a = document.createElement('select');
    a.dataset.key = 'align';
    for (const x of tpl.aligns) a.add(new Option(ALIGN_LABEL[x] || x, x));
    a.onchange = () => titlePatch(t.id, { align: a.value });
    row('Položaj', a);
  }

  const dur = document.createElement('input');
  dur.type = 'number';
  dur.min = 0;
  dur.max = 3600;
  dur.className = 'text-input small-num';
  dur.dataset.key = 'duration';
  dur.title = '0 = ostane na zaslonu, dokler ga ne umakneš';
  dur.onchange = () => titlePatch(t.id, { duration: Number(dur.value) || 0 });
  row('Samodejno umakni po (s)', dur);

  const size = document.createElement('select');
  size.dataset.key = 'size';
  for (const [v, l] of [[0.6, 'zelo majhen (60 %)'], [0.75, 'manjši (75 %)'], [0.9, 'malo manjši (90 %)'], [1, 'običajen'], [1.15, 'malo večji (115 %)'], [1.3, 'večji (130 %)'], [1.5, 'velik (150 %)']]) size.add(new Option(l, String(v)));
  size.onchange = () => titlePatch(t.id, { size: Number(size.value) });
  row('Velikost', size);

  // Logotip
  const lg = document.createElement('select');
  lg.dataset.key = 'logo';
  lg.add(new Option('Logotip projekta', '__brand'));
  lg.add(new Option('Brez logotipa', ''));
  for (const it of imageOptions()) lg.add(new Option(it.rel || it.name, it.id));
  lg.onchange = () => titlePatch(t.id, { logo: lg.value === '__brand' ? null : lg.value });
  if (!tpl.clock) row('Logotip', lg);

  // Barve
  const colors = el('div', 'te-colors');
  const own = document.createElement('input');
  own.type = 'checkbox';
  own.dataset.key = 'own';
  const ownL = el('label', 'te-own');
  ownL.append(own, document.createTextNode(' svoje barve'));
  own.onchange = () => {
    const b = titlesSt().brand;
    if (own.checked) titlePatch(t.id, { bg: b.bg, accent: b.accent, text: b.text });
    else titlePatch(t.id, { bg: null, accent: null, text: null });
  };
  colors.append(ownL);
  for (const [k, label] of [['bg', 'ozadje'], ['accent', 'poudarek'], ['text', 'besedilo']]) {
    const c = document.createElement('input');
    c.type = 'color';
    c.dataset.key = k;
    c.title = label;
    let timer = null;
    c.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => titlePatch(t.id, { [k]: c.value }), 150);
    };
    const l = el('label', 'te-color');
    l.append(c, document.createTextNode(` ${label}`));
    colors.append(l);
  }
  row('Barve', colors);
  box.append(grid);

  const btns = el('div', 'te-btns');
  const go = el('button', `btn ${on ? 'danger' : 'go'}`, on ? 'Umakni z zaslona' : 'Vklopi na zaslon');
  go.onclick = () => run('titles.toggle', { id: t.id });
  const hk = el('small', 'muted', `Bližnjico za ta napis nastaviš v Nastavitvah. Companion: /api/title/${encodeURIComponent(t.f0 || t.id)}`);
  btns.append(go, hk);
  box.append(btns);
}

function syncTitleEditor(box, t) {
  const b = titlesSt().brand;
  const active = document.activeElement;
  for (const inp of box.querySelectorAll('[data-key]')) {
    if (inp === active) continue;
    const k = inp.dataset.key;
    if (k === 'own') inp.checked = !!(t.bg || t.accent || t.text);
    else if (k === 'logo') inp.value = t.logo === null ? '__brand' : t.logo;
    else if (k === 'bg' || k === 'accent' || k === 'text') {
      inp.value = t[k] || b[k];
      inp.disabled = !(t.bg || t.accent || t.text);
    } else if (k === 'duration') inp.value = t.duration || 0;
    else if (k === 'size') {
      const v = String(t.size || 1);
      if (![...inp.options].some((o) => o.value === v)) inp.add(new Option(`${Math.round(Number(v) * 100)} %`, v), 0);
      inp.value = v;
    }
    else if (k === 'secondsTxt') inp.value = `${Math.floor(t.seconds / 60)}:${String(t.seconds % 60).padStart(2, '0')}`;
    else inp.value = t[k] == null ? '' : t[k];
  }
}

// ---------- celostna podoba ----------

function fillBrandDialog() {
  const T = titlesSt();
  const b = T.brand;
  const lg = $('#brand-logo');
  lg.innerHTML = '';
  lg.add(new Option('Brez logotipa', ''));
  for (const it of imageOptions()) lg.add(new Option(it.rel || it.name, it.id));
  lg.value = b.logo || '';
  $('#brand-bg').value = b.bg;
  $('#brand-accent').value = b.accent;
  $('#brand-text').value = b.text;
  $('#brand-font').value = b.font;
  const dl = $('#brand-fonts');
  dl.innerHTML = '';
  for (const f of T.fonts) dl.append(new Option(f, f));
}

$('#btn-brand').onclick = () => {
  if (!imageOptions().length) showError('Med Mediji ni slik. Dodaj logotip (PNG) v Medije, da ga lahko izbereš.');
  fillBrandDialog();
  $('#dlg-brand').showModal();
};
$('#brand-logo').onchange = () => run('brand.set', { patch: { logo: $('#brand-logo').value || null } });
for (const k of ['bg', 'accent', 'text']) {
  let timer = null;
  $(`#brand-${k}`).oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => run('brand.set', { patch: { [k]: $(`#brand-${k}`).value } }), 150);
  };
}
$('#brand-font').onchange = () => run('brand.set', { patch: { font: $('#brand-font').value } });
$('#brand-font').addEventListener('keydown', (ev) => ev.stopPropagation());
