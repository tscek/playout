'use strict';
/* global state, run, el, $, render */
// Akcije: gumbi za ročni zagon in urejanje naprav ter akcij.

const ATEM_CMDS = {
  autoTo: 'AUTO na vhod',
  cutTo: 'CUT na vhod',
  preview: 'Vhod v preview',
  auto: 'AUTO (kar je v preview)',
  cut: 'CUT (kar je v preview)',
  aux: 'AUX izhod na vhod',
  macro: 'Zaženi makro',
  ftb: 'Fade to black',
};
const XR_CMDS = {
  mute: 'Utišaj (mute)',
  unmute: 'Vklopi (unmute)',
  fader: 'Fader na vrednost',
  mutegroup: 'Mute skupina vklopi',
  unmutegroup: 'Mute skupina izklopi',
};
const XR_TARGETS = { ch: 'Kanal', bus: 'Bus (aux izhod)', lr: 'Glavni LR', dca: 'DCA', rtn: 'FX povratek', aux: 'Aux vhod' };
const STEP_LABEL = { preset: 'Preset', atem: 'ATEM', xr18: 'XR18', http: 'HTTP', osc: 'OSC', wait: 'Počakaj', title: 'Napis' };
const presetList = () => (state && state.actions && state.actions.presets) || [];
function presetName(pid) {
  const p = presetList().find((x) => x.id === pid);
  return p ? `${p.group}: ${p.label}` : '(preset ni na voljo)';
}
/** Ime akcije: pri akciji iz preseta sledi imenu v napravi. */
function actionName(a) {
  if (a.autoName && a.steps.length === 1 && a.steps[0].type === 'preset') {
    const p = presetList().find((x) => x.id === a.steps[0].target);
    if (p) return p.label;
  }
  return a.name;
}
/** Izbira preseta: skupine po napravah in vrstah. */
function presetSelect(value, onchange) {
  const s = el('select', 'mini-select');
  s.add(new Option('(izberi preset)', ''));
  let og = null;
  let last = '';
  for (const p of presetList()) {
    const g = `${p.group} · ${p.kind}`;
    if (g !== last) {
      og = document.createElement('optgroup');
      og.label = g;
      s.append(og);
      last = g;
    }
    og.append(new Option(p.label, p.id));
  }
  if (value && !presetList().some((p) => p.id === value)) s.add(new Option('(preset ni na voljo)', value));
  s.value = value || '';
  s.onchange = () => onchange(s.value);
  return s;
}
const TITLE_CMDS = { on: 'Vklopi', off: 'Umakni', toggle: 'Vklopi / umakni', allOff: 'Vsi napisi dol' };
const titleItems = () => (state && state.titles ? state.titles.items : []);

const actState = () => (state && state.actions) || { devices: [], actions: [] };

// ---------- gumbi ----------

function renderActionBar() {
  const bar = $('#action-bar');
  const acts = actState().actions.filter((a) => a.showButton);
  bar.classList.toggle('hidden', !acts.length);
  bar.innerHTML = '';
  for (const a of acts) {
    const b = el('button', 'btn act-btn', actionName(a));
    if (a.running) b.classList.add('running');
    if (a.last && !a.last.ok) {
      b.classList.add('failed');
      b.title = `Zadnjič ni uspelo: ${a.last.error}`;
    } else b.title = a.steps.map(stepSummary).join('\n');
    b.onclick = () => run('actions.run', { id: a.id });
    bar.append(b);
  }
}

function deviceName(id) {
  const d = actState().devices.find((x) => x.id === id);
  return d ? d.name : '?';
}

function stepSummary(s) {
  switch (s.type) {
    case 'atem': return `ATEM ${deviceName(s.deviceId)}: ${ATEM_CMDS[s.cmd] || s.cmd}${s.input ? ` ${s.input}` : ''}`;
    case 'xr18': return `XR18 ${deviceName(s.deviceId)}: ${XR_CMDS[s.cmd] || s.cmd}`;
    case 'http': return `HTTP ${s.method || 'GET'} ${s.url || ''}`;
    case 'osc': return `OSC ${s.host || ''}:${s.port || ''} ${s.address || ''}`;
    case 'wait': return `Počakaj ${s.ms || 0} ms`;
    case 'preset': return presetName(s.target);
    case 'title': {
      const t = titleItems().find((x) => x.id === s.target);
      return s.cmd === 'allOff' ? 'Napisi: vsi dol' : `Napis ${TITLE_CMDS[s.cmd] || ''}: ${t ? t.label : '(ni v tem projektu)'}`;
    }
    default: return s.type;
  }
}

// ---------- urejanje ----------

function editingInDialog() {
  const a = document.activeElement;
  return a && a.closest && a.closest('#dlg-actions') && ['text', 'number', 'url'].includes(a.type);
}

function input(type, value, onchange, attrs = {}) {
  const i = el('input');
  i.type = type;
  i.value = value === undefined || value === null ? '' : value;
  Object.assign(i, attrs);
  i.onchange = () => onchange(type === 'number' ? (i.value === '' ? '' : Number(i.value)) : i.value);
  i.onkeydown = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      i.blur();
    }
  };
  i.onblur = () => setTimeout(renderActionsDialog, 0);
  return i;
}

function select(options, value, onchange) {
  const s = el('select', 'mini-select');
  for (const [k, v] of options) s.add(new Option(v, k));
  if (value !== undefined && value !== null && ![...s.options].some((o) => o.value === String(value))) s.add(new Option(`${value}`, value));
  s.value = value === undefined || value === null ? '' : String(value);
  s.onchange = () => onchange(s.value);
  return s;
}

function field(label, control) {
  const l = el('label', 'act-field');
  l.append(el('span', '', label), control);
  return l;
}

function renderDevices() {
  const box = $('#dev-list');
  box.innerHTML = '';
  const devs = actState().devices;
  if (!devs.length) box.append(el('div', 'group-empty', 'Ni naprav. Dodaj ATEM ali mešalno mizo.'));
  for (const d of devs) {
    const row = el('div', 'dev-row');
    const dot = el('span', 'dot' + (d.connected ? ' ok' : ''));
    dot.title = d.connected ? 'Povezan' : 'Ni povezave';
    const save = (patch) => run('actions.saveDevice', { device: { id: d.id, type: d.type, name: d.name, host: d.host, ...patch } });
    row.append(dot, el('span', 'type', d.type === 'atem' ? 'ATEM' : 'XR18'),
      field('Ime', input('text', d.name, (v) => save({ name: v }))),
      field('IP naslov', input('text', d.host, (v) => save({ host: v }), { placeholder: '192.168.10.240' })),
      el('span', 'dev-status', d.connected ? `povezan${d.model ? ' · ' + d.model : ''}` : d.host ? 'ni povezave' : 'vpiši IP'));
    const x = el('button', 'item-btn', '✕');
    x.type = 'button';
    x.title = 'Odstrani napravo';
    x.onclick = () => {
      if (confirm(`Odstranim napravo "${d.name}"?`)) run('actions.removeDevice', { id: d.id });
    };
    row.append(x);
    box.append(row);
  }
}

function stepEditor(a, si) {
  const s = a.steps[si];
  const devs = actState().devices;
  const saveStep = (patch) => {
    const steps = a.steps.map((x, i) => (i === si ? { ...x, ...patch } : x));
    run('actions.save', { action: { ...a, steps } });
  };
  const row = el('div', 'step-row');
  row.append(el('span', 'num', `${si + 1}.`));
  row.append(select(Object.entries(STEP_LABEL), s.type, (v) => {
    const first = devs.find((d) => d.type === v);
    const base = { type: v };
    if (first) base.deviceId = first.id;
    if (v === 'atem') Object.assign(base, { cmd: 'autoTo', input: 1 });
    if (v === 'xr18') Object.assign(base, { cmd: 'mute', target: 'ch', num: 1 });
    if (v === 'http') Object.assign(base, { method: 'GET', url: 'http://' });
    if (v === 'osc') Object.assign(base, { host: '', port: 8000, address: '/', args: '' });
    if (v === 'wait') Object.assign(base, { ms: 500 });
    if (v === 'preset') Object.assign(base, { target: (presetList()[0] || {}).id || '' });
    if (v === 'title') Object.assign(base, { cmd: 'on', target: (titleItems()[0] || {}).id || '' });
    const steps = a.steps.map((x, i) => (i === si ? base : x));
    run('actions.save', { action: { ...a, steps } });
  }));

  if (s.type === 'atem' || s.type === 'xr18') {
    const own = devs.filter((d) => d.type === s.type);
    if (!own.length) row.append(el('span', 'bad-text', `Najprej zgoraj dodaj napravo ${STEP_LABEL[s.type]}.`));
    else row.append(field('Naprava', select(own.map((d) => [d.id, d.name]), s.deviceId, (v) => saveStep({ deviceId: v }))));
  }
  if (s.type === 'atem') {
    const dev = devs.find((d) => d.id === s.deviceId) || {};
    row.append(field('Ukaz', select(Object.entries(ATEM_CMDS), s.cmd, (v) => saveStep({ cmd: v }))));
    if (['autoTo', 'cutTo', 'preview', 'aux'].includes(s.cmd)) {
      const inputs = dev.inputs && dev.inputs.length ? dev.inputs.map((i) => [String(i.id), `${i.name} (${i.id})`]) : null;
      row.append(field('Vhod', inputs
        ? select(inputs, s.input, (v) => saveStep({ input: Number(v) }))
        : input('number', s.input, (v) => saveStep({ input: v }), { min: 0, title: 'Številka vhoda (ko je ATEM povezan, izbereš s seznama)' })));
    }
    if (s.cmd === 'aux') {
      const n = dev.aux || 0;
      row.append(field('AUX', n > 1
        ? select(Array.from({ length: n }, (_, i) => [String(i + 1), `AUX ${i + 1}`]), s.aux || 1, (v) => saveStep({ aux: Number(v) }))
        : input('number', s.aux || 1, (v) => saveStep({ aux: v }), { min: 1, max: 24 })));
    }
    if (s.cmd === 'macro') {
      const ms = dev.macros && dev.macros.length ? dev.macros.map((m) => [String(m.index), `${m.index + 1}. ${m.name}`]) : null;
      row.append(field('Makro', ms
        ? select(ms, s.macro || 0, (v) => saveStep({ macro: Number(v) }))
        : input('number', (s.macro || 0) + 1, (v) => saveStep({ macro: Math.max(0, Number(v) - 1) }), { min: 1 })));
    }
    if ((dev.mes || 1) > 1) row.append(field('M/E', input('number', s.me || 1, (v) => saveStep({ me: v }), { min: 1, max: dev.mes })));
  }
  if (s.type === 'xr18') {
    row.append(field('Ukaz', select(Object.entries(XR_CMDS), s.cmd, (v) => saveStep({ cmd: v }))));
    if (['mutegroup', 'unmutegroup'].includes(s.cmd)) {
      row.append(field('Skupina', select([1, 2, 3, 4].map((n) => [String(n), `Mute ${n}`]), s.group || 1, (v) => saveStep({ group: Number(v) }))));
    } else {
      row.append(field('Kaj', select(Object.entries(XR_TARGETS), s.target || 'ch', (v) => saveStep({ target: v }))));
      if (!['lr', 'aux'].includes(s.target)) {
        const max = { ch: 16, bus: 6, dca: 4, rtn: 4 }[s.target || 'ch'];
        row.append(field('Številka', input('number', s.num || 1, (v) => saveStep({ num: v }), { min: 1, max })));
      }
      if (s.cmd === 'fader') row.append(field('dB', input('number', s.db === undefined ? 0 : s.db, (v) => saveStep({ db: v }), { min: -90, max: 10, step: 0.5, title: '-90 = popolnoma dol, 0 = enota, +10 = največ' })));
    }
  }
  if (s.type === 'http') {
    row.append(field('Metoda', select([['GET', 'GET'], ['POST', 'POST'], ['PUT', 'PUT']], s.method || 'GET', (v) => saveStep({ method: v }))));
    const u = input('text', s.url, (v) => saveStep({ url: v }), { placeholder: 'http://192.168.10.50/api/...' });
    u.className = 'wide-input';
    row.append(field('URL', u));
    if ((s.method || 'GET') !== 'GET') row.append(field('Vsebina', input('text', s.body, (v) => saveStep({ body: v }))));
  }
  if (s.type === 'osc') {
    row.append(field('IP', input('text', s.host, (v) => saveStep({ host: v }), { placeholder: '192.168.10.50' })),
      field('Vrata', input('number', s.port, (v) => saveStep({ port: v }), { min: 1, max: 65535 })),
      field('Naslov', input('text', s.address, (v) => saveStep({ address: v }), { placeholder: '/pot/ukaz' })),
      field('Argumenti', input('text', s.args, (v) => saveStep({ args: v }), { placeholder: 'npr. 1 0.5 besedilo' })));
  }
  if (s.type === 'preset') {
    if (!presetList().length) row.append(el('span', 'bad-text', 'Ni presetov: najprej zgoraj dodaj ATEM ali XR18.'));
    else row.append(field('Preset', presetSelect(s.target, (v) => saveStep({ target: v }))));
  }
  if (s.type === 'title') {
    row.append(field('Ukaz', select(Object.entries(TITLE_CMDS), s.cmd || 'on', (v) => saveStep({ cmd: v }))));
    if (s.cmd !== 'allOff') {
      const opts = titleItems().map((t) => [t.id, t.label]);
      if (!opts.length) row.append(el('span', 'bad-text', 'V tem projektu ni napisov (zavihek Napisi).'));
      else {
        if (!opts.some((o) => o[0] === s.target)) opts.unshift([s.target || '', '(izberi napis)']);
        row.append(field('Napis', select(opts, s.target || '', (v) => saveStep({ target: v }))));
      }
    }
  }
  if (s.type === 'wait') row.append(field('Milisekund', input('number', s.ms || 0, (v) => saveStep({ ms: v }), { min: 0, max: 60000, step: 100 })));

  const ctl = el('span', 'step-ctl');
  const mk = (txt, title, fn, dis) => {
    const b = el('button', 'item-btn', txt);
    b.type = 'button';
    b.title = title;
    b.disabled = !!dis;
    b.onclick = fn;
    return b;
  };
  const move = (to) => {
    const steps = [...a.steps];
    const [x] = steps.splice(si, 1);
    steps.splice(to, 0, x);
    run('actions.save', { action: { ...a, steps } });
  };
  ctl.append(mk('▲', 'Gor', () => move(si - 1), si === 0), mk('▼', 'Dol', () => move(si + 1), si === a.steps.length - 1),
    mk('✕', 'Odstrani korak', () => run('actions.save', { action: { ...a, steps: a.steps.filter((_, i) => i !== si) } })));
  row.append(ctl);
  return row;
}

function renderActionList() {
  const box = $('#act-list');
  box.innerHTML = '';
  const acts = actState().actions;
  if (!acts.length) box.append(el('div', 'group-empty', 'Ni akcij. Primer: "Nazaj na kamero 1" = ATEM, AUTO na vhod 1.'));
  acts.forEach((a, ai) => {
    const card = el('div', 'act-card');
    const head = el('div', 'act-head');
    const name = input('text', actionName(a), (v) => run('actions.save', { action: { ...a, name: v, autoName: false } }));
    if (a.autoName) name.title = 'Ime sledi imenu v napravi. Če ga spremeniš, ostane tvoje.';
    name.className = 'group-name';
    const btnL = el('label', 'group-opt');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = a.showButton;
    cb.onchange = () => run('actions.save', { action: { ...a, showButton: cb.checked } });
    btnL.append(cb, document.createTextNode('gumb zgoraj'));
    const test = el('button', 'btn small', '▶ Preizkusi');
    test.type = 'button';
    test.onclick = () => run('actions.run', { id: a.id });
    const status = el('span', 'dev-status', a.running ? 'teče …' : a.last ? (a.last.ok ? 'uspelo' : `napaka: ${a.last.error}`) : '');
    if (a.last && !a.last.ok) status.classList.add('bad-text');
    const up = el('button', 'item-btn', '▲');
    up.type = 'button';
    up.disabled = ai === 0;
    up.onclick = () => run('actions.move', { id: a.id, index: ai - 1 });
    const del = el('button', 'item-btn', '✕');
    del.type = 'button';
    del.title = 'Izbriši akcijo';
    del.onclick = () => {
      if (confirm(`Izbrišem akcijo "${a.name}"?`)) run('actions.remove', { id: a.id });
    };
    head.append(name, btnL, test, status, up, del);
    card.append(head);
    a.steps.forEach((_, si) => card.append(stepEditor(a, si)));
    const add = el('button', 'btn ghost small', '+ korak');
    add.type = 'button';
    add.onclick = () => {
      const atem = actState().devices.find((d) => d.type === 'atem');
      const step = atem ? { type: 'atem', deviceId: atem.id, cmd: 'autoTo', input: 1 } : { type: 'wait', ms: 500 };
      run('actions.save', { action: { ...a, steps: [...a.steps, step] } });
    };
    card.append(add);
    box.append(card);
  });
}

// ---------- preseti ----------

const openPresetGroups = new Set();
function renderPresets() {
  const box = $('#preset-list');
  box.innerHTML = '';
  const list = presetList();
  if (!list.length) {
    box.append(el('div', 'group-empty', 'Preseti nastanejo sami, ko dodaš ATEM ali XR18 (imena vhodov in kanalov preberem iz naprave).'));
    return;
  }
  const groups = new Map();
  for (const p of list) {
    const g = `${p.group} · ${p.kind}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  for (const [g, items] of groups) {
    const det = el('details', 'preset-group');
    det.open = openPresetGroups.has(g);
    det.ontoggle = () => (det.open ? openPresetGroups.add(g) : openPresetGroups.delete(g));
    det.append(el('summary', '', `${g} (${items.length})`));
    const grid = el('div', 'preset-grid');
    for (const p of items) {
      const row = el('div', 'preset-row');
      const go = el('button', `btn small${p.running ? ' running' : ''}`, '▶');
      go.type = 'button';
      go.title = 'Izvedi zdaj';
      go.onclick = () => run('actions.run', { id: `preset:${p.id}` });
      const pin = el('button', 'item-btn', '＋');
      pin.type = 'button';
      pin.title = 'Naredi akcijo z gumbom zgoraj (ime sledi imenu v napravi)';
      pin.onclick = () => run('actions.save', { action: { name: p.label, autoName: true, showButton: true, steps: [{ type: 'preset', target: p.id }] } });
      const lab = el('span', 'preset-label', p.label);
      if (p.last && !p.last.ok) {
        lab.classList.add('bad-text');
        lab.title = p.last.error;
      }
      row.append(go, lab, pin);
      grid.append(row);
    }
    det.append(grid);
    box.append(det);
  }
}

function renderActionsDialog() {
  if (!$('#dlg-actions').open || editingInDialog()) return;
  renderDevices();
  renderPresets();
  renderActionList();
}

function renderActions() {
  renderActionBar();
  renderActionsDialog();
}

$('#btn-actions').onclick = () => {
  $('#dlg-actions').showModal();
  renderActionsDialog();
};
$('#btn-add-atem').onclick = () => run('actions.saveDevice', { device: { type: 'atem', name: 'ATEM', host: '' } });
$('#btn-add-xr18').onclick = () => run('actions.saveDevice', { device: { type: 'xr18', name: 'XR18', host: '' } });
$('#btn-add-action').onclick = () => {
  const atem = actState().devices.find((d) => d.type === 'atem');
  const steps = atem ? [{ type: 'atem', deviceId: atem.id, cmd: 'autoTo', input: 1 }] : [];
  run('actions.save', { action: { name: `Akcija ${actState().actions.length + 1}`, showButton: true, steps } });
};
