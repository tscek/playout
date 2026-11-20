'use strict';
/* global playoutDesktop */

// ---------- povezava z aplikacijo ----------

const api = (() => {
  let ws = null;
  let nextId = 1;
  const waiting = new Map();
  const listeners = { state: [], log: [], open: [], close: [] };

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
        listeners[msg.type].forEach((f) => f(msg.state ?? msg.line));
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
let selectedId = null;

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
    const r = await api.call(action, args);
    return r;
  } catch (e) {
    showError(e.message);
    return undefined;
  }
}

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
  const onAirId = state.program && state.program.id;
  $('#drop-hint').classList.toggle('hidden', state.library.length > 0);

  for (const it of state.library) {
    const li = document.createElement('li');
    li.dataset.id = it.id;
    if (it.id === selectedId) li.classList.add('selected');
    if (it.id === onAirId) li.classList.add('onair');
    if (it.missing) li.classList.add('missing');
    li.title = it.missing ? `Datoteka ne obstaja: ${it.path}` : it.path;

    const type = document.createElement('span');
    type.className = `type ${it.type}`;
    type.textContent = TYPE_LABEL[it.type] || it.type;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = it.name;

    li.append(type, name);

    if (it.type !== 'image') {
      const loop = document.createElement('button');
      loop.className = 'item-btn' + (it.loop ? ' active' : '');
      loop.textContent = 'LOOP';
      loop.title = 'Ponavljaj v zanki';
      loop.onclick = (ev) => {
        ev.stopPropagation();
        run('library.loop', { id: it.id, loop: !it.loop });
      };
      li.append(loop);
    }

    const del = document.createElement('button');
    del.className = 'item-btn';
    del.textContent = '✕';
    del.title = 'Odstrani s seznama (datoteka ostane na disku)';
    del.onclick = (ev) => {
      ev.stopPropagation();
      if (it.id === onAirId) {
        showError('Posnetek je na programu. Najprej počisti program.');
        return;
      }
      run('library.remove', { id: it.id });
    };
    li.append(del);

    li.onclick = () => {
      selectedId = it.id;
      render();
    };
    li.ondblclick = () => {
      selectedId = it.id;
      take();
    };
    ul.append(li);
  }
  $('#btn-take').disabled = !selectedId || !state.library.some((x) => x.id === selectedId);
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return (h ? `${h}:` : '') + `${pad(m)}:${pad(sec)}`;
}

function renderProgram() {
  const p = state.program;
  $('.onair').classList.toggle('live', !!p);
  $('#onair-name').textContent = p ? p.name : '—';
  $('#onair-time').textContent = p ? `teče ${fmtTime(Date.now() - p.startedAt)}` : '';
}

function render() {
  if (!state) return;
  renderEngine();
  renderLibrary();
  renderProgram();
  if (state.lastError && state.lastError !== render.lastError) showError(state.lastError);
  render.lastError = state.lastError;
}

setInterval(() => state && renderProgram(), 500);

// ---------- ukazi ----------

async function take() {
  if (!selectedId) return;
  showError('');
  await run('program.play', { id: selectedId });
}

$('#btn-take').onclick = take;
$('#btn-clear').onclick = () => run('program.clear');
$('#btn-add').onclick = () => {
  if (!isDesktop) {
    showError('Medije lahko dodajaš samo na računalniku.');
    return;
  }
  run('library.pickFiles');
};

document.addEventListener('keydown', (ev) => {
  if (document.querySelector('dialog[open]')) return;
  if (ev.key === 'Enter') {
    ev.preventDefault();
    take();
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    run('program.clear');
  } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const items = state ? state.library : [];
    if (!items.length) return;
    let i = items.findIndex((x) => x.id === selectedId);
    i = ev.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
    selectedId = items[i].id;
    render();
  }
});

// Povleci in spusti datoteke.
const libPanel = $('.library');
libPanel.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  libPanel.classList.add('dragover');
});
libPanel.addEventListener('dragleave', () => libPanel.classList.remove('dragover'));
libPanel.addEventListener('drop', (ev) => {
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
  const outs = [['test', 'Testno okno (na glavnem zaslonu)']];
  for (const d of state.displays) outs.push([d.device, d.label]);
  outs.push(['none', 'Brez slike (samo zvok)']);
  fillSelect($('#set-output'), outs, s.programOutput);
  const audios = [['', 'Privzeta naprava sistema']];
  for (const a of state.audioDevices) audios.push([a, a]);
  fillSelect($('#set-audio'), audios, s.audioDevice);
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
  render();
});
api.on('log', (line) => {
  if ($('#dlg-log').open) appendLog(line);
});
api.on('open', () => $('#conn-banner').classList.add('hidden'));
api.on('close', () => $('#conn-banner').classList.remove('hidden'));
