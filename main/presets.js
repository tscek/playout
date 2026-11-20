'use strict';
// Preseti: ukazi, ki nastanejo sami iz naprav (imena vhodov ATEM, imena kanalov XR18).
// Preset si zapomni številko vhoda ali kanala, ime pa se vedno vzame iz naprave
// (zadnje znano ime je shranjeno, da preseti delujejo tudi, ko naprava ni povezana).
//
// Id preseta: <idNaprave>.<ukaz>[.<argumenti>], npr. "a1b2c3.autoTo.2", "x9.mute.ch.3", "x9.mutegroup.1".

/** ATEM vhodi, ki jih ponudimo: kamere/HDMI (1-40), črna, barvne letve, media playerji. */
function atemInputUseful(id) {
  return (id >= 0 && id <= 40) || id === 1000 || id === 3010 || id === 3020 || id === 3030 || id === 3040;
}

function atemPresets(d, cache) {
  const inputs = (cache.inputs || []).filter((i) => atemInputUseful(i.id));
  const out = [];
  const g = `ATEM ${d.name}`;
  const add = (key, label, step, kind) => out.push({ id: `${d.id}.${key}`, group: g, kind, label, step: { type: 'atem', deviceId: d.id, ...step } });
  add('cut', 'CUT', { cmd: 'cut' }, 'Prehod');
  add('auto', 'AUTO', { cmd: 'auto' }, 'Prehod');
  add('ftb', 'FTB (zatemnitev)', { cmd: 'ftb' }, 'Prehod');
  for (const i of inputs) add(`autoTo.${i.id}`, `AUTO → ${i.name}`, { cmd: 'autoTo', input: i.id }, 'AUTO na vhod');
  for (const i of inputs) add(`cutTo.${i.id}`, `CUT → ${i.name}`, { cmd: 'cutTo', input: i.id }, 'CUT na vhod');
  for (const i of inputs) add(`preview.${i.id}`, `Preview: ${i.name}`, { cmd: 'preview', input: i.id }, 'Preview');
  const nAux = Math.min(6, cache.aux || 0);
  for (let a = 1; a <= nAux; a++) {
    for (const i of inputs) add(`aux.${a}.${i.id}`, `AUX ${a} = ${i.name}`, { cmd: 'aux', aux: a, input: i.id }, `AUX ${a}`);
  }
  for (let k = 1; k <= Math.min(4, cache.dsk || 0); k++) {
    add(`dskAuto.${k}`, `DSK ${k}: AUTO (vklop/izklop s prehodom)`, { cmd: 'dskAuto', num: k }, 'Ključi');
    add(`dskOn.${k}`, `DSK ${k}: vklopi`, { cmd: 'dskOn', num: k }, 'Ključi');
    add(`dskOff.${k}`, `DSK ${k}: izklopi`, { cmd: 'dskOff', num: k }, 'Ključi');
  }
  for (let k = 1; k <= Math.min(4, cache.usk || 0); k++) {
    add(`uskOn.${k}`, `Key ${k}: vklopi`, { cmd: 'uskOn', num: k }, 'Ključi');
    add(`uskOff.${k}`, `Key ${k}: izklopi`, { cmd: 'uskOff', num: k }, 'Ključi');
  }
  for (const m of cache.macros || []) add(`macro.${m.index}`, `Makro: ${m.name}`, { cmd: 'macro', macro: m.index }, 'Makri');
  return out;
}

function xrName(cache, kind, n, fallback) {
  const nm = cache.names && cache.names[kind] && cache.names[kind][n];
  return nm ? `${nm} (${fallback})` : fallback;
}

function xrPresets(d, cache) {
  const out = [];
  const g = `XR18 ${d.name}`;
  const add = (key, label, step, kind) => out.push({ id: `${d.id}.${key}`, group: g, kind, label, step: { type: 'xr18', deviceId: d.id, ...step } });
  const pair = (target, n, label, kind) => {
    const k = n ? `${target}.${n}` : target;
    add(`mute.${k}`, `Utišaj: ${label}`, { cmd: 'mute', target, num: n || 1 }, kind);
    add(`unmute.${k}`, `Vklopi: ${label}`, { cmd: 'unmute', target, num: n || 1 }, kind);
  };
  for (let i = 1; i <= 16; i++) pair('ch', i, xrName(cache, 'ch', i, `kanal ${i}`), 'Kanali');
  for (let i = 1; i <= 6; i++) pair('bus', i, xrName(cache, 'bus', i, `bus ${i}`), 'Busi');
  pair('lr', 0, 'glavni izhod LR', 'Glavni izhod');
  for (let i = 1; i <= 4; i++) pair('dca', i, xrName(cache, 'dca', i, `DCA ${i}`), 'DCA');
  for (let i = 1; i <= 4; i++) {
    add(`mutegroup.${i}`, `Mute group ${i}: utišaj`, { cmd: 'mutegroup', group: i }, 'Mute group');
    add(`unmutegroup.${i}`, `Mute group ${i}: vklopi`, { cmd: 'unmutegroup', group: i }, 'Mute group');
  }
  return out;
}

/** Vsi preseti za seznam naprav. cacheOf(d) vrne zadnja znana imena naprave. */
function buildPresets(devices, cacheOf) {
  const out = [];
  for (const d of devices) {
    const c = cacheOf(d) || {};
    if (d.type === 'atem') out.push(...atemPresets(d, c));
    else if (d.type === 'xr18') out.push(...xrPresets(d, c));
  }
  return out;
}

/**
 * Korak iz id preseta (deluje tudi, ko naprava ni povezana ali preset ni na seznamu).
 * Vrne null, če id ni veljaven.
 */
function presetStep(pid, devices) {
  const parts = String(pid || '').split('.');
  const d = devices.find((x) => x.id === parts[0]);
  if (!d) return null;
  const [, cmd, a, b] = parts;
  const num = (v) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  if (d.type === 'atem') {
    if (['cut', 'auto', 'ftb'].includes(cmd) && a === undefined) return { type: 'atem', deviceId: d.id, cmd };
    if (['autoTo', 'cutTo', 'preview'].includes(cmd) && num(a) !== null) return { type: 'atem', deviceId: d.id, cmd, input: num(a) };
    if (cmd === 'aux' && num(a) && num(b) !== null) return { type: 'atem', deviceId: d.id, cmd, aux: num(a), input: num(b) };
    if (cmd === 'macro' && num(a) !== null) return { type: 'atem', deviceId: d.id, cmd, macro: num(a) };
    if (['dskAuto', 'dskOn', 'dskOff', 'uskOn', 'uskOff'].includes(cmd) && num(a) >= 1 && num(a) <= 4) return { type: 'atem', deviceId: d.id, cmd, num: num(a) };
    return null;
  }
  if (d.type === 'xr18') {
    if (['mute', 'unmute'].includes(cmd)) {
      if (a === 'lr' && b === undefined) return { type: 'xr18', deviceId: d.id, cmd, target: 'lr', num: 1 };
      if (['ch', 'bus', 'dca'].includes(a) && num(b)) return { type: 'xr18', deviceId: d.id, cmd, target: a, num: num(b) };
      return null;
    }
    if (['mutegroup', 'unmutegroup'].includes(cmd) && num(a) >= 1 && num(a) <= 4) return { type: 'xr18', deviceId: d.id, cmd, group: num(a) };
  }
  return null;
}

/** Zadnja znana imena iz naprave (za shranjevanje). */
function cacheFromInfo(type, info) {
  if (type === 'atem') {
    return {
      inputs: (info.inputs || []).map((i) => ({ id: i.id, name: String(i.name || i.id).slice(0, 40) })),
      aux: info.aux || 0,
      dsk: info.live ? info.live.dsk.length : 0,
      usk: info.live && info.live.me[0] ? info.live.me[0].usk.length : 0,
      macros: (info.macros || []).map((m) => ({ index: m.index, name: String(m.name).slice(0, 40) })),
    };
  }
  if (type === 'xr18') return { names: info.names || { ch: {}, bus: {}, dca: {} } };
  return {};
}

module.exports = { buildPresets, presetStep, cacheFromInfo, atemInputUseful };
