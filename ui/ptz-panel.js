'use strict';
// Plošča PTZ (prek USB kontrolerja ESP32): izbira kamere s tally, joystick na zaslonu, zoom, preseti, STOP, zaklep.
// Uporabljata jo okno aplikacije in tablica.
/* exported PtzPanel */

const PtzPanel = (() => {
  const panels = new Map(); // id naprave -> { root, sig, refs, dev }
  const lastLive = new Map();

  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const shape = (v) => Math.sign(v) * Math.abs(v) ** 1.6; // fino upravljanje pri majhnem odmiku

  /** Vlečna ploščica: onMove(x, y) v -1..1 (y navzgor pozitiven), ob spustu 0, 0. */
  function pad(cls, axes, onMove) {
    const box = mk('div', `pz-pad ${cls}`);
    const knob = mk('div', 'pz-knob');
    box.append(knob);
    let active = null;
    let timer = null;
    let cur = [0, 0];
    const place = (x, y) => {
      knob.style.left = `${50 + x * 50}%`;
      knob.style.top = `${50 - y * 50}%`;
    };
    const send = () => onMove(shape(cur[0]), shape(cur[1]));
    const end = () => {
      if (active === null) return;
      active = null;
      clearInterval(timer);
      timer = null;
      cur = [0, 0];
      place(0, 0);
      box.classList.remove('on');
      onMove(0, 0);
    };
    const at = (ev) => {
      const r = box.getBoundingClientRect();
      let x = axes.includes('x') ? ((ev.clientX - r.left) / r.width) * 2 - 1 : 0;
      let y = axes.includes('y') ? 1 - ((ev.clientY - r.top) / r.height) * 2 : 0;
      x = Math.max(-1, Math.min(1, x));
      y = Math.max(-1, Math.min(1, y));
      if (Math.abs(x) < 0.06) x = 0;
      if (Math.abs(y) < 0.06) y = 0;
      cur = [x, y];
      place(x, y);
    };
    box.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      active = ev.pointerId;
      box.setPointerCapture(ev.pointerId);
      box.classList.add('on');
      at(ev);
      send();
      timer = setInterval(send, 100); // kontroler ustavi kamero, če 0,4 s ni ukaza
    });
    box.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== active) return;
      at(ev);
    });
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    box.addEventListener('lostpointercapture', end);
    place(0, 0);
    return box;
  }

  function sigOf(d) {
    return JSON.stringify([d.name, d.host, d.connected, d.model, d.port, d.error, d.cams, d.presets]);
  }

  function build(d, api) {
    const root = mk('div', 'pz');
    const head = mk('div', 'pz-head');
    head.append(mk('b', '', d.name), mk('span', 'pz-model ' + (d.connected ? 'ok' : 'bad'),
      d.connected ? `${d.port || ''}${d.model ? ' · ' + d.model : ''}` : 'ni povezave'));
    root.append(head);
    const refs = { cams: new Map(), presets: null };
    if (!d.connected) {
      root.append(mk('div', 'pz-empty', `${d.error || 'Kontroler ni povezan.'} Preveri USB kabel do ESP32. Povezava se obnovi sama.`));
      return { root, refs };
    }
    const cams = (d.cams || []).filter((c) => c.enabled !== false);
    const camRow = mk('div', 'pz-cams');
    for (const c of cams) {
      const b = mk('button', 'pz-cam', c.name || `Kamera ${c.i}`);
      b.type = 'button';
      b.onclick = () => api.run({ cmd: 'select', cam: c.i });
      refs.cams.set(c.i, b);
      camRow.append(b);
    }
    root.append(camRow);
    refs.warn = mk('div', 'pz-warn hidden');
    root.append(refs.warn);

    const ctl = mk('div', 'pz-ctl');
    const move = (p, t, z) => api.move(refs.sel, p, t, z);
    let pt = [0, 0];
    let zm = 0;
    const joy = pad('joy', 'xy', (x, y) => { pt = [x, y]; move(pt[0], pt[1], zm); });
    const zoom = pad('zoom', 'y', (x, y) => { zm = y; move(pt[0], pt[1], zm); });
    const zl = mk('div', 'pz-zoomwrap');
    zl.append(mk('span', 'pz-zl', 'TELE'), zoom, mk('span', 'pz-zl', 'WIDE'));
    const side = mk('div', 'pz-side');
    const stop = mk('button', 'pz-stop', 'STOP');
    stop.type = 'button';
    stop.title = 'Ustavi vse kamere';
    stop.onclick = () => api.run({ cmd: 'stop' });
    refs.lock = mk('button', 'pz-lock', 'Zakleni');
    refs.lock.type = 'button';
    refs.lock.title = 'Zaklep: kamere se ne premikajo (tudi iPad in fizični joystick ne)';
    refs.lock.onclick = () => api.run({ cmd: refs.locked ? 'unlock' : 'lock' });
    side.append(stop, refs.lock);
    ctl.append(joy, zl, side);
    root.append(ctl);

    refs.presets = mk('div', 'pz-presets');
    root.append(refs.presets);

    const store = mk('details', 'pz-store');
    store.append(mk('summary', '', 'Shrani trenutni položaj kot preset'));
    const f = mk('div', 'pz-storef');
    const n = mk('input');
    n.type = 'number';
    n.min = 1;
    n.max = 50;
    n.placeholder = 'št.';
    const nm = mk('input');
    nm.type = 'text';
    nm.maxLength = 19;
    nm.placeholder = 'ime (npr. Govornik)';
    const ok = mk('button', 'pz-save', 'Shrani');
    ok.type = 'button';
    ok.onclick = () => {
      const num = parseInt(n.value, 10);
      if (!(num >= 1 && num <= 50)) {
        n.focus();
        return;
      }
      api.run({ cmd: 'store', cam: refs.sel, num, name: nm.value.trim() });
      n.value = '';
      nm.value = '';
      store.open = false;
    };
    f.append(n, nm, ok);
    store.append(f, mk('small', 'pz-hint', 'Preset se shrani v kontroler (isti kot na iPadu). Obstoječo številko prepiše.'));
    root.append(store);
    return { root, refs, d, api };
  }

  function renderPresets(p) {
    const { refs, d, api } = p;
    if (!refs.presets) return;
    const key = `${refs.sel}`;
    if (refs.presetsKey === key) return;
    refs.presetsKey = key;
    refs.presets.innerHTML = '';
    const cam = (d.cams || []).find((c) => c.i === refs.sel);
    const list = ((d.presets || {})[refs.sel] || []).filter((x) => x.stored);
    if (!cam) {
      refs.presets.append(mk('div', 'pz-empty', 'Izberi kamero zgoraj.'));
      return;
    }
    if (!list.length) {
      refs.presets.append(mk('div', 'pz-empty', `${cam.name}: ni shranjenih presetov.`));
      return;
    }
    for (const x of list) {
      const b = mk('button', 'pz-pre');
      b.type = 'button';
      b.append(mk('span', 'pz-n', String(x.n)), mk('span', 'pz-pn', x.name || `Preset ${x.n}`));
      b.onclick = () => api.run({ cmd: 'recall', cam: refs.sel, num: x.n });
      refs.presets.append(b);
    }
  }

  function update(p, live) {
    if (!p || !p.d || !live) return;
    const { refs } = p;
    refs.sel = live.sel;
    refs.locked = live.lock;
    for (const [i, b] of refs.cams) {
      const c = (live.cams || []).find((x) => x.i === i) || {};
      b.classList.toggle('sel', i === live.sel);
      b.classList.toggle('pgm', !!c.pgm);
      b.classList.toggle('pvw', !!c.pvw && !c.pgm);
      b.classList.toggle('off', !c.connected);
      b.classList.toggle('moving', !!c.moving);
      b.title = c.status || '';
    }
    refs.lock.classList.toggle('on', live.lock);
    refs.lock.textContent = live.lock ? 'Zaklenjeno' : 'Zakleni';
    const selCam = (live.cams || []).find((x) => x.i === live.sel);
    const warn = live.lock ? 'Zaklep je vklopljen: kamere se ne premikajo.'
      : live.override ? 'V uporabi je fizični joystick.'
        : live.moveError ? `Kamera se ne premakne: ${live.moveError}.`
          : selCam && selCam.pgm ? 'Izbrana kamera je na programu.' : '';
    refs.warn.textContent = warn;
    refs.warn.classList.toggle('hidden', !warn);
    renderPresets(p);
  }

  /** api: { run(deviceId, step), move(deviceId, cam, pan, tilt, zoom) } */
  function render(container, devices, api) {
    const list = (devices || []).filter((d) => d.type === 'ptz');
    const keep = new Set(list.map((d) => d.id));
    for (const id of [...panels.keys()]) {
      if (!keep.has(id)) {
        panels.get(id).root.remove();
        panels.delete(id);
      }
    }
    let empty = container.querySelector(':scope > .pz-none');
    if (!list.length) {
      if (!empty) {
        empty = mk('div', 'pz-none', 'Ni dodanega PTZ kontrolerja. Dodaš ga v oknu Akcije (gumb "+ PTZ kontroler (USB)").');
        container.append(empty);
      }
      return;
    }
    if (empty) empty.remove();
    for (const d of list) {
      const sig = sigOf(d);
      let p = panels.get(d.id);
      if (!p || p.sig !== sig || !container.contains(p.root)) {
        const fresh = build(d, {
          run: (step) => api.run(d.id, step),
          move: (cam, pan, tilt, zoom) => api.move(d.id, cam, pan, tilt, zoom),
        });
        fresh.sig = sig;
        if (p && container.contains(p.root)) p.root.replaceWith(fresh.root);
        else container.append(fresh.root);
        p = fresh;
        panels.set(d.id, p);
      }
      if (!d.connected) lastLive.delete(d.id);
      update(p, lastLive.get(d.id) || d.live);
    }
  }

  function live(id, lv) {
    if (lv) lastLive.set(id, lv);
    update(panels.get(id), lv);
  }

  return { render, live };
})();
