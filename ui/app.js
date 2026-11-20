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

// Mediji: drevo projektne mape, filter in razvrščanje (shrani se v tem brskalniku).
const lsGet = (k, d) => {
  try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; }
};
const lsSet = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ni pomembno */ }
};
let libFilter = lsGet('libFilter', 'all');
let libSort = lsGet('libSort', 'name');
let foldedFolders = new Set(lsGet('foldedFolders', []));
let currentFolder = ''; // izbrana podmapa (za + Mapa, Dodaj medije)
let newFolderOpen = false;
let libOrder = []; // vidni vrstni red (za puščici)
const TYPE_ORDER = { video: 0, image: 1, audio: 2 };

function sortItems(items) {
  const byName = (a, b) => a.name.localeCompare(b.name, 'sl', { numeric: true, sensitivity: 'base' });
  const arr = [...items];
  if (libSort === 'type') arr.sort((a, b) => (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || byName(a, b));
  else if (libSort === 'date') arr.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0) || byName(a, b));
  else arr.sort(byName);
  return arr;
}

function libItemRow(it, depth, ctx) {
  const { pgmId, pvwId } = ctx;
  const li = document.createElement('li');
  li.dataset.id = it.id;
  li.style.paddingLeft = `${8 + depth * 16}px`;
  if (!previewMode() && it.id === selectedId) li.classList.add('selected');
  if (it.id === pgmId) li.classList.add('onair');
  if (previewMode() && it.id === pvwId) li.classList.add('inpvw');
  if (it.missing) li.classList.add('missing');
  li.title = it.missing ? `Datoteka ne obstaja: ${it.path}` : it.path;
  li.draggable = true;
  li.ondragstart = (ev) => {
    drag = { kind: 'media', id: it.id };
    ev.dataTransfer.effectAllowed = 'copyMove';
    ev.dataTransfer.setData('text/plain', it.name);
  };
  li.ondragend = () => { drag = null; };
  li.append(el('span', `type ${it.type}`, TYPE_LABEL[it.type] || it.type), el('span', 'name', it.name));
  if (previewMode() && it.id === pvwId) li.append(el('span', 'badge pvw', 'PVW'));
  if (it.id === pgmId) li.append(el('span', 'badge pgm', 'PGM'));

  const plus = el('button', 'item-btn', '+');
  const tg = targetGroup();
  plus.title = tg ? `Dodaj v skupino "${tg.name}"` : 'Dodaj v playlist';
  plus.onclick = (ev) => {
    ev.stopPropagation();
    const g = targetGroup();
    if (g) run('playlist.add', { groupId: g.id, mediaIds: [it.id] });
  };
  li.append(plus);

  const del = el('button', 'item-btn', '✕');
  const inFolder = !!it.rel;
  del.title = inFolder ? 'Izbriši datoteko (gre v koš) in jo odstrani iz playliste' : 'Odstrani s seznama in iz playliste (datoteka ostane na disku)';
  del.onclick = (ev) => {
    ev.stopPropagation();
    if (it.id === pgmId || it.id === pvwId) {
      showError('Posnetek je na programu ali v preview. Najprej ga počisti.');
      return;
    }
    const used = state.playlist.reduce((n, g) => n + g.items.filter((e) => e.mediaId === it.id).length, 0);
    const msg = (inFolder && !it.missing ? `Datoteko "${it.name}" premaknem v koš?` : `Odstranim "${it.name}" s seznama?`)
      + (used ? `\nV playlisti je ${used}x, tudi tam bo odstranjena.` : '');
    if (confirm(msg)) run('library.remove', { id: it.id });
  };
  li.append(del);
  li.onclick = () => onItemClick(it.id);
  libOrder.push(it.id);
  return li;
}

function folderRow(rel, name, depth, count, folded) {
  const li = document.createElement('li');
  li.className = 'folder' + (rel === currentFolder ? ' sel' : '');
  li.dataset.rel = rel;
  li.style.paddingLeft = `${8 + depth * 16}px`;
  li.append(el('span', 'fold', folded ? '▸' : '▾'), el('span', 'name', `📁 ${name}`), el('span', 'count', String(count)));
  li.title = 'Klik: zloži / razloži in izberi mapo. Povleci medij sem, da ga premakneš v to mapo.';
  li.onclick = () => {
    currentFolder = rel;
    if (rel) {
      if (foldedFolders.has(rel)) foldedFolders.delete(rel);
      else foldedFolders.add(rel);
      lsSet('foldedFolders', [...foldedFolders]);
    }
    renderLibrary();
  };
  li.ondragover = (ev) => {
    if (!(drag && drag.kind === 'media') && !isFileDrag(ev)) return;
    ev.preventDefault();
    li.classList.add('dragover');
  };
  li.ondragleave = () => li.classList.remove('dragover');
  li.ondrop = (ev) => {
    li.classList.remove('dragover');
    if (drag && drag.kind === 'media') {
      ev.preventDefault();
      ev.stopPropagation();
      const it = state.library.find((x) => x.id === drag.id);
      if (it && !it.rel) showError('Premikati je mogoče samo datoteke iz projektne mape.');
      else run('library.moveTo', { id: drag.id, folder: rel });
      drag = null;
    }
    // datoteke od zunaj obdela spust na panelu (s to mapo kot ciljem)
  };
  return li;
}

function newFolderRow(depth) {
  const li = el('li', 'newfolder');
  li.style.paddingLeft = `${8 + depth * 16}px`;
  const inp = el('input', 'text-input');
  inp.placeholder = 'Ime nove mape, Enter';
  const done = (ok) => {
    newFolderOpen = false;
    if (ok && inp.value.trim()) {
      run('library.newFolder', { parent: currentFolder, name: inp.value.trim() }).then((rel) => {
        if (rel) currentFolder = rel;
      });
    }
    renderLibrary();
  };
  inp.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') done(true);
    if (ev.key === 'Escape') done(false);
  };
  inp.onblur = () => { if (newFolderOpen) done(!!inp.value.trim()); };
  li.append(el('span', 'fold', ''), el('span', 'name', '📁'), inp);
  setTimeout(() => inp.focus(), 0);
  return li;
}

function renderLibrary() {
  const ul = $('#library');
  ul.innerHTML = '';
  libOrder = [];
  const proj = state.project || { folders: [] };
  const ctx = { pgmId: state.program && state.program.id, pvwId: state.preview && state.preview.id };
  $('#drop-hint').classList.toggle('hidden', state.library.length > 0 || !!proj.mediaDir);
  $('#lib-hint').textContent = previewMode()
    ? 'Klik = v preview · puščici gor/dol = prejšnji/naslednji v preview'
    : 'Klik = neposredno na program';
  for (const b of document.querySelectorAll('#lib-filter button')) b.classList.toggle('on', b.dataset.f === libFilter);
  $('#lib-sort').value = libSort;
  $('#btn-new-folder').classList.toggle('hidden', !proj.mediaDir);

  // Vrstica z mapo projekta
  const lf = $('#lib-folder');
  lf.innerHTML = '';
  if (proj.folderError) lf.append(el('span', 'bad', proj.folderError));
  else if (proj.mediaDir) {
    lf.textContent = `Mapa: ${proj.mediaDir}`;
    lf.title = proj.mediaDir;
  } else {
    lf.append('Projekt nima medijske mape. ');
    const a = el('a', '', 'Izberi mapo');
    a.onclick = () => (isDesktop ? run('project.pickFolder') : showError('Mapo lahko izbereš samo na računalniku.'));
    lf.append(a);
  }
  const cp = $('#lib-copying');
  cp.classList.toggle('hidden', !proj.copying);
  if (proj.copying) cp.textContent = `Kopiram v projektno mapo: ${proj.copying.name} (${proj.copying.done + 1}/${proj.copying.total}) …`;

  const visible = state.library.filter((it) => libFilter === 'all' || it.type === libFilter);
  if (!proj.mediaDir) {
    for (const it of sortItems(visible)) ul.append(libItemRow(it, 0, ctx));
    return;
  }
  if (currentFolder && !proj.folders.includes(currentFolder)) currentFolder = '';

  // Drevo: mape in datoteke po mapah
  const inFolder = visible.filter((it) => it.rel);
  const byDir = new Map();
  for (const it of inFolder) {
    const d = it.rel.includes('/') ? it.rel.slice(0, it.rel.lastIndexOf('/')) : '';
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(it);
  }
  const countIn = (rel) => inFolder.filter((it) => it.rel.startsWith(`${rel}/`)).length;
  const children = (parent) => proj.folders.filter((f) => {
    const p = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    return p === parent;
  });
  const rootName = proj.mediaDir.split(/[\\/]/).filter(Boolean).pop() || proj.mediaDir;
  const root = folderRow('', rootName, 0, inFolder.length, false);
  root.querySelector('.fold').textContent = '';
  ul.append(root);
  const walk = (parent, depth) => {
    if (newFolderOpen && parent === currentFolder) ul.append(newFolderRow(depth));
    for (const f of children(parent)) {
      const n = countIn(f);
      if (libFilter !== 'all' && !n) continue;
      const folded = foldedFolders.has(f);
      ul.append(folderRow(f, f.slice(f.lastIndexOf('/') + 1), depth, n, folded));
      if (!folded) walk(f, depth + 1);
    }
    for (const it of sortItems(byDir.get(parent) || [])) ul.append(libItemRow(it, depth, ctx));
  };
  walk('', 1);
  const outside = visible.filter((it) => !it.rel);
  if (outside.length) {
    const li = el('li', 'folder');
    li.append(el('span', 'fold', ''), el('span', 'name', '↗ Zunaj projektne mape'), el('span', 'count', String(outside.length)));
    li.title = 'Datoteke, ki niso v projektni mapi (dodane pred izbiro mape). Povleci jih v mapo v Raziskovalcu ali jih dodaj znova.';
    ul.append(li);
    for (const it of sortItems(outside)) ul.append(libItemRow(it, 1, ctx));
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
      if (e.layers && e.layers.length) li.append(el('span', 'badge info', `▤ ${e.layers.length}`));
      if (e.muted) li.append(el('span', 'badge info', '🔇'));
      else if (e.volumeDb && e.type !== 'image') li.append(el('span', 'badge info', fmtDb(e.volumeDb)));
      if (e.type !== 'audio' && (e.fit && e.fit !== 'fit' || e.zoom !== 1 || e.posX || e.posY)) li.append(el('span', 'badge info', '▣'));
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

  // Akcije ob začetku in koncu vnosa
  const acts = (state.actions && state.actions.actions) || [];
  const actSel = (value) => {
    const sel = el('select', 'mini-select');
    sel.add(new Option('—', ''));
    for (const a of acts) sel.add(new Option(a.name, a.id));
    if (value && !acts.some((a) => a.id === value)) sel.add(new Option('(izbrisana akcija)', value));
    sel.value = value || '';
    return sel;
  };
  const startL = el('label', 'group-opt');
  const startSel = actSel(e.startAction);
  startSel.onchange = () => set({ startAction: startSel.value || null });
  startL.title = 'Akcija, ki se sproži, ko gre vnos na program';
  startL.append(document.createTextNode('Akcija ob začetku'), startSel);
  const endActL = el('label', 'group-opt');
  endActL.title = 'Akcija, ki se sproži, ko se posnetek konča (ali toliko sekund prej). Ne sproži se, če ga prej zamenjaš sam.';
  const endActSel = actSel(e.endAction);
  endActSel.onchange = () => set({ endAction: endActSel.value || null });
  const lead = el('input');
  lead.type = 'number';
  lead.min = 0;
  lead.max = 30;
  lead.step = 0.5;
  lead.value = e.endLead || 0;
  lead.onchange = () => set({ endLead: parseFloat(lead.value) || 0 });
  lead.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === 'Escape') lead.blur(); };
  lead.onblur = () => setTimeout(render, 0);
  endActL.append(document.createTextNode('Akcija ob koncu'), endActSel, lead, document.createTextNode('s prej'));
  box.append(startL, endActL);
  if (!acts.length) box.append(el('span', 'hint-inline', 'Akcije pripraviš z gumbom "Akcije" zgoraj.'));

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
        const media = state.library.find((m) => m.id === e.mediaId);
        const fps = (media && media.fps) || channelFps();
        for (const [txt, d] of [['−1s', -1], ['−1f', -1 / fps], ['+1f', 1 / fps], ['+1s', 1]]) {
          const b = el('button', 'item-btn', txt);
          b.title = `Premakni ${label} točko za ${txt.replace('f', ' sličico').replace('s', ' sekundo')}`;
          b.onclick = () => set({ [key]: Math.max(0, Math.round((e[key] + d) * 1000) / 1000) });
          l.append(b);
        }
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

let clockSkew = 0; // razlika med uro aplikacije in tega zaslona

/** Preostali čas slike s trajanjem (na programu). */
function imageLeft(item) {
  if (!item || item.type !== 'image' || !item.seconds || !item.startedAt) return null;
  const now = item.paused ? item.pausedAt : Date.now() + clockSkew;
  return item.seconds - (now - item.startedAt) / 1000;
}

function timeText(item, t) {
  if (!item) return ['', ''];
  if (item.type === 'image') {
    const left = imageLeft(item);
    if (left === null) return [item.seconds ? `slika · ${item.seconds} s` : 'slika', ''];
    const cls = left <= 0.5 ? 'time-end' : left <= 10 ? 'time-warn' : '';
    return [`−${fmtTime(Math.ceil(Math.max(0, left)))}  (${fmtTime(item.seconds)})${item.paused ? '  ❚❚' : ''}`, cls];
  }
  if (!t || !t.total) return ['', ''];
  const end = item.outSec || t.total;
  const start = item.inSec || 0;
  if (item.loop) return [`zanka · ${fmtTime(t.elapsed - start)} / ${fmtTime(end - start)}`, ''];
  const left = end - t.elapsed;
  const cls = left <= 0.5 ? 'time-end' : left <= 10 ? 'time-warn' : '';
  return [`−${fmtTime(Math.ceil(left))}  (${fmtTime(end - start)})${item.paused ? '  ❚❚' : ''}`, cls];
}

const channelFps = () => {
  const m = state && /^\d+[pi](\d{2})(\d{2})$/.exec(state.settings.videoMode);
  return m ? parseInt(m[1], 10) + parseInt(m[2], 10) / 100 : 25;
};

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
  // Nastavitve (IN/OUT, jakost, mute, prileganje) ima samo vnos v playlisti.
  const editable = !!(item && item.src);
  const lockNote = 'Posnetek iz Medijev: za nastavitve ga dodaj v playlisto';
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
      b.disabled = !canSeek || !editable;
      const v = item && item[`${k}Sec`];
      b.classList.toggle('active', !!v);
      b.title = item && !editable ? lockNote : (k === 'in' ? 'IN: začetek posnetka na trenutnem mestu' : 'OUT: konec posnetka na trenutnem mestu')
        + (v ? ` (zdaj ${fmtTime(v)}; desni klik pobriše)` : '');
    }
  }
  const vol = $(`#${prefix}-vol`);
  vol.disabled = !item || item.type === 'image' || !editable;
  vol.title = item && !editable ? lockNote : 'Jakost tega vnosa';
  if (!vol.dragging) vol.value = item ? item.volumeDb || 0 : 0;
  $(`#${prefix}-vol-val`).textContent = item && item.type !== 'image' ? fmtDb(Number(vol.value)) : '';
  const mute = $(`#${prefix}-mute`);
  mute.disabled = !item || item.type === 'image' || !editable;
  mute.classList.toggle('muted', !!(item && item.muted));
  mute.textContent = item && item.muted ? '🔇' : '🔊';
  mute.title = item && !editable ? lockNote : item && item.muted ? 'Vnos je utišan: klikni za vklop zvoka' : 'Utišaj ta vnos';
  // Predvajaj / ustavi in koraki
  const isVideo = !!(item && item.type !== 'image');
  const which = prefix === 'pgm' ? 'program' : 'preview';
  const play = $(`#${which}-play`);
  const running = which === 'program' ? !!(item && !item.paused) : !!(item && item.playing);
  play.disabled = !item || (which === 'preview' && !isVideo);
  play.textContent = running ? '❚❚' : '▶';
  play.classList.toggle('on', running);
  play.title = running ? 'Ustavi (pavza)' : 'Predvajaj';
  for (const b of document.querySelectorAll(`.tbtn[data-which=${which}]`)) b.disabled = !canSeek;
  if (prefix === 'pvw') renderFitPanel(item);
}

/** Plošča za prileganje slike v preview. */
function renderFitPanel(item) {
  const btn = $('#btn-fit');
  const ok = !!(item && item.type !== 'audio' && item.src);
  btn.disabled = !ok;
  btn.title = item && !item.src ? 'Posnetek iz Medijev: za nastavitve ga dodaj v playlisto' : 'Prileganje slike';
  const changed = ok && (item.fit && item.fit !== 'fit' || item.zoom !== 1 || item.posX || item.posY
    || ['opacity', 'brightness', 'contrast', 'saturation'].some((k) => item[k] !== undefined && item[k] !== 1));
  btn.classList.toggle('on', !!changed);
  renderLayersPanel(item);
  const panel = $('#fit-panel');
  if (!ok) panel.classList.add('hidden');
  if (!ok || panel.classList.contains('hidden')) return;
  if (document.activeElement !== $('#fit-mode')) $('#fit-mode').value = item.fit || 'fit';
  for (const [id, v] of [['#fit-zoom', Math.round((item.zoom || 1) * 100)], ['#fit-x', item.posX || 0], ['#fit-y', item.posY || 0]]) {
    if (!$(id).dragging) $(id).value = v;
  }
  $('#fit-zoom-val').textContent = `${$('#fit-zoom').value} %`;
  for (const k of ['opacity', 'brightness', 'contrast', 'saturation']) {
    const inp = $(`#col-${k}`);
    if (!inp.dragging) inp.value = Math.round((item[k] === undefined ? 1 : item[k]) * 100);
  }
  const known = item.width && item.height;
  $('#fit-note').textContent = (known ? `Velikost: ${item.width}×${item.height}. ` : 'Velikosti ni bilo mogoče prebrati, povečava in premik ne delujeta. ')
    + 'Spremembe vidiš v preview; na programu veljajo ob naslednjem predvajanju.';
}

// ---------- plasti ----------

let selectedLayerId = null;
const BLEND_LABEL = {
  normal: 'Normalno', multiply: 'Multiply (množi)', screen: 'Screen (zaslon)', overlay: 'Overlay (prekrivanje)',
  darken: 'Darken (temnejše)', lighten: 'Lighten (svetlejše)', add: 'Add (seštej)', subtract: 'Subtract (odštej)',
  difference: 'Difference (razlika)', soft_light: 'Soft light', hard_light: 'Hard light', color_dodge: 'Color dodge',
  color_burn: 'Color burn', exclusion: 'Exclusion', luminosity: 'Luminosity', color: 'Color',
};
for (const [k, v] of Object.entries(BLEND_LABEL)) $('#ly-blend').add(new Option(v, k));

function renderLayersPanel(item) {
  const btn = $('#btn-layers');
  const ok = !!(item && item.src);
  btn.disabled = !ok;
  const layers = (ok && item.layers) || [];
  btn.textContent = layers.length ? `▤ Plasti (${layers.length})` : '▤ Plasti';
  btn.classList.toggle('on', layers.length > 0);
  btn.title = item && !item.src ? 'Posnetek iz Medijev: za plasti ga dodaj v playlisto' : 'Plasti: več medijev hkrati (logo, slika, video) nad tem posnetkom';
  const panel = $('#layers-panel');
  if (!ok) panel.classList.add('hidden');
  if (!ok || panel.classList.contains('hidden')) return;
  const libById = new Map(state.library.map((m) => [m.id, m]));
  const ul = $('#layer-list');
  ul.innerHTML = '';
  if (!layers.some((l) => l.id === selectedLayerId)) selectedLayerId = layers.length ? layers[layers.length - 1].id : null;
  for (const l of [...layers].reverse()) {
    const m = libById.get(l.mediaId);
    const li = el('li', (l.id === selectedLayerId ? 'sel' : '') + (l.hidden ? ' off' : ''));
    li.append(el('span', `type ${m ? m.type : ''}`, m ? TYPE_LABEL[m.type] : '?'), el('span', 'name', m ? m.name : '(manjka)'));
    const mk = (txt, title, fn) => {
      const b = el('button', '', txt);
      b.type = 'button';
      b.title = title;
      b.onclick = (ev) => { ev.stopPropagation(); fn(); };
      return b;
    };
    li.append(
      mk(l.hidden ? '◌' : '👁', l.hidden ? 'Prikaži plast' : 'Skrij plast (velja takoj, tudi na programu)', () => layerSet(l.id, { hidden: !l.hidden })),
      mk('▲', 'Višje (bolj spredaj)', () => run('layers.move', { which: 'preview', layerId: l.id, dir: 1 })),
      mk('▼', 'Nižje', () => run('layers.move', { which: 'preview', layerId: l.id, dir: -1 })),
      mk('✕', 'Odstrani plast', () => run('layers.remove', { which: 'preview', layerId: l.id })),
    );
    li.onclick = () => { selectedLayerId = l.id; renderLayersPanel(state.preview); };
    ul.append(li);
  }
  const base = el('li', 'base');
  base.append(el('span', 'name', `Osnova: ${item.name}`));
  ul.append(base);
  // izbira medija za novo plast
  const sel = $('#layer-add-media');
  if (document.activeElement !== sel) {
    const cur = sel.value;
    sel.innerHTML = '';
    for (const m of sortItems(state.library.filter((x) => x.type !== 'audio'))) sel.add(new Option(m.rel || m.name, m.id));
    if (cur) sel.value = cur;
  }
  const l = layers.find((x) => x.id === selectedLayerId);
  $('#layer-edit').classList.toggle('hidden', !l);
  if (!l) return;
  const m = libById.get(l.mediaId);
  const vals = { scale: Math.round(l.scale * 100), posX: l.posX, posY: l.posY, opacity: Math.round(l.opacity * 100),
    brightness: Math.round(l.brightness * 100), contrast: Math.round(l.contrast * 100), saturation: Math.round(l.saturation * 100) };
  for (const [k, v] of Object.entries(vals)) if (!$(`#ly-${k}`).dragging) $(`#ly-${k}`).value = v;
  $('#ly-scale-val').textContent = `${$('#ly-scale').value} %`;
  if (document.activeElement !== $('#ly-blend')) $('#ly-blend').value = l.blend;
  $('#ly-video-opts').classList.toggle('hidden', !m || m.type !== 'video');
  $('#ly-loop').checked = l.loop;
  $('#ly-muted').checked = l.muted;
}

const layerSet = (layerId, patch) => run('layers.set', { which: 'preview', layerId, patch });
$('#btn-layers').onclick = () => {
  $('#layers-panel').classList.toggle('hidden');
  render();
};
$('#btn-layer-add').onclick = () => {
  const id = $('#layer-add-media').value;
  if (id) run('layers.add', { which: 'preview', mediaId: id }).then((lid) => { if (lid) selectedLayerId = lid; });
};
for (const [k, div] of [['scale', 100], ['posX', 1], ['posY', 1], ['opacity', 100], ['brightness', 100], ['contrast', 100], ['saturation', 100]]) {
  liveSlider($(`#ly-${k}`), (v) => { if (selectedLayerId) layerSet(selectedLayerId, { [k]: v / div }); },
    k === 'scale' ? () => { $('#ly-scale-val').textContent = `${$('#ly-scale').value} %`; } : undefined);
}
$('#ly-blend').onchange = (e) => { if (selectedLayerId) layerSet(selectedLayerId, { blend: e.target.value }); };
$('#ly-loop').onchange = (e) => { if (selectedLayerId) layerSet(selectedLayerId, { loop: e.target.checked }); };
$('#ly-muted').onchange = (e) => { if (selectedLayerId) layerSet(selectedLayerId, { muted: e.target.checked }); };
$('#ly-reset').onclick = () => { if (selectedLayerId) layerSet(selectedLayerId, { reset: true, resetColor: true }); };
for (const k of ['opacity', 'brightness', 'contrast', 'saturation']) {
  liveSlider($(`#col-${k}`), (v) => fitPatch({ [k]: v / 100 }));
}
$('#col-reset').onclick = () => fitPatch({ resetColor: true });

// Medij, povlečen na preview, postane plast
const pvwMon = $('#mon-pvw');
pvwMon.addEventListener('dragover', (ev) => {
  if (!(drag && drag.kind === 'media') || !(state && state.preview && state.preview.src)) return;
  ev.preventDefault();
  pvwMon.classList.add('layerdrop');
});
pvwMon.addEventListener('dragleave', () => pvwMon.classList.remove('layerdrop'));
pvwMon.addEventListener('drop', (ev) => {
  pvwMon.classList.remove('layerdrop');
  if (!(drag && drag.kind === 'media')) return;
  ev.preventDefault();
  const id = drag.id;
  drag = null;
  run('layers.add', { which: 'preview', mediaId: id }).then((lid) => {
    if (lid) {
      selectedLayerId = lid;
      $('#layers-panel').classList.remove('hidden');
      render();
    }
  });
});

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
  $('#master-val').textContent = s.masterMuted ? 'utišano' : fmtDb(Number(mv.value));
  const mm = $('#master-mute');
  mm.classList.toggle('muted', !!s.masterMuted);
  mm.textContent = s.masterMuted ? '🔇' : '🔊';
  mm.title = s.masterMuted ? 'Glavni izhod je utišan: klikni za vklop' : 'Utišaj glavni izhod';
  $('#mode-preview').checked = previewMode();
  for (const r of document.querySelectorAll('input[name=direct]')) r.checked = r.value === s.directTake;
}

function render() {
  if (!state) return;
  renderEngine();
  renderProject();
  renderLibrary();
  renderPlaylist();
  renderPanic();
  renderMonitors();
  fillTakeControls();
  if (typeof renderActions === 'function') renderActions();
  if (state.lastError && state.lastError !== render.lastError) showError(state.lastError);
  render.lastError = state.lastError;
}

// ---------- projekti ----------

function renderProject() {
  const p = state.project;
  if (!p) return;
  $('#project-name').textContent = p.name;
  // Opozorilo, ko naprava za akcije ni povezana
  const down = ((state.actions && state.actions.devices) || []).filter((d) => d.host && !d.connected);
  const w = $('#dev-warn');
  w.classList.toggle('hidden', !down.length);
  if (down.length) {
    w.textContent = `⚠ ${down.length === 1 ? `${down[0].name} ni povezan` : `${down.length} naprave niso povezane`}`;
    w.title = `Ni povezave: ${down.map((d) => `${d.name} (${d.host})`).join(', ')}. Klikni za Akcije.`;
  }
  if ($('#dlg-project').open) fillProjectDialog();
}

function fillProjectDialog() {
  const p = state.project;
  const ul = $('#project-list');
  ul.innerHTML = '';
  for (const pr of p.list) {
    const li = el('li', pr.id === p.id ? 'current' : '');
    li.append(el('span', 'name', pr.name));
    if (pr.id === p.id) li.append(el('span', 'badge info', 'odprt'));
    else {
      const open = el('button', 'btn small', 'Odpri');
      open.type = 'button';
      open.onclick = () => {
        if (state.program && !state.panic && !confirm(`Na programu je "${state.program.name}". Ob preklopu projekta se program in preview počistita. Nadaljujem?`)) return;
        run('project.switch', { id: pr.id });
      };
      const del = el('button', 'btn ghost small', '✕');
      del.type = 'button';
      del.title = 'Izbriši projekt (mediji v mapi ostanejo)';
      del.onclick = () => {
        if (confirm(`Izbrišem projekt "${pr.name}"? Playlista in nastavitve se izbrišejo, datoteke v medijski mapi ostanejo.`)) run('project.remove', { id: pr.id });
      };
      li.append(open, del);
    }
    ul.append(li);
  }
  if (document.activeElement !== $('#project-rename')) $('#project-rename').value = p.name;
  $('#project-dir').textContent = p.mediaDir || 'ni izbrana';
  for (const id of ['#btn-project-dir', '#btn-project-export', '#btn-project-import']) $(id).disabled = !isDesktop;
}

$('#btn-project').onclick = () => {
  fillProjectDialog();
  $('#dlg-project').showModal();
};
$('#dev-warn').onclick = () => $('#btn-actions').click();
$('#btn-project-new').onclick = async () => {
  const name = $('#new-project-name').value.trim();
  if (!name) {
    showError('Vpiši ime novega projekta.');
    return;
  }
  if (state.program && !state.panic && !confirm(`Na programu je "${state.program.name}". Ob preklopu projekta se program in preview počistita. Nadaljujem?`)) return;
  const id = await run('project.create', { name });
  $('#new-project-name').value = '';
  if (id && isDesktop) run('project.pickFolder');
};
$('#project-rename').onchange = (e) => run('project.rename', { id: state.project.id, name: e.target.value });
$('#btn-project-dir').onclick = () => run('project.pickFolder');
$('#btn-project-export').onclick = async () => {
  const f = await run('project.export');
  if (f) showError(`Projekt izvožen: ${f}`);
};
$('#btn-project-import').onclick = async () => {
  if (state.program && !state.panic && !confirm(`Na programu je "${state.program.name}". Ob uvozu se program in preview počistita. Nadaljujem?`)) return;
  const r = await run('project.import');
  if (r && r.missing) showError(`Projekt uvožen. Manjka ${r.missing} datotek (označene rdeče).`);
};
for (const id of ['#new-project-name', '#project-rename']) $(id).addEventListener('keydown', (ev) => ev.stopPropagation());

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
  const items = libOrder.map((id) => state.library.find((x) => x.id === id)).filter(Boolean);
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
    if (item) run('media.volume', { which, db });
  }, () => { $(`#${prefix}-vol-val`).textContent = fmtDb(Number(vol.value)); });
}
liveSlider($('#fit-zoom'), (v) => fitPatch({ zoom: v / 100 }), () => { $('#fit-zoom-val').textContent = `${$('#fit-zoom').value} %`; });
liveSlider($('#fit-x'), (v) => fitPatch({ posX: v }));
liveSlider($('#fit-y'), (v) => fitPatch({ posY: v }));
liveSlider($('#master-vol'), (db) => settingsPatch({ masterVolumeDb: db }),
  () => { $('#master-val').textContent = fmtDb(Number($('#master-vol').value)); });

$('#btn-cut').onclick = () => run('take.cut');

// Predvajaj / ustavi, koraki po sličici ali sekundi
const clipFpsFor = (which) => {
  const t = times[which === 'program' ? 1 : 2];
  return (t && t.fps) || channelFps();
};
function stepBy(which, spec) {
  const sign = spec.startsWith('-') ? -1 : 1;
  const delta = spec.endsWith('f') ? 1 / clipFpsFor(which) : 1;
  run('step', { which, delta: sign * delta });
}
for (const b of document.querySelectorAll('.tbtn[data-step]')) b.onclick = () => stepBy(b.dataset.which, b.dataset.step);
$('#preview-play').onclick = () => run('playPause', { which: 'preview' });
$('#program-play').onclick = () => run('playPause', { which: 'program' });
for (const [prefix, which] of [['pvw', 'preview'], ['pgm', 'program']]) {
  $(`#${prefix}-mute`).onclick = () => {
    const item = state && state[which];
    if (item) run('media.mute', { which, muted: !item.muted });
  };
}
$('#master-mute').onclick = () => settingsPatch({ masterMuted: !(state && state.settings.masterMuted) });

// Prileganje
$('#btn-fit').onclick = () => {
  $('#fit-panel').classList.toggle('hidden');
  render();
};
const fitPatch = (patch) => {
  const item = state && state.preview;
  if (item) run('media.transform', { which: 'preview', patch });
};
$('#fit-mode').onchange = (e) => fitPatch({ fit: e.target.value });
$('#fit-reset').onclick = () => fitPatch({ reset: true });
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
  run('library.pickFiles', { folder: currentFolder });
};

// Filter, razvrščanje, nova mapa
for (const b of document.querySelectorAll('#lib-filter button')) {
  b.onclick = () => {
    libFilter = b.dataset.f;
    lsSet('libFilter', libFilter);
    renderLibrary();
  };
}
$('#lib-sort').onchange = (e) => {
  libSort = e.target.value;
  lsSet('libSort', libSort);
  renderLibrary();
};
$('#btn-new-folder').onclick = () => {
  newFolderOpen = true;
  if (currentFolder) foldedFolders.delete(currentFolder);
  renderLibrary();
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
  } else if (ev.code === 'Comma' || ev.code === 'Period') {
    // , in . = sličica nazaj/naprej v preview (s Shift: sekunda)
    ev.preventDefault();
    stepBy('preview', `${ev.code === 'Comma' ? '-' : '+'}1${ev.shiftKey ? 's' : 'f'}`);
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
  const row = ev.target && ev.target.closest && ev.target.closest('li.folder[data-rel]');
  const folder = row ? row.dataset.rel : currentFolder;
  if (paths.length) run('library.addPaths', { paths, folder });
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
  if (s.program && s.program.now) clockSkew = s.program.now - Date.now();
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

// Odštevanje za slike na programu (motor zanje ne pošilja časa).
setInterval(() => {
  if (state && state.program && state.program.type === 'image') renderTimes();
}, 250);
