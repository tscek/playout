'use strict';
// Osebe: tabele s podatki za napise (kot Excel), klic po številki, priprava napisa in GO.
/* global state, run, el, $, showError */

const KIND_LABEL = { text: 'besedilo', flag: 'država (zastava)', image: 'slika iz Medijev', action: 'kamera / akcija' };
let tbSel = { r0: 0, c0: 0, r1: 0, c1: 0 }; // izbor celic (c = -1 je stolpec #)
let tbEdit = null; // { r, c, input }
let tbSig = '';
let tbLastMap = 'f0';
let tbDrag = false;

function tablesSt() {
  return (state && state.tables) || { tables: [], active: null, cued: null };
}

function curTable() {
  const T = tablesSt();
  return T.tables.find((t) => t.id === T.active) || T.tables[0] || null;
}

/** Enako kot na strežniku: vzorec "{Ime}, {Funkcija}" z odstranjenimi ločili ob praznih stoplcih. */
function tbFill(pattern, t, row) {
  const byName = new Map(t.columns.map((c) => [c.name.toLowerCase(), c]));
  return String(pattern || '').replace(/\{([^{}]+)\}/g, (all, name) => {
    const k = name.trim().toLowerCase();
    if (k === '#' || k === 'št' || k === 'st') return String(row.n);
    const c = byName.get(k);
    return c ? row.cells[c.id] || '' : '';
  }).replace(/[ \t]+/g, ' ')
    .replace(/(\s*[,;|·–-]\s*)+(?=\s*[,;|·–-])/g, '')
    .replace(/^\s*[,;|·–-]\s*/, '')
    .replace(/\s*[,;|·–-]\s*$/, '')
    .replace(/\(\s*\)/g, '')
    .trim();
}

const rowEmpty = (r) => !Object.keys(r.cells).length;
const isLive = (t, r) => ((state.overlays && state.overlays.live) || []).some((x) => x.id === `row:${t.id}:${r.id}`);
const isCued = (t, r) => { const c = tablesSt().cued; return !!(c && c.tableId === t.id && c.rowId === r.id); };

function cue(t, r, go = false) {
  run('tables.cue', { tableId: t.id, rowId: r.id }).then(() => { if (go) run('ovl.go'); });
}

function cueNum(v) {
  const n = parseInt(String(v).trim(), 10);
  if (!(n > 0)) return;
  run('tables.cue', { num: n });
}

// ---------- zavihek Osebe (seznam za v živo) ----------

function renderPeople() {
  if (!state || !$('#tab-people')) return;
  const T = tablesSt();
  const sel = $('#pp-table');
  if (document.activeElement !== sel) {
    sel.innerHTML = '';
    if (!T.tables.length) sel.add(new Option('(ni tabel)', ''));
    for (const t of T.tables) sel.add(new Option(`${t.name} (${t.rows.filter((r) => !rowEmpty(r)).length})`, t.id));
    sel.value = T.active || '';
  }
  const t = curTable();
  $('#pp-edit').disabled = !t;
  const list = $('#pp-list');
  list.innerHTML = '';
  if (!t) {
    list.append(el('div', 'pz-empty', 'Ni tabel. Klikni + in vpiši ali prilepi osebe (ime, funkcija, država, slika, kamera). Vsaka vrstica dobi številko za klic.'));
    return;
  }
  const q = ($('#pp-search').value || '').trim().toLowerCase();
  const rows = t.rows.filter((r) => !rowEmpty(r)).filter((r) => !q || String(r.n) === q || Object.values(r.cells).some((v) => v.toLowerCase().includes(q)));
  if (!rows.length) list.append(el('div', 'pz-empty', q ? 'Ni zadetkov.' : 'Tabela je prazna. Klikni ✎ Uredi tabelo.'));
  for (const r of rows) {
    const li = el('div', 'pp-row');
    if (isCued(t, r)) li.classList.add('cued');
    if (isLive(t, r)) li.classList.add('live');
    li.append(el('span', 'pp-n', String(r.n)));
    if (r.flag) {
      const img = el('img', 'pp-flag');
      img.src = `/flags/${r.flag}.svg`;
      img.alt = '';
      li.append(img);
    }
    const tx = el('span', 'pp-tx');
    tx.append(el('b', '', tbFill(t.map.f0, t, r) || '(brez naslova)'));
    const sub = [tbFill(t.map.f1, t, r), tbFill(t.map.f2, t, r)].filter(Boolean).join(' · ');
    if (sub) tx.append(el('small', '', sub));
    li.append(tx);
    if (isCued(t, r)) li.append(el('span', 'badge next', 'NEXT'));
    if (isLive(t, r)) li.append(el('span', 'badge pgm', 'ČEZ PGM'));
    li.title = 'Klik: pripravi (NEXT, v preview). Dvoklik: takoj na program.';
    li.onclick = () => cue(t, r);
    li.ondblclick = () => cue(t, r, true);
    list.append(li);
  }
}

// ---------- urejanje tabele (kot Excel) ----------

function openTableEditor() {
  const t = curTable();
  if (!t) return;
  tbSig = '';
  tbSel = { r0: 0, c0: 0, r1: 0, c1: 0 };
  const d = $('#dlg-table');
  if (!d.open) d.showModal();
  renderTableEditor(true);
  $('#tb-grid').focus();
}

function selBox() {
  return {
    rA: Math.min(tbSel.r0, tbSel.r1), rB: Math.max(tbSel.r0, tbSel.r1),
    cA: Math.min(tbSel.c0, tbSel.c1), cB: Math.max(tbSel.c0, tbSel.c1),
  };
}

function cellValue(t, r, c) {
  const row = t.rows[r];
  if (!row) return '';
  if (c === -1) return row.num ? String(row.num) : '';
  const col = t.columns[c];
  return col ? row.cells[col.id] || '' : '';
}

function fillDatalists() {
  const media = $('#tb-dl-media');
  media.innerHTML = '';
  for (const it of state.library.filter((x) => x.type === 'image' || x.type === 'video')) media.append(new Option(it.rel || it.name));
  const act = $('#tb-dl-action');
  act.innerHTML = '';
  for (const a of (state.actions && state.actions.actions) || []) act.append(new Option(a.name));
  for (const p of (state.actions && state.actions.presets) || []) act.append(new Option(`${p.group}: ${p.label}`));
  const fl = $('#tb-dl-flag');
  if (!fl.childElementCount) {
    for (const n of ['Slovenija', 'Hrvaška', 'Avstrija', 'Italija', 'Madžarska', 'Nemčija', 'Srbija', 'Bosna in Hercegovina', 'Črna gora', 'Severna Makedonija',
      'Češka', 'Slovaška', 'Poljska', 'Francija', 'Španija', 'Švica', 'Velika Britanija', 'ZDA', 'Kanada', 'Ukrajina', 'Nizozemska', 'Belgija', 'Švedska', 'Norveška',
      'Finska', 'Danska', 'Portugalska', 'Grčija', 'Turčija', 'Japonska', 'Kitajska', 'Brazilija', 'Argentina', 'Avstralija', 'Evropska unija']) fl.append(new Option(n));
  }
}

function renderCfg(t) {
  const box = $('#tb-cfg');
  if (box.contains(document.activeElement)) return;
  box.innerHTML = '';
  const T = (state.titles) || { items: [], templates: [] };
  const lab = (text, input, title) => {
    const l = el('label', 'tb-opt');
    if (title) l.title = title;
    l.append(el('span', '', text), input);
    box.append(l);
    return input;
  };
  const style = el('select', 'mini-select');
  const og1 = document.createElement('optgroup');
  og1.label = 'Slog iz napisa (zavihek Napisi)';
  for (const x of T.items) og1.append(new Option(x.label, x.id));
  const og2 = document.createElement('optgroup');
  og2.label = 'Samo predloga (privzete barve projekta)';
  for (const x of T.templates.filter((y) => !y.clock && y.fields.length)) og2.append(new Option(x.name, `tpl:${x.id}`));
  if (T.items.length) style.append(og1);
  style.append(og2);
  style.value = t.styleTitleId || `tpl:${t.template}`;
  style.onchange = () => {
    const v = style.value;
    run('tables.set', { id: t.id, patch: v.startsWith('tpl:') ? { styleTitleId: null, template: v.slice(4) } : { styleTitleId: v } });
  };
  lab('Napis', style, 'Predloga, barve, velikost in položaj: izberi napis iz zavihka Napisi kot vzorec (njegovo besedilo se zamenja s podatki osebe).');
  const mapIn = (key, label, ph) => {
    const i = el('input', 'text-input tb-map');
    i.value = t.map[key];
    i.placeholder = ph;
    i.onfocus = () => { tbLastMap = key; };
    i.onchange = () => run('tables.set', { id: t.id, patch: { map: { [key]: i.value } } });
    i.onkeydown = (ev) => { if (ev.key === 'Enter') i.blur(); };
    i.dataset.map = key;
    return lab(label, i, 'Imena stolpcev v zavitih oklepajih, npr. {Ime} {Priimek} ali {Funkcija}, {Klub}. {#} = številka.');
  };
  mapIn('f0', 'Naslov', '{Ime}');
  mapIn('f1', 'Podnaslov', '{Funkcija}, {Klub}');
  mapIn('f2', 'Oznaka', 'neobvezno');
  const chips = el('div', 'tb-chips');
  chips.append(el('span', 'hint-inline', 'Vstavi:'));
  for (const c of t.columns.filter((x) => x.kind === 'text' || x.kind === 'flag')) {
    const b = el('button', 'item-btn', `{${c.name}}`);
    b.type = 'button';
    b.onmousedown = (ev) => ev.preventDefault();
    b.onclick = () => {
      const i = box.querySelector(`[data-map="${tbLastMap}"]`);
      const v = `${i.value}${i.value && !/\s$/.test(i.value) ? ' ' : ''}{${c.name}}`;
      run('tables.set', { id: t.id, patch: { map: { [tbLastMap]: v } } });
    };
    chips.append(b);
  }
  box.append(chips);
  const sec = el('input', 'text-input small-num');
  sec.type = 'number';
  sec.min = 0;
  sec.max = 3600;
  sec.value = t.seconds || '';
  sec.placeholder = '0';
  sec.onchange = () => run('tables.set', { id: t.id, patch: { seconds: Number(sec.value) || 0 } });
  lab('Dol po (s)', sec, '0 ali prazno = ostane, dokler ne pritisneš DOL ali GO za naslednjega');
  const when = el('select', 'mini-select');
  for (const [k, v] of [['cue', 'ob pripravi (vpis številke)'], ['go', 'ob GO'], ['off', 'nikoli']]) when.add(new Option(v, k));
  when.value = t.actionWhen;
  when.onchange = () => run('tables.set', { id: t.id, patch: { actionWhen: when.value } });
  lab('Kamera / akcija iz stolpca', when, 'Stolpec vrste "kamera / akcija": ime akcije ali preseta (npr. PTZ preset kamere za to osebo).');
}

function renderTableEditor(force = false) {
  const d = $('#dlg-table');
  if (!d || !d.open) return;
  const t = curTable();
  if (!t) {
    d.close();
    return;
  }
  if (document.activeElement !== $('#tb-name')) $('#tb-name').value = t.name;
  renderCfg(t);
  const sig = JSON.stringify([t.id, t.columns, t.rows, tablesSt().cued, (state.overlays && state.overlays.live) || []]);
  if (!force && (sig === tbSig || tbEdit)) {
    paintSel();
    return;
  }
  tbSig = sig;
  fillDatalists();
  const g = $('#tb-grid');
  g.innerHTML = '';
  const head = el('tr');
  head.append(el('th', 'tb-go', ''), el('th', 'tb-num', '#'));
  t.columns.forEach((c, ci) => {
    const th = el('th');
    const nm = el('input', 'tb-colname');
    nm.value = c.name;
    nm.title = 'Ime stolpca (uporabiš ga v vzorcu napisa kot {ime})';
    nm.onchange = () => run('tables.setColumn', { id: t.id, colId: c.id, patch: { name: nm.value } });
    nm.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') nm.blur(); };
    const kind = el('select', 'mini-select tb-kind');
    for (const [k, v] of Object.entries(KIND_LABEL)) kind.add(new Option(v, k));
    kind.value = c.kind;
    kind.onchange = () => run('tables.setColumn', { id: t.id, colId: c.id, patch: { kind: kind.value } });
    const tools = el('span', 'tb-coltools');
    const b = (txt, title, fn, dis) => {
      const x = el('button', 'item-btn', txt);
      x.title = title;
      x.disabled = !!dis;
      x.onclick = fn;
      return x;
    };
    tools.append(
      b('◀', 'Stolpec levo', () => run('tables.moveColumn', { id: t.id, colId: c.id, index: ci - 1 }), ci === 0),
      b('▶', 'Stolpec desno', () => run('tables.moveColumn', { id: t.id, colId: c.id, index: ci + 1 }), ci === t.columns.length - 1),
      b('✕', 'Izbriši stolpec', () => { if (confirm(`Izbrišem stolpec "${c.name}" z vsemi podatki?`)) run('tables.removeColumn', { id: t.id, colId: c.id }); }),
    );
    th.append(nm, kind, tools);
    head.append(th);
  });
  g.append(head);
  const total = Math.max(t.rows.length + 3, 12);
  for (let r = 0; r < total; r++) {
    const row = t.rows[r];
    const tr = el('tr');
    if (row && isCued(t, row)) tr.classList.add('cued');
    if (row && isLive(t, row)) tr.classList.add('live');
    const go = el('td', 'tb-go');
    if (row && !rowEmpty(row)) {
      const btn = el('button', 'item-btn', '▶');
      btn.title = 'Pripravi napis te osebe (NEXT)';
      btn.onclick = () => cue(t, row);
      go.append(btn);
    }
    tr.append(go);
    for (let c = -1; c < t.columns.length; c++) {
      const td = el('td', c === -1 ? 'tb-num' : `tb-cell k-${t.columns[c].kind}`);
      td.dataset.r = r;
      td.dataset.c = c;
      const v = cellValue(t, r, c);
      if (c === -1) {
        td.textContent = v || (row && !rowEmpty(row) ? String(r + 1) : '');
        if (!v) td.classList.add('auto');
        td.title = 'Številka za klic (prazno = zaporedna). Vpiši svojo, npr. 10.';
      } else {
        if (t.columns[c].kind === 'flag' && v && row.flag && t.columns.find((x) => x.kind === 'flag' && row.cells[x.id]) === t.columns[c]) {
          const img = el('img', 'tb-flag');
          img.src = `/flags/${row.flag}.svg`;
          td.append(img);
        }
        td.append(document.createTextNode(v));
      }
      tr.append(td);
    }
    g.append(tr);
  }
  paintSel();
}

function paintSel() {
  const { rA, rB, cA, cB } = selBox();
  for (const td of $('#tb-grid').querySelectorAll('td[data-r]')) {
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    td.classList.toggle('sel', r >= rA && r <= rB && c >= cA && c <= cB);
    td.classList.toggle('cur', r === tbSel.r1 && c === tbSel.c1);
  }
}

function tdAt(r, c) {
  return $('#tb-grid').querySelector(`td[data-r="${r}"][data-c="${c}"]`);
}

function moveSel(dr, dc, extend) {
  const t = curTable();
  const maxR = Math.max(t.rows.length + 2, 11);
  const r = Math.max(0, Math.min(maxR, tbSel.r1 + dr));
  const c = Math.max(-1, Math.min(t.columns.length - 1, tbSel.c1 + dc));
  tbSel = extend ? { ...tbSel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c };
  paintSel();
  const td = tdAt(r, c);
  if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function startEdit(initial) {
  const t = curTable();
  const { r1: r, c1: c } = tbSel;
  const td = tdAt(r, c);
  if (!td) return;
  tbSel = { r0: r, c0: c, r1: r, c1: c };
  paintSel();
  const inp = el('input', 'tb-input');
  inp.value = initial !== undefined ? initial : cellValue(t, r, c);
  const kind = c >= 0 ? t.columns[c].kind : 'num';
  if (kind === 'image') inp.setAttribute('list', 'tb-dl-media');
  if (kind === 'action') inp.setAttribute('list', 'tb-dl-action');
  if (kind === 'flag') inp.setAttribute('list', 'tb-dl-flag');
  if (kind === 'num') inp.inputMode = 'numeric';
  td.textContent = '';
  td.append(inp);
  tbEdit = { r, c, input: inp, tableId: t.id };
  inp.focus();
  if (initial === undefined) inp.select();
  inp.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); commitEdit(); moveSel(1, 0); $('#tb-grid').focus(); }
    else if (ev.key === 'Tab') { ev.preventDefault(); commitEdit(); moveSel(0, ev.shiftKey ? -1 : 1); $('#tb-grid').focus(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); $('#tb-grid').focus(); }
  };
  inp.onblur = () => { if (tbEdit && tbEdit.input === inp) commitEdit(); };
}

function commitEdit() {
  const e = tbEdit;
  if (!e) return;
  tbEdit = null;
  const t = curTable();
  const old = t ? cellValue(t, e.r, e.c) : '';
  const v = e.input.value.trim();
  if (t && v !== old) run('tables.setCells', { id: e.tableId, cells: [{ row: e.r, col: e.c === -1 ? '#' : e.c, value: v }] });
  tbSig = '';
  renderTableEditor(true);
}

function cancelEdit() {
  tbEdit = null;
  tbSig = '';
  renderTableEditor(true);
}

/** Besedilo iz odložišča (Excel: tabulatorji in nove vrstice, celice z narekovaji). */
function parseTsv(text) {
  const s = String(text).replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const delim = s.includes('\t') ? '\t' : s.includes(';') && !s.includes(',') ? ';' : '\t';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function selText() {
  const t = curTable();
  const { rA, rB, cA, cB } = selBox();
  const lines = [];
  for (let r = rA; r <= rB; r++) {
    const cells = [];
    for (let c = cA; c <= cB; c++) {
      const v = cellValue(t, r, c);
      cells.push(/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    }
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

function clearSel() {
  const t = curTable();
  const { rA, rB, cA, cB } = selBox();
  const cells = [];
  for (let r = rA; r <= Math.min(rB, t.rows.length - 1); r++) for (let c = cA; c <= cB; c++) cells.push({ row: r, col: c === -1 ? '#' : c, value: '' });
  if (cells.length) run('tables.setCells', { id: t.id, cells });
}

function pasteAt(text) {
  const t = curTable();
  const data = parseTsv(text);
  const { rA, cA } = selBox();
  const cells = [];
  let extra = 0;
  data.forEach((line, i) => line.forEach((v, j) => {
    const c = cA + j;
    if (c >= t.columns.length) {
      extra = Math.max(extra, c - t.columns.length + 1);
      return;
    }
    cells.push({ row: rA + i, col: c === -1 ? '#' : c, value: v });
  }));
  if (cells.length) run('tables.setCells', { id: t.id, cells });
  if (extra) showError(`Prilepljeni podatki imajo ${extra} stolpcev preveč. Dodaj stolpce (+ stolpec) in prilepi znova.`);
  tbSel = { r0: rA, c0: cA, r1: rA + data.length - 1, c1: Math.min(t.columns.length - 1, cA + (data[0] || []).length - 1) };
}

function exportCsv() {
  const t = curTable();
  const esc = (v) => (/[";,\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [['#', ...t.columns.map((c) => c.name)].map(esc).join(';')];
  for (const r of t.rows) if (!rowEmpty(r)) lines.push([r.num ? String(r.num) : '', ...t.columns.map((c) => r.cells[c.id] || '')].map(esc).join(';'));
  const blob = new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${t.name}.csv`;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** Uvoz CSV: prva vrstica so imena stolpcev; manjkajoči stolpci se dodajo, podatki gredo za obstoječe vrstice. */
async function importCsv(text) {
  const t = curTable();
  const s = String(text).replace(/^﻿/, '');
  const first = s.split(/\r?\n/)[0] || '';
  const delim = first.includes('\t') ? '\t' : (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = parseTsv(delim === '\t' ? s : s.split('\n').map((l) => {
    // pretvori v tabulatorje (z upoštevanjem narekovajev)
    let out = '';
    let q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      out += !q && ch === delim ? '\t' : ch;
    }
    return out;
  }).join('\n'));
  const header = (rows.shift() || []).map((h) => h.trim());
  if (!header.length) return;
  const cols = [...t.columns];
  const map = [];
  for (const h of header) {
    if (h === '#' || /^(št|st|številka|stevilka)\.?$/i.test(h)) { map.push('#'); continue; }
    let i = cols.findIndex((c) => c.name.toLowerCase() === h.toLowerCase());
    if (i === -1 && h) {
      const kind = /dr[žz]av|country|nation/i.test(h) ? 'flag' : /slika|foto|image|photo/i.test(h) ? 'image' : /kamer|camera|preset/i.test(h) ? 'action' : 'text';
      await run('tables.addColumn', { id: t.id, name: h, kind });
      cols.push({ name: h });
      i = cols.length - 1;
    }
    map.push(i);
  }
  const start = t.rows.filter((r) => !rowEmpty(r)).length ? t.rows.length : 0;
  const cells = [];
  rows.forEach((line, ri) => {
    if (!line.some((v) => v.trim())) return;
    line.forEach((v, j) => {
      if (map[j] === undefined || map[j] === -1) return;
      cells.push({ row: start + ri, col: map[j], value: v });
    });
  });
  if (cells.length) await run('tables.setCells', { id: t.id, cells });
}

(function initTables() {
  if (!$('#tab-people')) return;
  $('#pp-table').onchange = (ev) => { if (ev.target.value) run('tables.active', { id: ev.target.value }); };
  $('#pp-new').onclick = () => run('tables.add', {}).then(() => setTimeout(openTableEditor, 150));
  $('#pp-edit').onclick = openTableEditor;
  $('#pp-search').oninput = renderPeople;
  for (const id of ['#pp-num', '#gfx-num']) {
    const i = $(id);
    i.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { cueNum(i.value); i.value = ''; i.blur(); }
      if (ev.key === 'Escape') { i.value = ''; i.blur(); }
    };
  }
  // Številko lahko kar vtipkaš, kadar ni izbrano nobeno polje (gre v polje poleg CUT/AUTO).
  document.addEventListener('keydown', (ev) => {
    if (!/^[0-9]$/.test(ev.key) || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const a = document.activeElement;
    if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable || a.id === 'tb-grid')) return;
    if (document.querySelector('dialog[open]')) return;
    if (!tablesSt().tables.length) return;
    const hk = (state.settings && state.settings.hotkeys) || {};
    if (Object.values(hk).includes(ev.key)) return;
    ev.preventDefault();
    const i = $('#gfx-num');
    i.focus();
    i.value = ev.key;
  }, true);

  const g = $('#tb-grid');
  g.addEventListener('mousedown', (ev) => {
    const td = ev.target.closest('td[data-r]');
    if (!td || ev.target.tagName === 'INPUT') return;
    if (tbEdit) commitEdit();
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    if (ev.shiftKey) tbSel = { ...tbSel, r1: r, c1: c };
    else tbSel = { r0: r, c0: c, r1: r, c1: c };
    tbDrag = true;
    paintSel();
    ev.preventDefault();
    g.focus();
  });
  g.addEventListener('mouseover', (ev) => {
    if (!tbDrag) return;
    const td = ev.target.closest('td[data-r]');
    if (!td) return;
    tbSel = { ...tbSel, r1: Number(td.dataset.r), c1: Number(td.dataset.c) };
    paintSel();
  });
  document.addEventListener('mouseup', () => { tbDrag = false; });
  g.addEventListener('dblclick', (ev) => {
    const td = ev.target.closest('td[data-r]');
    if (td && ev.target.tagName !== 'INPUT') startEdit();
  });
  g.addEventListener('keydown', (ev) => {
    if (tbEdit) return;
    const k = ev.key;
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) { ev.preventDefault(); moveSel(...arrows[k], ev.shiftKey); return; }
    if (k === 'Tab') { ev.preventDefault(); moveSel(0, ev.shiftKey ? -1 : 1); return; }
    if (k === 'Enter' || k === 'F2') { ev.preventDefault(); startEdit(); return; }
    if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); clearSel(); return; }
    if (k === 'Escape') { ev.stopPropagation(); return; }
    if (k.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); startEdit(k); }
  });
  g.addEventListener('copy', (ev) => {
    if (tbEdit) return;
    ev.preventDefault();
    ev.clipboardData.setData('text/plain', selText());
  });
  g.addEventListener('cut', (ev) => {
    if (tbEdit) return;
    ev.preventDefault();
    ev.clipboardData.setData('text/plain', selText());
    clearSel();
  });
  g.addEventListener('paste', (ev) => {
    if (tbEdit) return;
    ev.preventDefault();
    pasteAt(ev.clipboardData.getData('text/plain'));
  });

  $('#tb-close').onclick = () => { if (tbEdit) commitEdit(); $('#dlg-table').close(); };
  $('#tb-name').onchange = (ev) => { const t = curTable(); if (t) run('tables.set', { id: t.id, patch: { name: ev.target.value } }); };
  $('#tb-name').onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') ev.target.blur(); };
  $('#tb-addrow').onclick = () => { const t = curTable(); if (t) run('tables.addRows', { id: t.id, count: 1 }); };
  $('#tb-addcol').onclick = () => { const t = curTable(); if (t) run('tables.addColumn', { id: t.id, kind: 'text' }); };
  $('#tb-delrows').onclick = () => {
    const t = curTable();
    const { rA, rB } = selBox();
    const ids = t.rows.slice(rA, rB + 1).map((r) => r.id);
    if (ids.length && confirm(`Izbrišem ${ids.length === 1 ? 'izbrano vrstico' : `${ids.length} vrstic`}?`)) run('tables.removeRows', { id: t.id, rowIds: ids });
  };
  $('#tb-delete').onclick = () => {
    const t = curTable();
    if (t && confirm(`Izbrišem celo tabelo "${t.name}"?`)) run('tables.remove', { id: t.id }).then(() => $('#dlg-table').close());
  };
  $('#tb-export').onclick = exportCsv;
  $('#tb-import').onclick = () => $('#tb-file').click();
  $('#tb-file').onchange = (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    f.arrayBuffer().then((buf) => {
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('�')) text = new TextDecoder('windows-1250').decode(buf); // stari Excel CSV
      return importCsv(text);
    }).catch((e) => showError(`Uvoz ni uspel: ${e.message}`));
    ev.target.value = '';
  };
})();

function renderTables() {
  renderPeople();
  renderTableEditor();
}
