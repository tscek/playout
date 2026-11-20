'use strict';
// Povezava z ATEM mešalnikom (knjižnica atem-connection, protokol UDP 9910).
// Povezava se po prekinitvi sama obnovi.

const { EventEmitter } = require('events');

class AtemDevice extends EventEmitter {
  constructor({ id, name, host }) {
    super();
    this.id = id;
    this.name = name;
    this.host = host;
    this.atem = null;
    this.connected = false;
    this.model = '';
  }

  start() {
    if (!this.host) return;
    // Knjižnico naložimo šele, ko je naprava dodana (vsebuje nativni modul za pisave).
    const { Atem } = require('atem-connection');
    this.atem = new Atem({ disableMultithreaded: true });
    this.atem.on('error', (e) => this.emit('log', `ATEM ${this.name}: ${e}`));
    this.atem.on('connected', () => {
      this.connected = true;
      const st = this.atem.state;
      this.model = (st && st.info && st.info.productIdentifier) || 'ATEM';
      this.emit('log', `ATEM ${this.name}: povezan (${this.model})`);
      this.emit('status');
      this.emit('names');
    });
    // Imena vhodov in makrov se lahko spremenijo v ATEM Software Control.
    this.atem.on('stateChanged', (st, paths) => {
      if (paths.some((p) => p.startsWith('inputs') || p.startsWith('macro.macroProperties'))) {
        clearTimeout(this._namesTimer);
        this._namesTimer = setTimeout(() => this.emit('names'), 300);
      }
      // Program, preview, prehod, ključi, AUX: za ploščo v vmesniku (največ ~12x na sekundo).
      if (paths.some((p) => p.startsWith('video.'))) this._liveSoon();
    });
    this.atem.on('disconnected', () => {
      this.connected = false;
      this.emit('log', `ATEM ${this.name}: povezava prekinjena`);
      this.emit('status');
    });
    this.atem.connect(this.host).catch((e) => this.emit('log', `ATEM ${this.name}: ${e.message}`));
  }

  async stop() {
    if (!this.atem) return;
    const a = this.atem;
    clearTimeout(this._liveTimer);
    this._liveTimer = null;
    this.atem = null;
    this.connected = false;
    try {
      await a.disconnect();
      await a.destroy();
    } catch { /* ni pomembno */ }
  }

  _liveSoon() {
    if (this._liveTimer) return;
    this._liveTimer = setTimeout(() => {
      this._liveTimer = null;
      this.emit('live');
    }, 80);
  }

  /** Trenutno stanje mešalnika: program, preview, prehod, FTB, ključi, AUX (za ploščo in tally). */
  live() {
    const st = this.connected && this.atem ? this.atem.state : null;
    if (!st || !st.video) return null;
    const STYLES = ['mix', 'dip', 'wipe', 'dve', 'sting'];
    const me = st.video.mixEffects.filter(Boolean).map((m) => {
      const tp = m.transitionPosition || {};
      const props = m.transitionProperties || {};
      return {
        pgm: m.programInput,
        pvw: m.previewInput,
        inTransition: !!tp.inTransition,
        position: tp.inTransition ? Math.round((tp.handlePosition || 0) / 100) / 100 : 0,
        style: STYLES[props.nextStyle] || 'mix',
        ftb: m.fadeToBlack ? { black: !!m.fadeToBlack.isFullyBlack, inTransition: !!m.fadeToBlack.inTransition } : { black: false, inTransition: false },
        usk: (m.upstreamKeyers || []).filter(Boolean).map((k) => ({ onAir: !!k.onAir })),
      };
    });
    return {
      me,
      dsk: (st.video.downstreamKeyers || []).filter(Boolean).map((k) => ({ onAir: !!k.onAir, inTransition: !!k.inTransition, tie: !!(k.properties && k.properties.tie) })),
      aux: (st.video.auxilliaries || []).map((a) => (typeof a === 'number' ? a : null)),
    };
  }

  /** Vhodi, izhodi AUX in število M/E za izbiro v vmesniku. */
  info() {
    const st = this.connected && this.atem ? this.atem.state : null;
    const inputs = [];
    if (st && st.inputs) {
      for (const inp of Object.values(st.inputs)) {
        if (inp) inputs.push({ id: inp.inputId, name: inp.longName || inp.shortName || String(inp.inputId), short: inp.shortName });
      }
    }
    return {
      connected: this.connected,
      model: this.model,
      inputs: inputs.sort((a, b) => a.id - b.id),
      aux: st && st.video ? st.video.auxilliaries.length : 0,
      mes: st && st.video ? st.video.mixEffects.length : 1,
      live: this.live(),
      macros: st && st.macro ? st.macro.macroProperties.map((m, i) => (m && m.isUsed ? { index: i, name: m.name || `Makro ${i + 1}` } : null)).filter(Boolean) : [],
    };
  }

  /**
   * Izvede ukaz. step: { cmd, input, me, aux, macro }
   * cmd: 'cut' | 'auto' | 'cutTo' | 'autoTo' | 'preview' | 'aux' | 'macro' | 'ftb'
   */
  async run(step) {
    if (!this.atem || !this.connected) throw new Error(`ATEM "${this.name}" ni povezan (preveri IP naslov in omrežje)`);
    const me = Math.max(0, (Number(step.me) || 1) - 1);
    const input = Number(step.input);
    switch (step.cmd) {
      case 'cut':
        return this.atem.cut(me);
      case 'auto':
        return this.atem.autoTransition(me);
      case 'cutTo':
        return this.atem.changeProgramInput(input, me);
      case 'autoTo':
        await this.atem.changePreviewInput(input, me);
        return this.atem.autoTransition(me);
      case 'preview':
        return this.atem.changePreviewInput(input, me);
      case 'aux':
        return this.atem.setAuxSource(input, Math.max(0, (Number(step.aux) || 1) - 1));
      case 'macro':
        return this.atem.macroRun(Math.max(0, Number(step.macro) || 0));
      case 'ftb':
        return this.atem.fadeToBlack(me);
      case 'style': {
        const s = ['mix', 'dip', 'wipe'].indexOf(step.target);
        if (s === -1) throw new Error('Neznan prehod');
        return this.atem.setTransitionStyle({ nextStyle: s }, me);
      }
      case 'dskAuto':
        return this.atem.autoDownstreamKey(this._key(step));
      case 'dskOn':
      case 'dskOff':
      case 'dskToggle': {
        const k = this._key(step);
        const cur = this.atem.state.video.downstreamKeyers[k];
        const on = step.cmd === 'dskToggle' ? !(cur && cur.onAir) : step.cmd === 'dskOn';
        return this.atem.setDownstreamKeyOnAir(on, k);
      }
      case 'uskOn':
      case 'uskOff':
      case 'uskToggle': {
        const k = this._key(step);
        const m = this.atem.state.video.mixEffects[me];
        const cur = m && m.upstreamKeyers[k];
        const on = step.cmd === 'uskToggle' ? !(cur && cur.onAir) : step.cmd === 'uskOn';
        return this.atem.setUpstreamKeyerOnAir(on, me, k);
      }
      default:
        throw new Error(`Neznan ATEM ukaz: ${step.cmd}`);
    }
  }

  /** Številka ključa (1 = prvi) v indeks. */
  _key(step) {
    return Math.max(0, (Number(step.num) || 1) - 1);
  }
}

module.exports = { AtemDevice };
