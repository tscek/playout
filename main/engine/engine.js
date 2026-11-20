'use strict';
// Upravljanje procesa CasparCG: zagon, nadzor, samodejni ponovni zagon.
//
// Motor teče kot ločen proces. Če se sesuje, ga takoj zaženemo znova in
// obnovimo, kar je bilo na programu. Če se motor ne more zagnati z
// izbranimi nastavitvami (npr. izbrana zvočna naprava ne obstaja več),
// poskusimo še z varnimi nastavitvami, da program nikoli ne ostane prazen.

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { AmcpClient } = require('./amcp');
const { buildConfig, parseOpenAlDevices } = require('./caspar-config');

const STARTUP_TIMEOUT_MS = 45000; // prvi zagon (CEF, OpenGL) je lahko počasen
const MAX_LOG_LINES = 500;

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

class Engine extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.casparDir  mapa s casparcg.exe
   * @param {string} o.workDir    zapisljiva mapa (konfiguracija, dnevniki, pid)
   * @param {number} o.amcpPort
   */
  constructor({ casparDir, workDir, amcpPort = 5255, exeName }) {
    super();
    this.casparDir = casparDir;
    this.workDir = workDir;
    this.amcpPort = amcpPort;
    this.exeName = exeName || (process.platform === 'win32' ? 'casparcg.exe' : 'casparcg');
    this.proc = null;
    this.status = 'stopped'; // stopped | starting | running | restarting | failed | missing
    this.statusText = '';
    this.version = '';
    this.safeMode = false;
    this.restarts = 0;
    this.logLines = [];
    this.wantRunning = false;
    this.options = null;
    this._startTimer = null;
    this._expectExit = false;

    this.amcp = new AmcpClient({ port: amcpPort });
    this.amcp.on('connected', () => this._onConnected());
    this.amcp.on('disconnected', () => {
      if (this.status === 'running') this._setStatus('restarting', 'Povezava z motorjem prekinjena');
    });
    this.amcp.on('sent', (cmd) => this._log(`> ${cmd}`));
  }

  get exePath() {
    return path.join(this.casparDir, this.exeName);
  }

  get configPath() {
    return path.join(this.workDir, 'casparcg.config');
  }

  get pidPath() {
    return path.join(this.workDir, 'engine.pid');
  }

  isInstalled() {
    return fs.existsSync(this.exePath);
  }

  _setStatus(status, text = '') {
    this.status = status;
    this.statusText = text;
    this.emit('status', this.getStatus());
  }

  getStatus() {
    return {
      status: this.status,
      text: this.statusText,
      version: this.version,
      safeMode: this.safeMode,
      restarts: this.restarts,
    };
  }

  _log(line) {
    const stamp = new Date().toLocaleTimeString('sl-SI');
    const entry = `${stamp}  ${line}`;
    this.logLines.push(entry);
    if (this.logLines.length > MAX_LOG_LINES) this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
    this.emit('log', entry);
    // Dnevnik aplikacije tudi v datoteko (za diagnostiko na daljavo).
    try {
      if (!this._appLogPath) {
        const dir = path.join(this.workDir, 'logs');
        fs.mkdirSync(dir, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        this._appLogPath = path.join(dir, `playout_${day}.log`);
      }
      fs.appendFile(this._appLogPath, `${new Date().toISOString()}  ${line}\n`, () => {});
    } catch { /* ni kritično */ }
  }

  /** Zažene motor z nastavitvami (glej caspar-config.buildConfig). */
  async start(options) {
    this.options = options;
    this.wantRunning = true;
    this.safeMode = false;
    await this._launch();
  }

  /** Ponovni zagon z novimi nastavitvami (npr. drug zaslon). */
  async restart(options) {
    if (options) this.options = options;
    this.safeMode = false;
    this.quickCrashes = 0;
    await this._kill();
    if (this.wantRunning) await this._launch();
  }

  async _relaunch() {
    await this._kill();
    if (this.wantRunning) await this._launch();
  }

  async stop() {
    this.wantRunning = false;
    await this._kill();
    this._setStatus('stopped');
  }

  _writeConfig() {
    const o = this.options;
    const paths = {
      media: path.join(this.workDir, 'media'),
      log: path.join(this.workDir, 'logs'),
      data: path.join(this.workDir, 'data'),
      template: o.templateDir || path.join(this.workDir, 'templates'),
      htmlCache: path.join(this.workDir, 'html-cache'),
    };
    for (const d of Object.values(paths)) fs.mkdirSync(d, { recursive: true });

    const cfg = buildConfig({
      videoMode: o.videoMode,
      screens: o.screens,
      audioDevice: this.safeMode ? null : o.audioDevice,
      audioDelayFrames: o.audioDelayFrames || 0,
      paths,
      amcpPort: this.amcpPort,
      oscPort: o.oscPort,
    });
    fs.mkdirSync(this.workDir, { recursive: true });
    fs.writeFileSync(this.configPath, cfg, 'utf8');
  }

  _killStale() {
    // Če je ob prejšnjem zagonu ostal "osirotel" motor, ga ugasnemo.
    try {
      const pid = parseInt(fs.readFileSync(this.pidPath, 'utf8'), 10);
      if (pid > 0) {
        if (process.platform === 'win32') {
          // Preverimo, da je proces res CasparCG (številka procesa se lahko ponovno uporabi).
          let name = '';
          try {
            name = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8' });
          } catch { /* ok */ }
          if (name.toLowerCase().includes(this.exeName.toLowerCase())) {
            try {
              execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            } catch { /* proces ne obstaja več */ }
          }
        } else {
          try { process.kill(pid, 'SIGKILL'); } catch { /* ne obstaja */ }
        }
      }
    } catch { /* ni datoteke */ }
    try { fs.unlinkSync(this.pidPath); } catch { /* ok */ }
  }

  async _launch() {
    if (!this.isInstalled()) {
      this._setStatus('missing', `Motor CasparCG ni najden: ${this.exePath}`);
      return;
    }
    this._killStale();

    // Počakamo, da se vrata sprostijo (do 5 s).
    for (let i = 0; i < 25 && !(await isPortFree(this.amcpPort)); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!(await isPortFree(this.amcpPort))) {
      this._setStatus('failed', `Vrata ${this.amcpPort} so zasedena (teče drug CasparCG?)`);
      return;
    }

    this._writeConfig();
    this._setStatus(this.restarts > 0 ? 'restarting' : 'starting', this.safeMode ? 'Zagon v varnem načinu' : 'Zaganjam motor');
    this._log(`Zaganjam ${this.exePath}${this.safeMode ? ' (varni način)' : ''}`);

    const proc = spawn(this.exePath, [this.configPath], {
      cwd: this.casparDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this._expectExit = false;
    const startedAt = Date.now();

    try { fs.writeFileSync(this.pidPath, String(proc.pid)); } catch { /* ni kritično */ }

    const recent = [];
    let audioFailHandled = false;
    const onOut = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this._log(line);
        recent.push(line);
        if (recent.length > 60) recent.shift();
        // Motor se ob napačni zvočni napravi NE ustavi, samo ostane brez zvoka.
        // Zato to zaznamo sami in ga ponovno zaženemo s privzeto napravo.
        if (!audioFailHandled && /Invalid OpenAL device/i.test(line)) {
          audioFailHandled = true;
          const devices = parseOpenAlDevices(recent);
          const bad = (/Invalid OpenAL device:\s*(.*)$/i.exec(line) || [])[1] || '';
          this.emit('audioDeviceFailed', { device: bad.trim(), devices });
          if (!this.safeMode && this.wantRunning) {
            this.safeMode = true;
            this._log('Izbrane zvočne naprave ni bilo mogoče odpreti, preklapljam na privzeto napravo.');
            setTimeout(() => this._relaunch(), 200);
          }
        }
      }
    };
    proc.stdout.on('data', onOut);
    proc.stderr.on('data', onOut);
    proc.stdin.on('error', () => {});

    proc.on('error', (err) => {
      this._log(`Napaka pri zagonu motorja: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(this._startTimer);
      if (this.proc === proc) this.proc = null;
      this.amcp.stop();
      try { fs.unlinkSync(this.pidPath); } catch { /* ok */ }
      this._log(`Motor se je ustavil (koda ${code}${signal ? ', ' + signal : ''})`);
      if (this._expectExit || !this.wantRunning) return;

      this.restarts++;
      const ranFor = Date.now() - startedAt;
      // Če motor dvakrat zapored pade takoj po zagonu, so verjetno krive nastavitve -> varni način.
      this.quickCrashes = ranFor < 15000 ? (this.quickCrashes || 0) + 1 : 0;
      if (this.quickCrashes >= 2 && !this.safeMode) {
        this.safeMode = true;
        this._log('Motor se ni uspel zagnati z izbranimi nastavitvami, poskušam varni način (privzeti zvok).');
      }
      const delay = ranFor < 5000 ? 2000 : 300;
      this._setStatus('restarting', 'Motor se je ustavil, ponovni zagon …');
      setTimeout(() => {
        if (this.wantRunning && !this.proc) this._launch();
      }, delay);
    });

    this._startTimer = setTimeout(() => {
      if (this.status !== 'running') {
        this._log('Motor se ni odzval v pričakovanem času.');
        this._setStatus('failed', 'Motor se ne odziva');
      }
    }, STARTUP_TIMEOUT_MS);

    this.amcp.start();
  }

  async _onConnected() {
    clearTimeout(this._startTimer);
    try {
      const res = await this.amcp.send('VERSION');
      this.version = (res.data[0] || res.head || '').trim();
    } catch { /* ni kritično */ }
    this._setStatus('running', this.safeMode ? 'Teče v varnem načinu (privzeti zvočni izhod)' : 'Teče');
    this.emit('ready');
  }

  async _kill() {
    const proc = this.proc;
    if (!proc) return;
    this._expectExit = true;
    this.amcp.stop();
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          if (process.platform === 'win32') {
            execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } else {
            proc.kill('SIGKILL');
          }
        } catch { /* že ugasnjen */ }
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        proc.stdin.write('q\r\n'); // ukaz konzole CasparCG za zaustavitev
      } catch { /* ok */ }
    });
    this.proc = null;
  }

  send(cmd) {
    return this.amcp.send(cmd);
  }
}

module.exports = { Engine };
