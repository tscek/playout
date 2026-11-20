'use strict';
/* global playoutDesktop */

// ---------- povezava z aplikacijo ----------

const api = (() => {
  let ws = null;
  let nextId = 1;
  const waiting = new Map();
  const listeners = { state: [], log: [], times: [], open: [], close: [] };

  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => listeners.open.forEach((f) => f());
    ws.onclose = () => {
      listeners.close.forEach((f) => f());
      for (const [, w] of waiting) w.reject(new Error('Povezava prekinjena'));
      waiting.clear();
      setTimeout(connect, 700);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'reply') {
        const w = waiting.get(msg.id);
        if (!w) return;
        waiting.delete(msg.id);
        if (msg.ok) w.resolve(msg.data);
        else w.reject(new Error(msg.error));
      } else if (listeners[msg.type]) {
        const payload = msg.type === 'state' ? msg.state : msg.type === 'times' ? msg.times : msg.line;
        listeners[msg.type].forEach((f) => f(payload));
      }
    };
  }

  function call(action, args) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) {
        reject(new Error('Ni povezave z aplikacijo'));
        return;
      }
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, action, args }));
    });
  }

  connect();
  return { call, on: (t, f) => listeners[t].push(f) };
})();

// ---------- stanje ----------

const isDesktop = typeof window.playoutDesktop !== 'undefined';
let state = null;
let times = { 1: null, 2: null };
let selectedId = null; // izbira v načinu brez preview
let selectedEntryId = null; // izbira v playlisti v načinu brez preview
let targetGroupId = null; // skupina, v katero gre "+" pri mediju
let drag = null; // { kind: 'media', id } ali { kind: 'entry', id }
let openEntryId = null; // vnos z odprtimi nastavitvami

const END_LABEL = { stop: 'ustavi', cut: 'naprej s CUT', mix: 'naprej s prehodom', loop: 'ponavljaj posnetek' };
const END_ICON = { stop: '⏹', cut: '⏭ CUT', mix: '⏭ prehod', loop: '⟲' };

const $ = (sel) => document.querySelector(sel);

function showError(msg) {
  const el = $('#error');
  if (!msg) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showError.t);
  showError.t = setTimeout(() => el.classList.add('hidden'), 8000);
}

async function run(action, args) {
  try {
    return await api.call(action, args);
  } catch (e) {
    showError(e.message);
    return undefined;
  }
}

const previewMode = () => !state || state.settings.previewMode !== false;

// ---------- monitorji ----------

function startMonitor(img, ch) {
  // Ob prekinitvi (npr. ponovni zagon motorja) se slika samodejno znova poveže.
  const connect = () => {
    img.src = `/monitor/${ch}.mjpg?t=${Date.now()}`;
  };
  img.onerror = () => setTimeout(connect, 1500);
  connect();
  setInterval(() => {
    // Če slika "zamrzne" (prekinjen tok), jo osvežimo.
    if (img.dataset.stale === '1') connect();
  }, 5000);
}
startMonitor($('#pvw-img'), 2);
startMonitor($('#pgm-img'), 1);

// ---------- prikaz ----------

const ENGINE_TEXT = {
  running: ['pill-ok', 'Motor: teče'],
  starting: ['pill-wait', 'Motor: zaganjam …'],
  restarting: ['pill-wait', 'Motor: ponovni zagon …'],
  stopped: ['pill-wait', 'Motor: ustavljen'],
  failed: ['pill-bad', 'Motor: napaka'],
  missing: ['pill-bad', 'Motor: ni nameščen'],
};

function renderEngine() {
  const e = state.engine;
  const [cls, text] = ENGINE_TEXT[e.status] || ['pill-wait', e.status];
  const pill = $('#engine-pill');
  pill.className = `pill ${cls}`;
  pill.textContent = text + (e.safeMode ? ' (varni način)' : '');
  pill.title = [e.text, e.version && `CasparCG ${e.version}`, e.restarts && `Ponovnih zagonov: ${e.restarts}`]
    .filter(Boolean)
    .join('\n');
}

const TYPE_LABEL = { video: 'VIDEO', image: 'SLIKA', audio: 'ZVOK' };

function renderLibrary() {
  const ul = $('#library');
  ul.innerHTML = '';
  const pgmId = state.program && state.program.id;
  const pvwId = state.preview && state.preview.id;
  $('#drop-hint').classList.toggle('hidden', state.library.length > 0);
  $('#lib-hint').textContent = previewMode()
    ? 'Klik = v preview · puščici gor/dol = prejšnji/naslednji v preview'
    : 'Klik = neposredno na program';

  for (const it of state.library) {
    const li = document.createElement('li');
    li.dataset.id = it.id;
    if (!previewMode() && it.id === selectedId) li.classList.add('selected');
    if (it.id === pgmId) li.classList.add('onair');
    if (previewMode() && it.id === pvwId) li.classList.add('inpvw');
    if (it.missing) li.classList.add('missing');
    li.title = it.missing ? `Datoteka ne obstaja: ${it.path}` : it.path;
    li.draggable = true;
    li.ondragstart = (ev) => {
      drag = { kind: 'media', id: it.id };
      ev.dataTransfer.effectAllowed = 'copy';
      ev.dataTransfer.setData('text/plain', it.name);
    };
    li.ondragend = () => { drag = null; };

    const type = document.createElement('span');
    type.className = `type ${it.type}`;
    type.textContent = TYPE_LABEL[it.type] || it.type;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = it.name;
    li.append(type, name);

    if (previewMode() && it.id === pvwId) {
      const b = document.createElement('span');
      b.className = 'badge pvw';
      b.textContent = 'PVW';
      li.append(b);
    }
    if (it.id === pgmId) {
      const b = document.createElement('span');
      b.className = 'badge pgm';
      b.textContent = 'PGM';
      li.append(b);
    }

    if (it.type !== 'image') {
      const loop = document.createElement('button');
      loop.className = 'item-btn' + (it.loop ? ' active' : '');
      loop.textContent = 'LOOP';
      loop.title = 'Ponavljaj v zanki (velja ob naslednjem nalaganju)';
      loop.onclick = (ev) => {
        ev.stopPropagation();
        run('library.loop', { id: it.id, loop: !it.loop });
      };
      li.append(loop);
    }

    const plus = document.createElement('button');
    plus.className = 'item-btn';
    plus.textContent = '+';
    const tg = targetGroup();
    plus.title = tg ? `Dodaj v skupino "${tg.name}"` : 'Dodaj v playlist';
    plus.onclick = (ev) => {
      ev.stopPropagation();
      const g = targetGroup();
      if (g) run('playlist.add', { groupId: g.id, mediaIds: [it.id] });
    };
    li.append(plus);

    const del = document.createElement('button');
    del.className = 'item-btn';
    del.textContent = '✕';
    del.title = 'Odstrani s seznama medijev in iz playliste (datoteka ostane na disku)';
    del.onclick = (ev) => {
      ev.stopPropagation();
      if (it.id === pgmId || it.id === pvwId) {
        showError('Posnetek je na programu ali v preview. Najprej ga počisti.');
        return;
      }
      run('library.remove', { id: it.id });
    };
    li.append(del);

    li.onclick = () => onItemClick(it.id);
    ul.append(li);
  }
}

function targetGroup() {
  if (!state || !state.playlist.length) return null;
  return state.playlist.find((g) => g.id === targetGroupId) || state.playlist[0];
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function onGroupDrop(ev, group, index) {
  ev.preventDefault();
  ev.stopPropagation();
  document.querySelectorAll('.dragover, .drop-before').forEach((x) => x.classList.remove('dragover', 'drop-before'));
  if (!drag) return;
  if (drag.kind === 'media') run('playlist.add', { groupId: group.id, mediaIds: [drag.id], index });
  else if (drag.kind === 'entry') {
    // Premik znotraj iste skupine navzdol: indeks se po odstranitvi zmanjša za 1.
    const from = group.items.findIndex((e) => e.id === drag.id);
    const to = from !== -1 && index !== undefined && index > from ? index - 1 : index;
    run('playlist.moveEntry', { entryId: drag.id, groupId: group.id, index: to });
  }
  drag = null;
}

function renderPlaylist() {
  const box = $('#groups');
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('#groups');
  if (focused && ['text', 'number'].includes(document.activeElement.type)) return; // ne motimo urejanja
  box.innerHTML = '';
  const pgmEntry = state.program && state.program.src && state.program.src.entryId;
  const pvwEntry = state.preview && state.preview.src && state.preview.src.entryId;
  const tg = targetGroup();

  state.playlist.forEach((g, gi) => {
    const wrap = el('div', 'group' + (tg && tg.id === g.id && state.playlist.length > 1 ? ' target' : ''));
    wrap.ondragover = (ev) => {
      if (!drag) return;
      ev.preventDefault();
      wrap.classList.add('dragover');
    };
    wrap.ondragleave = (ev) => {
      if (!wrap.contains(ev.relatedTarget)) wrap.classList.remove('dragover');
    };
    wrap.ondrop = (ev) => onGroupDrop(ev, g, undefined);
    wrap.onclick = () => {
      targetGroupId = g.id;
      render();
    };

    const head = el('div', 'group-head');
    const name = el('input', 'group-name');
    name.value = g.name;
    name.title = 'Ime skupine (klikni za urejanje)';
    name.onclick = (ev) => ev.stopPropagation();
    name.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === 'Escape') name.blur(); };
    name.onchange = () => run('playlist.setGroup', { groupId: g.id, patch: { name: name.value } });
    name.onblur = () => setTimeout(render, 0);

    const opt = (label, key, title) => {
      const l = el('label', 'group-opt' + (g[key] ? ' on' : ''));
      l.title = title;
      const c = el('input');
      c.type = 'checkbox';
      c.checked = !!g[key];
      c.onclick = (ev) => ev.stopPropagation();
      c.onchange = () => run('playlist.setGroup', { groupId: g.id, patch: { [key]: c.checked } });
      l.append(c, document.createTextNode(label));
      return l;
    };
    const fold = el('button', 'item-btn fold', g.collapsed ? '▸' : '▾');
    fold.title = g.collapsed ? 'Razširi skupino' : 'Zloži skupino';
    fold.onclick = (ev) => { ev.stopPropagation(); run('playlist.setGroup', { groupId: g.id, patch: { collapsed: !g.collapsed } }); };
    const endWrap = el('label', 'group-opt' + (g.end !== 'stop' ? ' on' : ''));
    endWrap.title = 'Kaj se zgodi, ko se posnetek konča (velja za vse vnose, ki nimajo svoje nastavitve). Na koncu skupine se ustavi.';
    const endSel = el('select', 'mini-select');
    for (const k of ['stop', 'cut', 'mix']) endSel.add(new Option(END_LABEL[k], k));
    endSel.value = g.end;
    endSel.onclick = (ev) => ev.stopPropagation();
    endSel.onchange = () => run('playlist.setGroup', { groupId: g.id, patch: { end: endSel.value } });
    endWrap.append(document.createTextNode('na koncu'), endSel);
    head.append(fold, name, endWrap, opt('ponavljaj', 'loop', 'Za zadnjim posnetkom skupine spet prvi.'));
    if (g.items.some((e) => e.type === 'image')) {
      const l = el('label', 'group-opt');
      l.title = 'Koliko sekund je slika na programu, preden gre naslednji (če se ne ustavi)';
      const n = el('input');
      n.type = 'number';
      n.min = 1;
      n.max = 3600;
      n.value = g.imageSeconds;
      n.onclick = (ev) => ev.stopPropagation();
      n.onchange = () => run('playlist.setGroup', { groupId: g.id, patch: { imageSeconds: parseInt(n.value, 10) || 5 } });
      n.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === 'Escape') n.blur(); };
      n.onblur = () => setTimeout(render, 0);
      l.append(document.createTextNode('slika'), n, document.createTextNode('s'));
      head.append(l);
    }
    const cue = el('button', 'item-btn', previewMode() ? '▶ v preview' : '▶ predvajaj');
    cue.title = previewMode() ? 'Prvi posnetek skupine v preview' : 'Prvi posnetek skupine na program';
    cue.onclick = (ev) => {
      ev.stopPropagation();
      if (!g.items.length) return;
      if (previewMode()) run('playlist.cueGroup', { groupId: g.id });
      else onEntryClick(g.items[0]);
    };
    const up = el('button', 'item-btn', '▲');
    up.title = 'Skupino premakni gor';
    up.disabled = gi === 0;
    up.onclick = (ev) => { ev.stopPropagation(); run('playlist.moveGroup', { groupId: g.id, index: gi - 1 }); };
    const del = el('button', 'item-btn', '✕');
    del.title = 'Izbriši skupino (mediji ostanejo)';
    del.onclick = (ev) => {
      ev.stopPropagation();
      if (g.items.length && !confirm(`Izbrišem skupino "${g.name}"?`)) return;
      run('playlist.removeGroup', { groupId: g.id });
    };
    head.append(cue, up, del);
    wrap.append(head);

    const ul = el('ul', 'group-list');
    if (g.collapsed) {
      const cur = g.items.findIndex((e) => e.id === pgmEntry || e.id === pvwEntry);
      ul.append(el('div', 'group-empty', `${g.items.length} vnosov` + (cur !== -1 ? ` · trenutno ${cur + 1}.` : '')));
    } else if (!g.items.length) ul.append(el('div', 'group-empty', 'Prazno. Povleci medije sem.'));
    if (!g.collapsed) g.items.forEach((e, i) => {
      const li = el('li');
      if (e.id === pgmEntry) li.classList.add('onair');
      if (previewMode() && e.id === pvwEntry) li.classList.add('inpvw');
      if (!previewMode() && e.id === selectedEntryId) li.classList.add('selected');
      if (e.missing) li.classList.add('missing');
      li.draggable = true;
      li.ondragstart = (ev) => {
        ev.stopPropagation();
        drag = { kind: 'entry', id: e.id };
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', e.name);
      };
      li.ondragend = () => { drag = null; };
      li.ondragover = (ev) => {
        if (!drag) return;
        ev.preventDefault();
        ev.stopPropagation();
        li.classList.add('drop-before');
      };
      li.ondragleave = () => li.classList.remove('drop-before');
      li.ondrop = (ev) => onGroupDrop(ev, g, i);

      const type = el('span', `type ${e.type}`, TYPE_LABEL[e.type] || e.type);
      li.append(el('span', 'num', String(i + 1)), type, el('span', 'name', e.name + (e.loop ? '  ⟲' : '')));
      if (previewMode() && e.id === pvwEntry) {
        li.append(el('span', 'badge pvw', 'PVW'));
        if (state.preview.autoFollow) li.append(el('span', 'badge next', 'SLEDI'));
      }
      if (e.id === pgmEntry) li.append(el('span', 'badge pgm', 'PGM'));
      if (e.inSec || e.outSec) li.append(el('span', 'badge info', `${e.inSec ? fmtTime(e.inSec) : '0:00'}–${e.outSec ? fmtTime(e.outSec) : 'konec'}`));
      if (e.type === 'image' && e.seconds) li.append(el('span', 'badge info', `${e.seconds} s`));
      if (e.end) li.append(el('span', 'badge info end', END_ICON[e.end]));
      const gear = el('button', 'item-btn' + (openEntryId === e.id ? ' active' : ''), '⚙');
      gear.title = 'Nastavitve vnosa: kaj na koncu, trajanje slike, IN/OUT';
      gear.onclick = (ev) => {
        ev.stopPropagation();
        openEntryId = openEntryId === e.id ? null : e.id;
        render();
      };
      li.append(gear);
      const mv = (txt, title, to, dis) => {
        const b = el('button', 'item-btn', txt);
        b.title = title;
        b.disabled = dis;
        b.onclick = (ev) => { ev.stopPropagation(); run('playlist.moveEntry', { entryId: e.id, groupId: g.id, index: to }); };
        return b;
      };
      li.append(mv('▲', 'Gor', i - 1, i === 0), mv('▼', 'Dol', i + 1, i === g.items.length - 1));
      const x = el('button', 'item-btn', '✕');
      x.title = 'Odstrani iz skupine';
      x.onclick = (ev) => { ev.stopPropagation(); run('playlist.removeEntry', { entryId: e.id }); };
      li.append(x);
      li.onclick = (ev) => {
        ev.stopPropagation();
        targetGroupId = g.id;
        onEntryClick(e);
      };
      ul.append(li);
      if (openEntryId === e.id) ul.append(entryEditor(e, g));
    });
    wrap.append(ul);
    box.append(wrap);
  });
}

function entryEditor(e, g) {
  const box = el('div', 'entry-edit');
  box.onclick = (ev) => ev.stopPropagation();
  const set = (patch) => run('playlist.setEntry', { entryId: e.id, patch });

  const endL = el('label', 'group-opt');
  const sel = el('select', 'mini-select');
  sel.add(new Option(`kot skupina (${END_LABEL[g.end]})`, ''));
  for (const k of ['stop', 'cut', 'mix', 'loop']) sel.add(new Option(END_LABEL[k], k));
  sel.value = e.end || '';
  sel.onchange = () => set({ end: sel.value || null });
  endL.append(document.createTextNode('Na koncu'), sel);
  box.append(endL);

  if (e.type === 'image') {
    const l = el('label', 'group-opt');
    const n = el('input');
    n.type = 'number';
    n.min = 1;
    n.max = 3600;
    n.placeholder = String(g.imageSeconds);
    n.value = e.seconds || '';
    n.onchange = () => set({ seconds: n.value === '' ? null : parseFloat(n.value) });
    n.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === 'Escape') n.blur(); };
    n.onblur = () => setTimeout(render, 0);
    l.append(document.createTextNode('Trajanje'), n, document.createTextNode(`s (prazno = ${g.imageSeconds} s)`));
    box.append(l);
  } else {
    const point = (label, key) => {
      const l = el('span', 'group-opt');
      l.append(document.createTextNode(`${label} ${e[key] ? fmtTime(e[key]) + '.' + String(Math.round((e[key] % 1) * 100)).padStart(2, '0') : '—'}`));
      if (e[key]) {
        const x = el('button', 'item-btn', '✕');
        x.title = `Pobriši ${label} točko`;
        x.onclick = () => set({ [key]: null });
        l.append(x);
      }
      return l;
    };
    box.append(point('IN', 'inSec'), point('OUT', 'outSec'),
      el('span', 'hint-inline', 'IN in OUT nastaviš v preview: zapelji drsnik in klikni IN ali OUT.'));
  }
  return box;
}

function onEntryClick(e) {
  if (previewMode()) {
    run('preview.load', { id: e.mediaId, entryId: e.id });
  } else {
    selectedId = null;
    selectedEntryId = e.id;
    run('program.direct', { id: e.mediaId, entryId: e.id });
  }
}

function renderPanic() {
  const b = $('#btn-panic');
  b.classList.toggle('on', !!state.panic);
  b.textContent = state.panic ? 'PANIKA VKLOPLJENA · izklop' : 'PANIKA';
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return (h ? `${h}:` : '') + `${pad(m)}:${pad(s % 60)}`;
}

function timeText(item, t) {
  if (!item) return ['', ''];
  if (item.type === 'image') return ['slika', ''];
  if (!t || !t.total) return ['', ''];
  const end = item.outSec || t.total;
  const start = item.inSec || 0;
  if (item.loop) return [`zanka · ${fmtTime(t.elapsed - start)} / ${fmtTime(end - start)}`, ''];
  const left = end - t.elapsed;
  const cls = left <= 0.5 ? 'time-end' : left <= 10 ? 'time-warn' : '';
  return [`−${fmtTime(Math.ceil(left))}  (${fmtTime(end - start)})`, cls];
}

function renderMonitors() {
  const pvw = state.preview;
  const pgm = state.program;
  $('.monitors').classList.toggle('nopvw', !previewMode());
  $('#pvw-name').textContent = pvw ? pvw.name + (pvw.autoFollow ? '  · sledi samodejno' : '') : '—';
  $('#pgm-name').textContent = pgm ? pgm.name : '—';
  $('#pvw-empty').classList.toggle('hidden', !!pvw);
  $('#pgm-empty').classList.toggle('hidden', !!pgm);
  $('#mon-pgm').classList.toggle('live', !!pgm);
  renderTimes();

  $('#btn-cut').classList.toggle('hidden', !previewMode());
  $('#btn-auto').classList.toggle('hidden', !previewMode());
  $('#direct-panel').classList.toggle('hidden', previewMode());
  $('#btn-cut').disabled = !pvw;
  $('#btn-auto').disabled = !pvw;
  $('#auto-next').closest('label').classList.toggle('hidden', !previewMode());
}

const fmtDb = (db) => (db <= -40 ? 'utišano' : `${db > 0 ? '+' : ''}${Number(db).toFixed(1)} dB`);

/** Drsnik po posnetku in jakost pod monitorjem. */
function renderMonCtl(prefix, item, t) {
  const scrub = $(`#${prefix}-scrub`);
  const canSeek = !!(item && item.type !== 'image' && t && t.total);
  scrub.disabled = !canSeek;
  if (canSeek && !scrub.dragging) scrub.value = Math.round((t.elapsed / t.total) * 1000);
  if (!canSeek && !scrub.dragging) scrub.value = 0;
  // IN/OUT oznake na drsniku
  const wrap = scrub.parentElement;
  if (canSeek && (item.inSec || item.outSec)) {
    const a = ((item.inSec || 0) / t.total) * 100;
    const b = ((item.outSec || t.total) / t.total) * 100;
    wrap.style.setProperty('--in', `${a}%`);
    wrap.style.setProperty('--out', `${b}%`);
    wrap.classList.add('has-range');
  } else wrap.classList.remove('has-range');
  if (prefix === 'pvw') {
    for (const k of ['in', 'out']) {
      const b = $(`#btn-mark-${k}`);
      b.disabled = !canSeek;
      const v = item && item[`${k}Sec`];
      b.classList.toggle('active', !!v);
      b.title = (k === 'in' ? 'IN: začetek posnetka na trenutnem mestu' : 'OUT: konec posnetka na trenutnem mestu')
        + (v ? ` (zdaj ${fmtTime(v)}; desni klik pobriše)` : '');
    }
  }
  const vol = $(`#${prefix}-vol`);
  vol.disabled = !item || item.type === 'image';
  if (!vol.dragging) vol.value = item ? item.volumeDb || 0 : 0;
  $(`#${prefix}-vol-val`).textContent = item && item.type !== 'image' ? fmtDb(Number(vol.value)) : '';
}

function renderTimes() {
  if (!state) return;
  renderMonCtl('pvw', state.preview, times[2]);
  renderMonCtl('pgm', state.program, times[1]);
  const [pt, pc] = timeText(state.program, times[1]);
  const el = $('#pgm-time');
  el.textContent = pt;
  el.className = pc;
  const [vt] = timeText(state.preview, times[2]);
  $('#pvw-time').textContent = state.preview && state.preview.type !== 'image' && times[2] && times[2].total
    ? `dolžina ${fmtTime(times[2].total)}`
    : vt;
}

function fillTakeControls() {
  const s = state.settings;
  const typeSel = $('#tr-type');
  if (!typeSel.options.length) {
    for (const [k, v] of Object.entries(state.transitions)) typeSel.add(new Option(v, k));
    for (const [k, v] of Object.entries(state.directions)) $('#tr-dir').add(new Option(v, k));
  }
  if (document.activeElement !== typeSel) typeSel.value = s.transitionType;
  if (document.activeElement !== $('#tr-frames')) $('#tr-frames').value = s.transitionFrames;
  if (document.activeElement !== $('#tr-dir')) $('#tr-dir').value = s.transitionDirection;
  $('#tr-dir-wrap').classList.toggle('hidden', !['WIPE', 'SLIDE', 'PUSH'].includes(s.transitionType));
  $('#auto-next').checked = !!s.autoNext;
  const mv = $('#master-vol');
  if (!mv.dragging) mv.value = s.masterVolumeDb || 0;
  $('#master-val').textContent = fmtDb(Number(mv.value));
  $('#mode-preview').checked = previewMode();
  for (const r of document.querySelectorAll('input[name=direct]')) r.checked = r.value === s.directTake;
}

function render() {
  if (!state) return;
  renderEngine();
  renderLibrary();
  renderPlaylist();
  renderPanic();
  renderMonitors();
  fillTakeControls();
  if (state.lastError && state.lastError !== render.lastError) showError(state.lastError);
  render.lastError = state.lastError;
}

// ---------- ukazi ----------

function onItemClick(id) {
  if (previewMode()) {
    run('preview.load', { id });
  } else {
    selectedId = id;
    selectedEntryId = null;
    run('program.direct', { id });
  }
}

/** Puščici gor/dol: po playlisti, če je trenutni posnetek iz nje, sicer po medijih. */
function stepPreview(dir) {
  if (!state) return;
  const curEntry = previewMode() ? state.preview && state.preview.src && state.preview.src.entryId : selectedEntryId;
  if (curEntry) {
    const flat = state.playlist.flatMap((g) => g.items);
    let i = flat.findIndex((e) => e.id === curEntry);
    if (i !== -1) {
      i = Math.max(0, Math.min(flat.length - 1, i + dir));
      const e = flat[i];
      if (previewMode()) run('preview.load', { id: e.mediaId, entryId: e.id });
      else {
        selectedEntryId = e.id;
        render();
      }
      return;
    }
  }
  const items = state.library;
  if (!items.length) return;
  const cur = previewMode() ? state.preview && state.preview.id : selectedId;
  let i = items.findIndex((x) => x.id === cur);
  i = i === -1 ? (dir > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + dir));
  if (previewMode()) {
    run('preview.load', { id: items[i].id });
  } else {
    selectedId = items[i].id;
    selectedEntryId = null;
    render();
  }
}

/** V načinu brez preview: Enter/preslednica predvaja izbrani posnetek. */
function directSelected(kind) {
  if (selectedEntryId) {
    const e = state.playlist.flatMap((g) => g.items).find((x) => x.id === selectedEntryId);
    if (e) run('program.direct', { id: e.mediaId, entryId: e.id, kind });
  } else if (selectedId) run('program.direct', { id: selectedId, kind });
}

const settingsPatch = (patch) => run('settings.update', patch);

/** Drsnik, ki med vlečenjem pošilja največ ~8x na sekundo, ob spustu pa končno vrednost. */
function liveSlider(input, send, onInput) {
  let last = 0;
  let timer = null;
  let lastVal = null;
  const send0 = send;
  send = (v) => {
    if (v === lastVal) return;
    lastVal = v;
    send0(v);
  };
  input.addEventListener('pointerdown', () => { lastVal = null; });
  input.addEventListener('pointerdown', () => { input.dragging = true; });
  input.addEventListener('input', () => {
    input.dragging = true;
    if (onInput) onInput();
    const now = Date.now();
    clearTimeout(timer);
    if (now - last > 120) {
      last = now;
      send(Number(input.value));
    } else timer = setTimeout(() => { last = Date.now(); send(Number(input.value)); }, 120);
  });
  input.addEventListener('change', () => {
    clearTimeout(timer);
    send(Number(input.value));
    setTimeout(() => { input.dragging = false; }, 300);
    input.blur();
  });
}

for (const [prefix, which, ch] of [['pvw', 'preview', 2], ['pgm', 'program', 1]]) {
  const scrub = $(`#${prefix}-scrub`);
  // Med vlečenjem se slika premika (največ ~8x na sekundo), ob spustu gre končna vrednost.
  liveSlider(scrub, (v) => {
    const t = times[ch];
    if (t && t.total) run('seek', { which, seconds: (v / 1000) * t.total });
  });
  const vol = $(`#${prefix}-vol`);
  liveSlider(vol, (db) => {
    const item = state && state[which];
    if (item) run('media.volume', { id: item.id, db });
  }, () => { $(`#${prefix}-vol-val`).textContent = fmtDb(Number(vol.value)); });
}
liveSlider($('#master-vol'), (db) => settingsPatch({ masterVolumeDb: db }),
  () => { $('#master-val').textContent = fmtDb(Number($('#master-vol').value)); });

$('#btn-cut').onclick = () => run('take.cut');
for (const k of ['in', 'out']) {
  const b = $(`#btn-mark-${k}`);
  b.onclick = () => run('preview.mark', { which: k });
  b.oncontextmenu = (ev) => {
    ev.preventDefault();
    run('preview.mark', { which: k, clear: true });
  };
}
$('#btn-panic').onclick = () => run('program.panic', { on: !(state && state.panic) });
$('#btn-add-group').onclick = () => run('playlist.addGroup').then((id) => {
  if (id) targetGroupId = id;
});
$('#btn-auto').onclick = () => run('take.auto');
$('#btn-pvw-clear').onclick = () => run('preview.clear');
$('#btn-pgm-clear').onclick = () => run('program.clear');
$('#btn-pgm-fade').onclick = () => run('program.clear', { fade: true });
$('#tr-type').onchange = (e) => settingsPatch({ transitionType: e.target.value });
$('#tr-frames').onchange = (e) => settingsPatch({ transitionFrames: parseInt(e.target.value, 10) || 12 });
$('#tr-dir').onchange = (e) => settingsPatch({ transitionDirection: e.target.value });
$('#auto-next').onchange = (e) => settingsPatch({ autoNext: e.target.checked });
$('#mode-preview').onchange = (e) => settingsPatch({ previewMode: e.target.checked });
for (const r of document.querySelectorAll('input[name=direct]')) {
  r.onchange = () => settingsPatch({ directTake: r.value });
}

$('#btn-add').onclick = () => {
  if (!isDesktop) {
    showError('Medije lahko dodajaš samo na računalniku.');
    return;
  }
  run('library.pickFiles');
};

// Po kliku na stikalo ali izbiro fokus ne sme ostati tam, sicer bi preslednica (AUTO) preklopila stikalo.
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t && (t.type === 'checkbox' || t.type === 'radio' || t.tagName === 'SELECT') && !t.closest('dialog')) t.blur();
});

document.addEventListener('keydown', (ev) => {
  if (document.querySelector('dialog[open]')) return;
  const tag = (ev.target && ev.target.tagName) || '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (ev.key === 'Enter') {
    ev.preventDefault();
    if (previewMode()) run('take.cut');
    else directSelected('cut');
  } else if (ev.key === ' ') {
    ev.preventDefault();
    if (previewMode()) run('take.auto');
    else directSelected('auto');
  } else if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    stepPreview(1);
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    stepPreview(-1);
  }
});

// Povleci in spusti datoteke.
const libPanel = $('.library');
const isFileDrag = (ev) => ev.dataTransfer && [...ev.dataTransfer.types].includes('Files');
libPanel.addEventListener('dragover', (ev) => {
  if (!isFileDrag(ev)) return;
  ev.preventDefault();
  libPanel.classList.add('dragover');
});
libPanel.addEventListener('dragleave', () => libPanel.classList.remove('dragover'));
libPanel.addEventListener('drop', (ev) => {
  if (!isFileDrag(ev)) return;
  ev.preventDefault();
  libPanel.classList.remove('dragover');
  if (!isDesktop) return;
  const paths = [...ev.dataTransfer.files].map((f) => window.playoutDesktop.pathForFile(f)).filter(Boolean);
  if (paths.length) run('library.addPaths', { paths });
});

// ---------- nastavitve ----------

async function loadAudioDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs
      .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label)
      .map((d) => d.label);
  } catch {
    return [];
  }
}

function fillSelect(sel, options, value) {
  sel.innerHTML = '';
  for (const [val, label] of options) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    sel.append(o);
  }
  sel.value = value;
  if (sel.value !== value && value) {
    // Shranjena vrednost ni več na voljo (npr. odklopljen zaslon).
    const o = document.createElement('option');
    o.value = value;
    o.textContent = `${value} (ni na voljo)`;
    sel.append(o);
    sel.value = value;
  }
}

function fillSettings() {
  const s = state.settings;
  fillSelect($('#set-videomode'), Object.entries(state.videoModes), s.videoMode);
  const outs = [['auto', 'Samodejno (prvi zunanji zaslon)']];
  for (const d of state.displays) outs.push([d.device, d.label]);
  outs.push(['test', 'Testno okno (na glavnem zaslonu)']);
  outs.push(['none', 'Brez slike (samo zvok)']);
  fillSelect($('#set-output'), outs, s.programOutput);
  const res = state.programOutputResolved;
  const resDisp = state.displays.find((d) => d.device === res);
  $('#out-resolved').textContent = 'Trenutno: ' + (resDisp ? resDisp.label : res === 'test' ? 'testno okno' : 'brez slike');
  $('#displays-error').textContent = state.displaysError || '';
  $('#displays-error').classList.toggle('hidden', !state.displaysError);
  $('#audio-warning').textContent = state.audioWarning || '';
  $('#audio-warning').classList.toggle('hidden', !state.audioWarning);
  $('#set-avdelay').value = s.audioDelayFrames || 0;
  const audios = [['', 'Privzeta naprava sistema']];
  for (const a of state.audioDevices) audios.push([a, a]);
  fillSelect($('#set-audio'), audios, s.audioDevice);
  const panic = [['', 'Črno']];
  for (const it of state.library) if (it.type !== 'audio') panic.push([it.id, it.name]);
  fillSelect($('#set-panic'), panic, s.panicSource || '');
}

$('#btn-settings').onclick = async () => {
  const devices = await loadAudioDevices();
  if (devices.length) await run('audio.devices', { devices });
  fillSettings();
  const info = await run('app.info');
  if (info) {
    $('#about').textContent =
      `Playout ${info.version}\nMotor: ${state.engine.version ? 'CasparCG ' + state.engine.version : '—'}\n` +
      `Podatki: ${info.dataDir}`;
  }
  $('#dlg-settings').showModal();
};

$('#btn-refresh-displays').onclick = async () => {
  await run('displays.refresh');
  fillSettings();
};

$('#btn-test-media').onclick = () => run('library.addTestMedia');
$('#btn-open-logs').onclick = () => run('app.openLogs');

$('#dlg-settings').addEventListener('close', () => {
  if ($('#dlg-settings').returnValue !== 'save') return;
  run('settings.update', {
    videoMode: $('#set-videomode').value,
    programOutput: $('#set-output').value,
    audioDevice: $('#set-audio').value,
    audioDelayFrames: parseInt($('#set-avdelay').value, 10) || 0,
    panicSource: $('#set-panic').value,
  });
});

// ---------- dnevnik ----------

const logEl = $('#log');
function appendLog(line) {
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
  logEl.textContent += line + '\n';
  if (logEl.textContent.length > 200000) logEl.textContent = logEl.textContent.slice(-150000);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

$('#btn-log').onclick = async () => {
  const lines = await run('engine.log');
  logEl.textContent = (lines || []).join('\n') + '\n';
  $('#dlg-log').showModal();
  logEl.scrollTop = logEl.scrollHeight;
};
$('#btn-engine-restart').onclick = () => {
  if (state && state.program && !confirm('Na programu nekaj teče. Res ponovno zaženem motor?')) return;
  run('engine.restart');
};

// ---------- dogodki ----------

api.on('state', (s) => {
  state = s;
  if (s.times) times = s.times;
  render();
});
api.on('times', (t) => {
  times = t;
  renderTimes();
});
api.on('log', (line) => {
  if ($('#dlg-log').open) appendLog(line);
});
api.on('open', () => $('#conn-banner').classList.add('hidden'));
api.on('close', () => $('#conn-banner').classList.remove('hidden'));
