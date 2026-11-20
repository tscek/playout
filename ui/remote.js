'use strict';
// Tablica: upravljanje Playout prek omrežja (CUT, AUTO, playlista, napisi, akcije, panika) in mali monitor programa.

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const lsGet = (k, d) => {
  try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; }
};
const lsSet = (k, v) => {
  try { localStorage.setItem(k, v); } catch { /* ni pomembno */ }
};

let pin = new URLSearchParams(location.search).get('pin') || lsGet('playoutPin', '');
let state = null;
let times = { 1: null, 2: null };
let ws = null;
let nextId = 1;
const waiting = new Map();
let tab = lsGet('remoteTab', 'playlist');
let monOn = lsGet('remoteMon', '1') === '1';
let clockSkew = 0;

// ---------- povezava ----------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let opened = false;
  ws = new WebSocket(`${proto}://${location.host}/ws${pin ? `?pin=${encodeURIComponent(pin)}` : ''}`);
  ws.onopen = () => {
    opened = true;
    $('#r-conn').classList.remove('off');
    $('#pin-screen').classList.add('hidden');
    startMonitor();
  };
  ws.onclose = async () => {
    $('#r-conn').classList.add('off');
    for (const [, w] of waiting) w.reject(new Error('Povezava prekinjena'));
    waiting.clear();
    if (!opened) {
      // Je kriv PIN?
      try {
        const r = await fetch(`/api/state?pin=${encodeURIComponent(pin)}`);
        if (r.status === 401) {
          showPin(pin ? 'PIN ni pravi (ali je upravljanje s tablice izklopljeno).' : '');
          return;
        }
      } catch { /* računalnik ni dosegljiv */ }
    }
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'reply') {
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.ok) w.resolve(msg.data);
      else w.reject(new Error(msg.error));
    } else if (msg.type === 'state') {
      state = msg.state;
      if (state.program && state.program.now) clockSkew = Date.now() - state.program.now;
      render();
    } else if (msg.type === 'times') {
      times = msg.times;
      renderNow();
    }
  };
}

function call(action, args) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) {
      reject(new Error('Ni povezave z računalnikom'));
      return;
    }
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, action, args }));
  });
}

let errTimer = null;
function showError(msg) {
  const e = $('#r-error');
  e.textContent = msg;
  e.classList.remove('hidden');
  clearTimeout(errTimer);
  errTimer = setTimeout(() => e.classList.add('hidden'), 4000);
}

async function run(action, args) {
  try {
    return await call(action, args);
  } catch (e) {
    showError(e.message);
    return undefined;
  }
}

function showPin(err) {
  $('#pin-screen').classList.remove('hidden');
  $('#pin-error').textContent = err || '';
  $('#pin-input').value = '';
  setTimeout(() => $('#pin-input').focus(), 50);
}
$('#pin-ok').onclick = () => {
  pin = $('#pin-input').value.trim();
  lsSet('playoutPin', pin);
  $('#pin-screen').classList.add('hidden');
  connect();
};
$('#pin-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') $('#pin-ok').click();
});

// ---------- monitor ----------

function startMonitor() {
  const img = $('#r-pgm-img');
  $('#r-mon').classList.toggle('hidden', !monOn);
  $('#r-mon-toggle').classList.toggle('on', monOn);
  if (!monOn) {
    img.removeAttribute('src');
    return;
  }
  img.onerror = () => setTimeout(() => { if (monOn) startMonitor(); }, 2000);
  img.src = `/monitor/1.mjpg?fps=5&pin=${encodeURIComponent(pin)}&t=${Date.now()}`;
}
$('#r-mon-toggle').onclick = () => {
  monOn = !monOn;
  lsSet('remoteMon', monOn ? '1' : '0');
  startMonitor();
};

// ---------- izris ----------

const previewMode = () => !state || state.settings.previewMode !== false;

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return (h ? `${h}:` : '') + `${pad(m)}:${pad(s % 60)}`;
}

function programLeft() {
  const p = state && state.program;
  if (!p) return null;
  if (p.type === 'image') {
    if (!p.seconds || p.end === 'stop' && !p.seconds) return null;
    const ran = (p.paused ? p.pausedAt : Date.now() - clockSkew) - p.startedAt;
    return p.seconds - ran / 1000;
  }
  const t = times[1];
  if (!t || !t.total || p.loop) return null;
  return (p.outSec || t.total) - t.elapsed;
}

function renderNow() {
  if (!state) return;
  const p = state.program;
  $('#r-pgm-name').textContent = p ? p.name : '—';
  const left = programLeft();
  const tm = $('#r-pgm-time');
  tm.textContent = left === null ? (p && p.loop ? 'zanka' : '') : `−${fmtTime(Math.ceil(Math.max(0, left)))}${p && p.paused ? ' ❚❚' : ''}`;
  tm.className = `tm${left !== null && left <= 0.5 ? ' end' : left !== null && left <= 10 ? ' warn' : ''}`;
  $('#r-pvw-name').textContent = state.preview ? state.preview.name : '—';
}

function render() {
  if (!state) return;
  $('#r-project').textContent = state.project ? state.project.name : '';
  const pm = previewMode();
  $('#r-pvw-row').classList.toggle('hidden', !pm);
  $('#r-cut').disabled = !pm || !state.preview;
  $('#r-auto').disabled = !pm || !state.preview;
  $('#r-panic').classList.toggle('on', !!state.panic);
  $('#r-panic').title = state.panic ? 'Panika je vklopljena – tapni za izklop' : 'Drži za paniko';
  renderNow();
  renderPlaylist();
  renderTitles();
  renderActions();
}

function renderPlaylist() {
  const box = $('#p-playlist');
  box.innerHTML = '';
  const pgmE = state.program && state.program.src && state.program.src.entryId;
  const pvwE = state.preview && state.preview.src && state.preview.src.entryId;
  let n = 0;
  for (const g of state.playlist) {
    const gd = el('div', 'grp');
    const h = el('div', 'grp-head');
    h.append(el('span', '', g.name));
    if (previewMode() && g.items.length) {
      const b = el('button', 'small', '▶ v preview');
      b.onclick = () => run('playlist.cueGroup', { groupId: g.id });
      h.append(b);
    }
    gd.append(h);
    for (const e of g.items) {
      n++;
      const b = el('button', 'ent');
      if (e.id === pgmE) b.classList.add('pgm');
      if (e.id === pvwE) b.classList.add('pvw');
      if (e.missing) b.classList.add('missing');
      b.append(el('span', 'n', String(n)), el('span', 'ty', { video: 'VIDEO', image: 'SLIKA', audio: 'ZVOK' }[e.type] || ''), el('span', 'nm', e.name));
      b.onclick = () => {
        if (previewMode()) run('preview.load', { id: e.mediaId, entryId: e.id });
        else run('program.direct', { id: e.mediaId, kind: state.settings.directTake || 'cut', entryId: e.id });
      };
      gd.append(b);
    }
    box.append(gd);
  }
  if (!n) box.append(el('div', 'empty', 'Playlista je prazna.'));
}

function renderTitles() {
  const T = state.titles || { items: [], onAir: [] };
  const box = $('#p-titles');
  box.innerHTML = '';
  const cnt = $('#r-titles-on');
  cnt.classList.toggle('hidden', !T.onAir.length);
  cnt.textContent = String(T.onAir.length);
  if (T.onAir.length) {
    const off = el('button', 'alloff', 'Vsi napisi dol');
    off.onclick = () => run('titles.allOff');
    box.append(off);
  }
  for (const t of T.items) {
    const on = T.onAir.includes(t.id);
    const b = el('button', `ttl${on ? ' on' : ''}`);
    b.append(el('span', 'st', on ? 'NA ZASLONU' : 'VKLOPI'));
    const tx = el('span', 'nm');
    tx.append(document.createTextNode(t.label));
    const tpl = (T.templates || []).find((x) => x.id === t.template);
    if (tpl) tx.append(el('span', 'sub', tpl.name));
    b.append(tx);
    b.onclick = () => run('titles.toggle', { id: t.id });
    box.append(b);
  }
  if (!T.items.length) box.append(el('div', 'empty', 'Ni napisov. Napise pripraviš na računalniku (zavihek Napisi).'));
}

const openGroups = new Set(JSON.parse(lsGet('remoteGroups', '[]')));
function actionName(a) {
  if (a.autoName && a.steps.length === 1 && a.steps[0].type === 'preset') {
    const p = ((state.actions && state.actions.presets) || []).find((x) => x.id === a.steps[0].target);
    if (p) return p.label;
  }
  return a.name;
}
function renderActions() {
  const A = state.actions || { actions: [], presets: [] };
  const box = $('#p-actions');
  const scroll = box.scrollTop;
  box.innerHTML = '';
  const grid = el('div', 'acts');
  for (const a of A.actions) {
    const b = el('button', '', actionName(a));
    if (a.running) b.classList.add('running');
    if (a.last && a.last.ok === false) {
      b.classList.add('err');
      b.title = a.last.error || '';
    }
    b.onclick = () => run('actions.run', { id: a.id });
    grid.append(b);
  }
  box.append(grid);
  if (!A.actions.length && !(A.presets || []).length) box.append(el('div', 'empty', 'Ni akcij. Pripraviš jih na računalniku (Akcije).'));
  // Preseti iz naprav, po skupinah (odprte skupine si zapomni)
  const groups = new Map();
  for (const p of A.presets || []) {
    const g = `${p.group} · ${p.kind}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  for (const [g, items] of groups) {
    const det = el('details', 'pgrp');
    det.open = openGroups.has(g);
    det.ontoggle = () => {
      if (det.open) openGroups.add(g);
      else openGroups.delete(g);
      lsSet('remoteGroups', JSON.stringify([...openGroups]));
    };
    det.append(el('summary', '', g));
    const pg = el('div', 'acts');
    for (const p of items) {
      const b = el('button', '', p.label);
      if (p.running) b.classList.add('running');
      if (p.last && p.last.ok === false) b.classList.add('err');
      b.onclick = () => run('actions.run', { id: `preset:${p.id}` });
      pg.append(b);
    }
    det.append(pg);
    box.append(det);
  }
  box.scrollTop = scroll;
}

function setTab(t) {
  tab = ['playlist', 'titles', 'actions'].includes(t) ? t : 'playlist';
  lsSet('remoteTab', tab);
  for (const b of document.querySelectorAll('#r-tabs button')) b.classList.toggle('on', b.dataset.t === tab);
  for (const p of ['playlist', 'titles', 'actions']) $(`#p-${p}`).classList.toggle('hidden', p !== tab);
}
for (const b of document.querySelectorAll('#r-tabs button')) b.onclick = () => setTab(b.dataset.t);
setTab(tab);

// ---------- gumbi ----------

$('#r-cut').onclick = () => run('take.cut');
$('#r-auto').onclick = () => run('take.auto');
$('#r-prev').onclick = () => run('remote.command', { cmd: 'prev' });
$('#r-next').onclick = () => run('remote.command', { cmd: 'next' });
$('#r-pause').onclick = () => run('playPause', { which: 'program' });
$('#r-fade').onclick = () => run('program.clear', { fade: true });

// PANIKA: za vklop drži 0,6 s (da je ne sprožiš po nesreči), za izklop tapni.
(() => {
  const b = $('#r-panic');
  let timer = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    b.classList.remove('holding');
  };
  b.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (state && state.panic) {
      run('program.panic', { on: false });
      return;
    }
    b.classList.add('holding');
    timer = setTimeout(() => {
      cancel();
      run('program.panic', { on: true });
    }, 600);
  });
  b.addEventListener('pointerup', cancel);
  b.addEventListener('pointerleave', cancel);
  b.addEventListener('pointercancel', cancel);
  b.addEventListener('contextmenu', (ev) => ev.preventDefault());
})();

setInterval(renderNow, 500);

connect();
