'use strict';
// Obremenjenost računalnika: procesor, pomnilnik, grafična kartica (Windows) in motor (sličice na sekundo).

const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const GPU_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'while ($true) {',
  '  $g = (Get-Counter "\\GPU Engine(*engtype_3D)\\Utilization Percentage").CounterSamples | Measure-Object CookedValue -Sum',
  '  $m = (Get-Counter "\\GPU Adapter Memory(*)\\Dedicated Usage").CounterSamples | Measure-Object CookedValue -Sum',
  '  [Console]::Out.WriteLine("{0};{1}" -f [math]::Round($g.Sum), [math]::Round($m.Sum / 1MB))',
  '  [Console]::Out.Flush()',
  '  Start-Sleep -Seconds 1',
  '}',
].join('\n');

class SysLoad extends EventEmitter {
  constructor({ intervalMs = 2000 } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.last = null;
    this.gpu = null; // { util, memMb }
    this.timer = null;
    this.proc = null;
  }

  start() {
    this._prev = cpuTimes();
    this.timer = setInterval(() => this._tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    if (process.platform === 'win32') this._startNvidia();
  }

  stop() {
    clearInterval(this.timer);
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ni pomembno */ }
    }
    this.proc = null;
  }

  /** NVIDIA: nvidia-smi je najbolj natančen; če ga ni, uporabimo števce Windows. */
  _startNvidia() {
    try {
      const p = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits', '-l', '2'], { windowsHide: true });
      this.proc = p;
      let buf = '';
      let ok = false;
      p.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          const m = /^(\d+)\s*,\s*(\d+)/.exec(line);
          if (m) {
            ok = true;
            this.gpu = { util: Number(m[1]), memMb: Number(m[2]) };
          }
        }
      });
      p.on('error', () => { if (this.proc === p) this._startGpu(); });
      p.on('exit', () => { if (this.proc === p && !ok) this._startGpu(); });
    } catch {
      this._startGpu();
    }
  }

  _startGpu() {
    try {
      const enc = Buffer.from(GPU_SCRIPT, 'utf16le').toString('base64');
      this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true });
      let buf = '';
      this.proc.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          const m = /^(\d+);(\d+)$/.exec(line);
          if (m) this.gpu = { util: Math.min(100, Number(m[1])), memMb: Number(m[2]) };
        }
      });
      this.proc.on('error', () => { this.proc = null; });
      this.proc.on('exit', () => { this.proc = null; });
    } catch {
      this.proc = null;
    }
  }

  _tick() {
    const now = cpuTimes();
    const idle = now.idle - this._prev.idle;
    const total = now.total - this._prev.total;
    this._prev = now;
    const cpu = total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
    const totalMem = os.totalmem();
    this.last = {
      cpu,
      ramUsedGb: Math.round(((totalMem - os.freemem()) / 2 ** 30) * 10) / 10,
      ramTotalGb: Math.round((totalMem / 2 ** 30) * 10) / 10,
      gpu: this.gpu,
    };
    this.emit('update', this.last);
  }
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

module.exports = { SysLoad };
