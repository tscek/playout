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
  assert.match(cfg, /<device-name>OpenAL Soft on Zvočniki \(Realtek\)<\/device-name>/);
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

test('motor: neveljavna zvočna naprava -> ponovni zagon s privzeto', async () => {
  process.env.MOCK_AUDIO_DEVICES = 'OpenAL Soft on Speakers (Focusrite USB Audio)|OpenAL Soft on BenQ (NVIDIA)';
  const { ctl, engine } = makeController();
  try {
    ctl.settings.audioDevice = 'Ne obstaja';
    await ctl.init();
    await waitFor(() => engine.safeMode && engine.status === 'running', 10000);
    const cfg = fs.readFileSync(engine.configPath, 'utf8');
    assert.ok(!cfg.includes('<device-name>'));
    const st = ctl.getState();
    assert.ok(st.audioDevices.includes('Speakers (Focusrite USB Audio)'));
    assert.match(st.audioWarning, /Ne obstaja/);
  } finally {
    delete process.env.MOCK_AUDIO_DEVICES;
    await engine.stop();
  }
});

test('veljavna zvočna naprava dobi predpono OpenAL in ostane izbrana', async () => {
  process.env.MOCK_AUDIO_DEVICES = 'OpenAL Soft on Speakers (Focusrite USB Audio)';
  const { ctl, engine } = makeController();
  try {
    ctl.settings.audioDevice = 'Speakers (Focusrite USB Audio)';
    ctl.settings.audioDelayFrames = 2;
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(engine.safeMode, false);
    const cfg = fs.readFileSync(engine.configPath, 'utf8');
    assert.match(cfg, /<device-name>OpenAL Soft on Speakers \(Focusrite USB Audio\)<\/device-name>/);
    assert.match(cfg, /<delay>2<\/delay>/);
  } finally {
    delete process.env.MOCK_AUDIO_DEVICES;
    await engine.stop();
  }
});

test('samodejni izhod izbere zunanji zaslon', async () => {
  const { ctl, engine } = makeController();
  try {
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    assert.strictEqual(ctl.resolvedOutput(), '\\\\.\\DISPLAY3');
    const cfg = fs.readFileSync(engine.configPath, 'utf8');
    assert.match(cfg, /<borderless>true<\/borderless>/);
  } finally {
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

test('preview/program: nalaganje, CUT iz ozadja, AUTO s prehodom, naslednji v preview', async () => {
  const { ctl, engine, sent, dir } = makeController();
  try {
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.png');
    fs.writeFileSync(a, 'x');
    fs.writeFileSync(b, 'x');
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    ctl.addFiles([a, b]);
    const [ia, ib] = ctl.library.items;

    await ctl.loadPreview(ia.id);
    assert.ok(sent.some((c) => c.startsWith('LOAD 2-10 "') && c.endsWith('a.mp4"')));
    assert.ok(sent.some((c) => c.startsWith('LOADBG 1-10 "') && c.endsWith('a.mp4"')));

    sent.length = 0;
    await ctl.take('cut');
    assert.strictEqual(sent[0], 'PLAY 1-10'); // takojšen preklop iz ozadja
    assert.strictEqual(ctl.program.item.id, ia.id);
    assert.strictEqual(ctl.preview.item.id, ib.id); // samodejno naslednji

    sent.length = 0;
    await ctl.updateSettings({ transitionType: 'WIPE', transitionFrames: 20, transitionDirection: 'RIGHT' });
    await ctl.take('auto');
    assert.match(sent[0], /^PLAY 1-10 ".*b\.png" WIPE 20 LINEAR RIGHT$/);
    assert.strictEqual(ctl.preview.item, null); // zadnji v seznamu

    sent.length = 0;
    await ctl.playDirect(ia.id, 'auto');
    assert.match(sent[0], /^PLAY 1-10 ".*a\.mp4" WIPE 20 LINEAR RIGHT$/);

    sent.length = 0;
    await ctl.clearProgram(true);
    assert.strictEqual(sent[0], 'PLAY 1-10 EMPTY MIX 20 LINEAR');
  } finally {
    await engine.stop();
  }
});

test('OSC: razčlenitev sporočila s časom posnetka', () => {
  const { parsePacket } = require('../main/engine/osc');
  const pad = (s) => { const b = Buffer.from(s + '\0'); return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]); };
  const msg = Buffer.concat([pad('/channel/1/stage/layer/10/foreground/file/time'), pad(',ff'), Buffer.alloc(8)]);
  msg.writeFloatBE(1.5, msg.length - 8);
  msg.writeFloatBE(30, msg.length - 4);
  const bundle = Buffer.concat([pad('#bundle'), Buffer.alloc(8), Buffer.alloc(4), msg]);
  bundle.writeInt32BE(msg.length, 16);
  const out = parsePacket(bundle);
  assert.strictEqual(out[0].address, '/channel/1/stage/layer/10/foreground/file/time');
  assert.deepStrictEqual(out[0].args, [1.5, 30]);
});

test('playlist: naslednji v skupini, ponavljanje, prehod v naslednjo skupino', () => {
  const { Playlist } = require('../main/playlist');
  const pl = new Playlist(null);
  assert.strictEqual(pl.groups.length, 1);
  const g1 = pl.groups[0];
  const [e1, e2] = pl.addMedia(g1.id, ['m1', 'm2']);
  const g2 = pl.addGroup('B');
  const [e3] = pl.addMedia(g2.id, ['m3']);
  assert.strictEqual(pl.nextAfter(e1.id).entry.id, e2.id);
  assert.strictEqual(pl.nextAfter(e2.id).entry.id, e3.id);
  pl.setGroup(g1.id, { loop: true });
  assert.strictEqual(pl.nextAfter(e2.id).entry.id, e1.id);
  assert.strictEqual(pl.nextAfter(e3.id), null);
  pl.moveEntry(e3.id, g1.id, 0);
  assert.deepStrictEqual(g1.items.map((e) => e.mediaId), ['m3', 'm1', 'm2']);
  pl.removeMedia('m1');
  assert.deepStrictEqual(g1.items.map((e) => e.mediaId), ['m3', 'm2']);
});

test('playlist: samodejno nadaljevanje (video z AUTO, zaznava prek OSC, slika po času) in panika', async () => {
  const { ctl, engine, sent, dir } = makeController();
  try {
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    const c = path.join(dir, 'c.png');
    for (const f of [a, b, c]) fs.writeFileSync(f, 'x');
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    ctl.addFiles([a, b, c]);
    const [ia, ib, ic] = ctl.library.items;
    const g = ctl.playlist.groups[0];
    await ctl.addToGroup(g.id, [ia.id, ib.id, ic.id, ia.id]);
    await ctl.setGroup(g.id, { autoFollow: true, imageSeconds: 1 });
    await ctl.updateSettings({ autoNext: false }); // skupina s samodejnim nadaljevanjem vseeno pripravi naslednjega

    await ctl.cueGroup(g.id);
    assert.strictEqual(ctl.preview.src.entryId, g.items[0].id);
    sent.length = 0;
    await ctl.take('cut');
    assert.strictEqual(sent[0], 'PLAY 1-10');
    assert.strictEqual(ctl.preview.item.id, ib.id);
    assert.ok(sent.some((x) => /^LOADBG 1-10 ".*b\.mp4" MIX 12 LINEAR AUTO$/.test(x)), sent.join('\n'));
    assert.strictEqual(ctl.getState().preview.autoFollow, 'end');

    // Motor sam preklopi na b.mp4 -> OSC sporoči novo pot.
    sent.length = 0;
    ctl._onOsc({ address: '/channel/1/stage/layer/10/foreground/file/path', args: [a.replace(/\\/g, '/')] });
    assert.strictEqual(ctl.program.item.id, ia.id);
    ctl._onOsc({ address: '/channel/1/stage/layer/10/foreground/file/path', args: [b.replace(/\\/g, '/').toUpperCase()] });
    assert.strictEqual(ctl.program.item.id, ib.id);
    await waitFor(() => ctl.preview.item && ctl.preview.item.id === ic.id);
    // Za videom pride slika: tudi ta gre v ozadje z AUTO.
    await waitFor(() => sent.some((x) => /^LOADBG 1-10 ".*c\.png" MIX 12 LINEAR AUTO$/.test(x)));

    ctl._onOsc({ address: '/channel/1/stage/layer/10/foreground/file/path', args: [c] });
    assert.strictEqual(ctl.program.item.id, ic.id);
    await waitFor(() => ctl.preview.item && ctl.preview.item.id === ia.id && ctl.getState().preview.autoFollow === 'timer');
    // Slika: po 1 s gre naslednji sam s prehodom.
    sent.length = 0;
    await waitFor(() => ctl.program.item.id === ia.id && ctl.program.src.entryId === g.items[3].id, 3000);
    assert.match(sent[0], /^PLAY 1-10 ".*a\.mp4" MIX 12 LINEAR$/);
    // Konec skupine brez ponavljanja: nič več v preview.
    await waitFor(() => ctl.preview.item === null);

    sent.length = 0;
    await ctl.setPanic(true);
    assert.deepStrictEqual(sent.slice(0, 3), ['PLAY 1-990 #FF000000', 'MIXER 1 MASTERVOLUME 0', 'CLEAR 1-991']);
    sent.length = 0;
    await ctl.updateSettings({ panicSource: ic.id });
    assert.match(sent[0], /^PLAY 1-990 #FF000000$/);
    assert.ok(sent.some((x) => /^PLAY 1-991 ".*c\.png"$/.test(x)));
    sent.length = 0;
    await ctl.setPanic(false);
    assert.deepStrictEqual(sent, ['CLEAR 1-991', 'CLEAR 1-990', 'MIXER 1 MASTERVOLUME 1.0000']);
  } finally {
    await engine.stop();
  }
});

test('zvok, premik po posnetku in samodejno naprej s CUT', async () => {
  const { dbToGain } = require('../main/controller');
  assert.strictEqual(dbToGain(-40), 0);
  assert.ok(Math.abs(dbToGain(-6) - 0.501) < 0.01);
  const { ctl, engine, sent, dir } = makeController();
  try {
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    for (const f of [a, b]) fs.writeFileSync(f, 'x');
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    ctl.addFiles([a, b]);
    const [ia, ib] = ctl.library.items;
    const g = ctl.playlist.groups[0];
    await ctl.addToGroup(g.id, [ia.id, ib.id]);
    await ctl.setGroup(g.id, { autoFollow: true, followCut: true });

    await ctl.setItemVolume(ia.id, -6);
    await ctl.cueGroup(g.id);
    sent.length = 0;
    await ctl.seek('preview', 4); // začetna točka 4 s = 200 sličic pri 50p
    assert.ok(sent.some((x) => /^LOADBG 1-10 ".*a\.mp4" SEEK 200 IN 0$/.test(x)), sent.join('\n'));
    sent.length = 0;
    await ctl.take('cut');
    assert.strictEqual(sent[0], 'PLAY 1-10');
    assert.strictEqual(sent[1], 'MIXER 1-10 VOLUME 0.5012');
    assert.ok(Date.now() - ctl.program.startedAt >= 3900);
    await waitFor(() => ctl.getState().preview && ctl.getState().preview.autoFollow === 'end');
    assert.ok(sent.some((x) => /^LOADBG 1-10 ".*b\.mp4" AUTO$/.test(x)), sent.join('\n')); // CUT: brez prehoda

    sent.length = 0;
    await ctl.seek('program', 10);
    assert.strictEqual(sent[0], 'CALL 1-10 SEEK 500');
    await ctl.setItemVolume(ia.id, 0);
    assert.strictEqual(sent[1], 'MIXER 1-10 VOLUME 1.0000');
    await ctl.updateSettings({ masterVolumeDb: -40 });
    assert.strictEqual(sent[2], 'MIXER 1 MASTERVOLUME 0.0000');
  } finally {
    await engine.stop();
  }
});
