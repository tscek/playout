'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../main/engine/engine');
const { Controller, fpsOf } = require('../main/controller');
const { buildConfig } = require('../main/engine/caspar-config');
const { quote } = require('../main/engine/amcp');

const MOCK_DIR = path.join(__dirname, '..', 'dev', 'mock-caspar');
let portBase = 15300 + Math.floor(Math.random() * 500);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'playout-test-'));
}

function waitFor(fn, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timeout'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function makeController() {
  const dir = tmpDir();
  const engine = new Engine({ casparDir: MOCK_DIR, workDir: path.join(dir, 'engine'), amcpPort: portBase++ });
  const sent = [];
  engine.on('log', (l) => {
    const m = /> (.*)$/.exec(l);
    if (m) sent.push(m[1]);
  });
  const display = { index: 2, device: '\\\\.\\DISPLAY3', adapter: 'Intel', monitor: 'ATEM', active: true, primary: false,
    x: 1920, y: 0, width: 1920, height: 1080, hz: 50 };
  const ctl = new Controller({ engine, dataDir: dir, listDisplays: async () => [display] });
  const media = path.join(dir, 'clip one.mp4');
  fs.writeFileSync(media, 'x');
  return { ctl, engine, sent, dir, media };
}

test('fps iz video načina', () => {
  assert.strictEqual(fpsOf('1080p5000'), 50);
  assert.strictEqual(fpsOf('1080i5000'), 25);
  assert.strictEqual(fpsOf('1080p2997'), 29.97);
});

test('AMCP narekovaji', () => {
  assert.strictEqual(quote('C:/a "b".mp4'), '"C:/a \\"b\\".mp4"');
});

test('konfiguracija: zaslon in zvočna naprava', () => {
  const cfg = buildConfig({
    videoMode: '1080p5000',
    screens: [{ display: { index: 2, width: 1920, height: 1080 } }],
    audioDevice: 'Zvočniki (Realtek)',
    paths: { media: 'C:\\m', log: 'C:\\l', data: 'C:\\d', template: 'C:\\t', htmlCache: 'C:\\h' },
    amcpPort: 5255,
  });
  assert.match(cfg, /<device>3<\/device>/);
  assert.match(cfg, /<borderless>true<\/borderless>/);
  assert.match(cfg, /<device-name>Zvočniki \(Realtek\)<\/device-name>/);
  assert.match(cfg, /<media-path>C:\/m\/<\/media-path>/);
  assert.match(cfg, /<port>5255<\/port>/);
});

test('motor: zagon, predvajanje, sesutje in obnova programa', async () => {
  const { ctl, engine, sent, media } = makeController();
  try {
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    assert.strictEqual(engine.version, '2.5.1 mock');

    ctl.addFiles([media, '/tmp/neznano.xyz']);
    assert.strictEqual(ctl.library.items.length, 1);
    const id = ctl.library.items[0].id;
    await ctl.play(id);
    assert.ok(sent.some((c) => c.startsWith('PLAY 1-10 "') && c.includes('clip one.mp4')));

    // Motor se sesuje -> samodejni ponovni zagon in ponovni PLAY s SEEK.
    sent.length = 0;
    await new Promise((r) => setTimeout(r, 300));
    engine.send('CRASH').catch(() => {});
    await waitFor(() => engine.restarts === 1 && engine.status === 'running', 10000);
    await waitFor(() => sent.some((c) => c.startsWith('PLAY 1-10')), 3000);
    assert.ok(sent.find((c) => c.startsWith('PLAY 1-10')).includes(' SEEK '));

    await ctl.clearProgram();
    assert.ok(sent.includes('CLEAR 1-10'));
  } finally {
    await engine.stop();
  }
});

test('motor: neveljavna zvočna naprava -> varni način', async () => {
  process.env.MOCK_CRASH_ON_DEVICE = '1';
  const { ctl, engine } = makeController();
  try {
    ctl.settings.audioDevice = 'Ne obstaja';
    await ctl.init();
    await waitFor(() => engine.status === 'running', 10000);
    assert.strictEqual(engine.safeMode, true);
    const cfg = fs.readFileSync(engine.configPath, 'utf8');
    assert.ok(!cfg.includes('<device-name>'));
  } finally {
    delete process.env.MOCK_CRASH_ON_DEVICE;
    await engine.stop();
  }
});

test('nastavitve: izbran zaslon gre v konfiguracijo', async () => {
  const { ctl, engine } = makeController();
  try {
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    await ctl.updateSettings({ programOutput: '\\\\.\\DISPLAY3' });
    await waitFor(() => engine.status === 'running');
    const cfg = fs.readFileSync(engine.configPath, 'utf8');
    assert.match(cfg, /<device>3<\/device>/);
    assert.match(cfg, /<always-on-top>true<\/always-on-top>/);
  } finally {
    await engine.stop();
  }
});
