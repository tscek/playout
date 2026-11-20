'use strict';
// Plošča za ATEM: vrstici PROGRAM in PREVIEW z imeni vhodov, CUT/AUTO/FTB, vrsta prehoda, ključi, AUX, makri.
// Uporabljata jo okno aplikacije in tablica. Stanje (tally) se osvežuje sproti iz mešalnika.
/* exported AtemPanel */

const AtemPanel = (() => {
  // Vhodi v vrsticah: kamere/HDMI, črna, barvne letve, barvi, media playerja.
  const SHOWN = (id) => (id >= 0 && id <= 40) || [1000, 2001, 2002, 3010, 3020].includes(id);
  const panels = new Map(); // id naprave -> { root, sig, refs }
  const lastLive = new Map(); // id naprave -> zadnje sprotno stanje (novejše od celotnega stanja)

  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function sigOf(d) {
    const lv = d.live || { me: [], dsk: [], aux: [] };
    return JSON.stringify([d.name, d.host, d.connected, d.model, d.inputs, d.aux, d.macros,
      lv.me.length, lv.me[0] ? lv.me[0].usk.length : 0, lv.dsk.length]);
  }

  function build(d, send) {
    const root = mk('div', 'ap');
    root.dataset.id = d.id;
    const head = mk('div', 'ap-head');
    head.append(mk('b', '', d.name), mk('span', 'ap-model ' + (d.connected ? 'ok' : 'bad'), d.connected ? d.model || 'povezan' : 'ni povezave'));
    root.append(head);
    const refs = { pgm: new Map(), pvw: new Map(), style: new Map(), usk: [], dsk: [], dskAuto: [], aux: [] };
    if (!d.connected) {
      root.append(mk('div', 'ap-empty', `ATEM na naslovu ${d.host || '(ni nastavljen)'} se ne odziva. Preveri, ali je vklopljen in v istem omrežju.`));
      return { root, refs };
    }
    const inputs = (d.inputs || []).filter((i) => SHOWN(i.id));
    const row = (kind, label, cmd) => {
      const r = mk('div', `ap-row ${kind}`);
      r.append(mk('span', 'ap-lbl', label));
      const btns = mk('div', 'ap-btns');
      for (const i of inputs) {
        // Dolgo ime (npr. "Kamera levo"), ker so kratka imena pogosto enaka ("KAM1" ...).
        const b = mk('button', 'ap-in', i.name || i.short);
        b.type = 'button';
        b.title = i.short && i.short !== i.name ? `${i.name} (${i.short})` : i.name;
        b.onclick = () => send({ cmd, input: i.id });
        refs[kind].set(i.id, b);
        btns.append(b);
      }
      r.append(btns);
      return r;
    };
    root.append(row('pgm', 'PROGRAM', 'cutTo'), row('pvw', 'PREVIEW', 'preview'));

    const ctl = mk('div', 'ap-ctl');
    const btn = (cls, text, step, title) => {
      const b = mk('button', cls, text);
      b.type = 'button';
      if (title) b.title = title;
      b.onclick = () => send(step);
      return b;
    };
    refs.cut = btn('ap-big cut', 'CUT', { cmd: 'cut' }, 'Preview takoj na program');
    refs.auto = btn('ap-big auto', 'AUTO', { cmd: 'auto' }, 'Preview na program s prehodom');
    refs.bar = mk('span', 'ap-bar');
    refs.auto.append(refs.bar);
    refs.ftb = btn('ap-big ftb', 'FTB', { cmd: 'ftb' }, 'Zatemnitev programa v črno (še enkrat: nazaj)');
    const seg = mk('div', 'ap-seg');
    for (const [k, t] of [['mix', 'MIX'], ['dip', 'DIP'], ['wipe', 'WIPE']]) {
      const b = btn('', t, { cmd: 'style', target: k }, 'Vrsta prehoda za AUTO');
      refs.style.set(k, b);
      seg.append(b);
    }
    ctl.append(refs.cut, refs.auto, refs.ftb, seg);
    root.append(ctl);

    const lv = d.live || { me: [], dsk: [] };
    const nUsk = lv.me[0] ? lv.me[0].usk.length : 0;
    if (nUsk || lv.dsk.length) {
      const keys = mk('div', 'ap-keys');
      for (let k = 1; k <= nUsk; k++) {
        const b = btn('ap-key', `KEY ${k}`, { cmd: 'uskToggle', num: k }, `Ključ ${k} (upstream) vklopi/izklopi`);
        refs.usk.push(b);
        keys.append(b);
      }
      for (let k = 1; k <= lv.dsk.length; k++) {
        const wrap = mk('span', 'ap-dsk');
        const b = btn('ap-key', `DSK ${k}`, { cmd: 'dskToggle', num: k }, `Ključ DSK ${k}: takoj vklopi/izklopi`);
        const a = btn('ap-key small', 'AUTO', { cmd: 'dskAuto', num: k }, `Ključ DSK ${k}: vklopi/izklopi s prehodom`);
        refs.dsk.push(b);
        refs.dskAuto.push(a);
        wrap.append(b, a);
        keys.append(wrap);
      }
      root.append(keys);
    }

    if (d.aux) {
      const aux = mk('div', 'ap-aux');
      for (let a = 1; a <= d.aux; a++) {
        const l = mk('label', 'ap-auxl');
        const s = mk('select');
        s.add(new Option('—', ''));
        for (const i of d.inputs || []) s.add(new Option(i.name, String(i.id)));
        s.onchange = () => { if (s.value !== '') send({ cmd: 'aux', aux: a, input: Number(s.value) }); };
        refs.aux.push(s);
        l.append(mk('span', '', `AUX ${a}`), s);
        aux.append(l);
      }
      root.append(aux);
    }

    if ((d.macros || []).length) {
      const det = mk('details', 'ap-macros');
      det.append(mk('summary', '', `Makri (${d.macros.length})`));
      const box = mk('div', 'ap-btns');
      for (const m of d.macros) box.append(btn('ap-in wide', m.name, { cmd: 'macro', macro: m.index }, `Zaženi makro ${m.index + 1}`));
      det.append(box);
      root.append(det);
    }
    return { root, refs };
  }

  function update(p, live) {
    if (!p || !live || !live.me || !live.me[0]) return;
    const m = live.me[0];
    const { refs } = p;
    for (const [id, b] of refs.pgm) b.classList.toggle('on', id === m.pgm);
    for (const [id, b] of refs.pvw) b.classList.toggle('on', id === m.pvw);
    if (refs.auto) {
      refs.auto.classList.toggle('run', m.inTransition);
      refs.bar.style.width = `${Math.round((m.inTransition ? m.position : 0) * 100)}%`;
    }
    if (refs.ftb) {
      refs.ftb.classList.toggle('on', m.ftb.black);
      refs.ftb.classList.toggle('blink', m.ftb.inTransition);
    }
    for (const [k, b] of refs.style) b.classList.toggle('on', k === m.style);
    refs.usk.forEach((b, i) => b.classList.toggle('on', !!(m.usk[i] && m.usk[i].onAir)));
    refs.dsk.forEach((b, i) => b.classList.toggle('on', !!(live.dsk[i] && live.dsk[i].onAir)));
    refs.dskAuto.forEach((b, i) => b.classList.toggle('run', !!(live.dsk[i] && live.dsk[i].inTransition)));
    refs.aux.forEach((s, i) => {
      if (document.activeElement === s) return;
      const v = live.aux[i];
      s.value = v === null || v === undefined ? '' : String(v);
      if (s.value !== String(v)) s.value = '';
    });
  }

  /**
   * Nariše plošče za vse ATEM naprave. send(id, step) pošlje ukaz.
   * Plošča se zgradi znova samo, ko se spremenijo vhodi ali povezava; tally se le osveži.
   */
  function render(container, devices, send) {
    const list = (devices || []).filter((d) => d.type === 'atem');
    const keep = new Set(list.map((d) => d.id));
    for (const id of [...panels.keys()]) {
      if (!keep.has(id)) {
        panels.get(id).root.remove();
        panels.delete(id);
      }
    }
    let empty = container.querySelector(':scope > .ap-none');
    if (!list.length) {
      if (!empty) {
        empty = mk('div', 'ap-none', 'Ni dodanega ATEM. Dodaš ga v oknu Akcije (gumb "+ ATEM", vpiši IP naslov).');
        container.append(empty);
      }
      return;
    }
    if (empty) empty.remove();
    for (const d of list) {
      const sig = sigOf(d);
      let p = panels.get(d.id);
      if (!p || p.sig !== sig || !container.contains(p.root)) {
        const fresh = build(d, (step) => send(d.id, step));
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

  /** Sprotna sprememba stanja mešalnika (tally, prehod). */
  function live(id, lv) {
    if (lv) lastLive.set(id, lv);
    update(panels.get(id), lv);
  }

  return { render, live };
})();
