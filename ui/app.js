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

    const del = document.createElement('button');
    del.className = 'item-btn';
    del.textContent = '✕';
    del.title = 'Odstrani s seznama (datoteka ostane na disku)';
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
  if (item.loop) return [`zanka · ${fmtTime(t.elapsed)} / ${fmtTime(t.total)}`, ''];
  const left = t.total - t.elapsed;
  const cls = left <= 0.5 ? 'time-end' : left <= 10 ? 'time-warn' : '';
  return [`−${fmtTime(Math.ceil(left))}  (${fmtTime(t.total)})`, cls];
}

function renderMonitors() {
  const pvw = state.preview;
  const pgm = state.program;
  $('.monitors').classList.toggle('nopvw', !previewMode());
  $('#pvw-name').textContent = pvw ? pvw.name : '—';
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

function renderTimes() {
  if (!state) return;
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
  $('#mode-preview').checked = previewMode();
  for (const r of document.querySelectorAll('input[name=direct]')) r.checked = r.value === s.directTake;
}

function render() {
  if (!state) return;
  renderEngine();
  renderLibrary();
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
    run('program.direct', { id });
  }
}

function stepPreview(dir) {
  const items = state ? state.library : [];
  if (!items.length) return;
  const cur = previewMode() ? state.preview && state.preview.id : selectedId;
  let i = items.findIndex((x) => x.id === cur);
  i = i === -1 ? (dir > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + dir));
  if (previewMode()) {
    run('preview.load', { id: items[i].id });
  } else {
    selectedId = items[i].id;
    render();
  }
}

const settingsPatch = (patch) => run('settings.update', patch);

$('#btn-cut').onclick = () => run('take.cut');
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

document.addEventListener('keydown', (ev) => {
  if (document.querySelector('dialog[open]')) return;
  const tag = (ev.target && ev.target.tagName) || '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (ev.key === 'Enter') {
    ev.preventDefault();
    if (previewMode()) run('take.cut');
    else if (selectedId) run('program.direct', { id: selectedId, kind: 'cut' });
  } else if (ev.key === ' ') {
    ev.preventDefault();
    if (previewMode()) run('take.auto');
    else if (selectedId) run('program.direct', { id: selectedId, kind: 'auto' });
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
