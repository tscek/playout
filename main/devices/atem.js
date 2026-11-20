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
    this.atem = null;
    this.connected = false;
    try {
      await a.disconnect();
      await a.destroy();
    } catch { /* ni pomembno */ }
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
      default:
        throw new Error(`Neznan ATEM ukaz: ${step.cmd}`);
    }
  }
}

module.exports = { AtemDevice };
