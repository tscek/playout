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
  ctl.settings.fadeSeconds = 0; // stari testi preverjajo ukaze brez fade-a
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
    await ctl.setGroup(g.id, { end: 'mix', imageSeconds: 1 });
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
    await waitFor(() => ctl.getState().preview.autoFollow === 'end');

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
    await ctl.setGroup(g.id, { end: 'cut' });

    await ctl.setEntry(ctl.playlist.group(g.id).items[0].id, { volumeDb: -6 });
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
    await ctl.setLook('program', { volumeDb: 0 });
    assert.strictEqual(sent[1], 'MIXER 1-10 VOLUME 1.0000');
    await ctl.updateSettings({ masterVolumeDb: -40 });
    assert.strictEqual(sent[2], 'MIXER 1 MASTERVOLUME 0.0000');
  } finally {
    await engine.stop();
  }
});

test('vnos: lastna nastavitev konca, IN/OUT točki, trajanje slike', async () => {
  const { ctl, engine, sent, dir } = makeController();
  try {
    const a = path.join(dir, 'a.mp4');
    const c = path.join(dir, 'c.png');
    for (const f of [a, c]) fs.writeFileSync(f, 'x');
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    ctl.addFiles([a, c]);
    const [ia, ic] = ctl.library.items;
    const g1 = ctl.playlist.groups[0];
    await ctl.addToGroup(g1.id, [ia.id]);
    const g2id = ctl.addGroup('B');
    await ctl.addToGroup(g2id, [ic.id, ia.id]);
    const [e1] = ctl.playlist.group(g1.id).items;
    const [e2, e3] = ctl.playlist.group(g2id).items;
    await ctl.setEntry(e1.id, { end: 'cut', inSec: 2, outSec: 4 });
    await ctl.setEntry(e2.id, { seconds: 1, end: 'mix' });

    await ctl.loadPreview(ia.id, e1.id);
    assert.ok(sent.some((x) => /^LOADBG 1-10 ".*a\.mp4" SEEK 100 IN 100 OUT 200$/.test(x)), sent.join('\n'));
    assert.strictEqual(ctl.getState().preview.inSec, 2);
    await ctl.updateSettings({ autoNext: false });
    sent.length = 0;
    await ctl.take('cut');
    // Vnos ima svojo nastavitev "naprej s CUT", zato gre tudi v naslednjo skupino; AUTO šele po 0,7 s.
    await waitFor(() => ctl.getState().preview && ctl.getState().preview.autoFollow === 'end');
    assert.ok(sent.some((x) => /^LOADBG 1-10 ".*c\.png" AUTO$/.test(x)), sent.join('\n'));

    ctl._onOsc({ address: '/channel/1/stage/layer/10/foreground/file/path', args: [c] });
    assert.strictEqual(ctl.program.src.entryId, e2.id);
    await waitFor(() => ctl.getState().preview && ctl.getState().preview.autoFollow === 'timer');
    sent.length = 0;
    await waitFor(() => ctl.program.src.entryId === e3.id, 3000);
    assert.match(sent[0], /^PLAY 1-10 ".*a\.mp4" MIX 12 LINEAR$/);

    // Medij brez playliste: brez nastavitev
    await ctl.loadPreview(ia.id);
    ctl.times[2] = { elapsed: 1.5, total: 10 };
    await assert.rejects(() => ctl.markPreview('in'), /playlist/);
    await assert.rejects(() => ctl.setLook('preview', { volumeDb: -3 }), /playlist/);

    // Ista datoteka v drugem vnosu (e3) ima svoje IN/OUT, jakost in postavitev
    await ctl.loadPreview(ia.id, e3.id);
    ctl.times[2] = { elapsed: 1.5, total: 10 };
    await ctl.markPreview('in');
    ctl.times[2] = { elapsed: 6, total: 10 };
    sent.length = 0;
    await ctl.markPreview('out');
    assert.strictEqual(e3.inSec, 1.5);
    assert.strictEqual(e3.outSec, 6);
    assert.strictEqual(e1.inSec, 2);
    assert.strictEqual(ia.inSec, undefined);
    assert.ok(sent.some((x) => /^LOAD 2-10 ".*a\.mp4" SEEK 75 IN 75 OUT 300$/.test(x)), sent.join('\n'));
    await assert.rejects(() => { ctl.times[2] = { elapsed: 1, total: 10 }; return ctl.markPreview('out'); });
    await ctl.markPreview('out', true);
    assert.strictEqual(e3.outSec, null);
    await ctl.setLook('preview', { muted: true, zoom: 1.5 });
    assert.strictEqual(e3.muted, true);
    assert.strictEqual(e3.zoom, 1.5);
    assert.strictEqual(e1.muted, false);
    assert.strictEqual(ctl.getState().preview.zoom, 1.5);
    await ctl.loadPreview(ia.id, e1.id);
    assert.strictEqual(ctl.getState().preview.zoom, 1);
    assert.strictEqual(ctl.getState().preview.muted, false);
  } finally {
    await engine.stop();
  }
});

test('akcije: XR18 OSC, HTTP, splošen OSC, sprožitev ob začetku in koncu vnosa', async () => {
  const dgram = require('dgram');
  const http = require('http');
  const { ActionManager } = require('../main/actions');
  const { dbToFader } = require('../main/devices/xr18');
  const { parsePacket } = require('../main/engine/osc');
  assert.strictEqual(dbToFader(0), 0.75);
  assert.strictEqual(dbToFader(-90), 0);

  // Lažna XR18 na lokalnih vratih: sprejme in odgovori na /xinfo.
  const got = [];
  const udp = dgram.createSocket('udp4');
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  udp.on('message', (buf, rinfo) => {
    for (const m of parsePacket(buf)) {
      got.push(m);
      if (m.address === '/xinfo') {
        const { encodeMessage } = require('../main/engine/osc');
        udp.send(encodeMessage('/xinfo', ['127.0.0.1', 'XR18-test', 'XR18', '1.18']), rinfo.port, rinfo.address);
      }
    }
  });
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.method + ' ' + req.url); res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  const { ctl, engine, dir } = makeController();
  const am = new ActionManager({ file: path.join(dir, 'actions.json') });
  ctl.actions = am;
  am.on('changed', () => ctl._changed());
  // Testna "XR18" posluša na drugih vratih kot 10024, zato vrata podtaknemo.
  const xr = require('../main/devices/xr18');
  const origRun = xr.Xr18Device.prototype._send;
  xr.Xr18Device.prototype._send = function (address, args) {
    this.socket.send(require('../main/engine/osc').encodeMessage(address, args), udp.address().port, '127.0.0.1');
  };
  try {
    const devId = await am.saveDevice({ type: 'xr18', name: 'Miza', host: '127.0.0.1' });
    await waitFor(() => am.getState().devices[0].connected, 5000);
    const a1 = am.saveAction({ name: 'Utišaj', steps: [
      { type: 'xr18', deviceId: devId, cmd: 'mute', target: 'ch', num: 3 },
      { type: 'xr18', deviceId: devId, cmd: 'fader', target: 'lr', db: 0 },
      { type: 'xr18', deviceId: devId, cmd: 'mutegroup', group: 2 },
    ] });
    const a2 = am.saveAction({ name: 'Splet', steps: [
      { type: 'http', url: `http://127.0.0.1:${srv.address().port}/go?x=1`, method: 'POST', body: '{"a":1}' },
      { type: 'wait', ms: 10 },
      { type: 'osc', host: '127.0.0.1', port: udp.address().port, address: '/test/x', args: '1 0.5 hej' },
    ] });
    await am.run(a1);
    await waitFor(() => got.some((m) => m.address === '/config/mute/2'));
    assert.deepStrictEqual(got.find((m) => m.address === '/ch/03/mix/on').args, [0]);
    assert.deepStrictEqual(got.find((m) => m.address === '/lr/mix/fader').args, [0.75]);
    await am.run(a2);
    await waitFor(() => got.some((m) => m.address === '/test/x'));
    assert.deepStrictEqual(hits, ['POST /go?x=1']);
    assert.deepStrictEqual(got.find((m) => m.address === '/test/x').args, [1, 0.5, 'hej']);

    // Sprožitev ob vnosu
    const v = path.join(dir, 'v.mp4');
    fs.writeFileSync(v, 'x');
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    ctl.addFiles([v]);
    const g = ctl.playlist.groups[0];
    await ctl.addToGroup(g.id, [ctl.library.items[0].id]);
    const e = g.items[0];
    await ctl.setEntry(e.id, { startAction: a2, endAction: a1, endLead: 1 });
    hits.length = 0;
    got.length = 0;
    await ctl.loadPreview(e.mediaId, e.id);
    await ctl.take('cut');
    await waitFor(() => hits.length === 1);
    ctl._onOsc({ address: '/channel/1/stage/layer/10/foreground/file/time', args: [5, 10] });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!got.some((m) => m.address === '/ch/03/mix/on'));
    ctl._onOsc({ address: '/channel/1/stage/layer/10/foreground/file/time', args: [9.02, 10] });
    await waitFor(() => got.some((m) => m.address === '/ch/03/mix/on'));
    got.length = 0;
    ctl._onOsc({ address: '/channel/1/stage/layer/10/foreground/file/time', args: [9.5, 10] });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!got.some((m) => m.address === '/ch/03/mix/on')); // samo enkrat
  } finally {
    xr.Xr18Device.prototype._send = origRun;
    await am.stop();
    await engine.stop();
    udp.close();
    srv.closeAllConnections();
    srv.close();
  }
});

test('prileganje: filter za razmerje, povečavo in premik; velikost iz glave datoteke', () => {
  const { imageSize } = require('../main/probe');
  const png = Buffer.alloc(32);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(480, 16);
  png.writeUInt32BE(640, 20);
  assert.deepStrictEqual(imageSize(png), { width: 480, height: 640 });

  const { ctl } = makeController();
  const f = (it) => ctl._fitFilter({ type: 'video', ...it });
  assert.strictEqual(f({ width: 1920, height: 1080 }), null);
  assert.strictEqual(f({ width: 1280, height: 720 }), null);
  assert.strictEqual(f({ width: 640, height: 480, fit: 'stretch' }), null);
  assert.strictEqual(f({}), null); // neznana velikost in privzeto
  assert.strictEqual(f({ width: 640, height: 480 }), 'scale=1440:1080,pad=1920:1080:240:0:color=black@0,setsar=1');
  assert.strictEqual(f({ width: 640, height: 480, fit: 'fill' }), 'scale=1920:1440,crop=1920:1080:0:180,pad=1920:1080:0:0:color=black@0,setsar=1');
  assert.strictEqual(f({ width: 1920, height: 1080, zoom: 0.5, posX: 25 }), 'scale=960:540,pad=1920:1080:960:270:color=black@0,setsar=1');
  assert.match(f({ width: 1920, height: 1080, zoom: 2 }), /^scale=3840:2160,crop=1920:1080:960:540,pad=1920:1080:0:0/);
});

test('v0.7.0: nastavitve medija gredo k vnosom v playlisti', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ items: [
    { id: 'm1', name: 'a', path: path.join(dir, 'a.mp4'), type: 'video', volumeDb: -6, muted: true, fit: 'fill', zoom: 1.2, posX: 10, inSec: 3 },
    { id: 'm2', name: 'b', path: path.join(dir, 'b.mp4'), type: 'video' },
  ] }));
  fs.writeFileSync(path.join(dir, 'playlist.json'), JSON.stringify({ groups: [{ id: 'g', name: 'G', items: [
    { id: 'e1', mediaId: 'm1' }, { id: 'e2', mediaId: 'm1', inSec: 1 }, { id: 'e3', mediaId: 'm2' },
  ] }] }));
  const engine = new Engine({ casparDir: MOCK_DIR, workDir: path.join(dir, 'engine'), amcpPort: portBase++ });
  const ctl = new Controller({ engine, dataDir: dir, listDisplays: async () => [] });
  const [e1, e2, e3] = ctl.playlist.groups[0].items;
  for (const e of [e1, e2]) {
    assert.strictEqual(e.volumeDb, -6);
    assert.strictEqual(e.muted, true);
    assert.strictEqual(e.fit, 'fill');
    assert.strictEqual(e.zoom, 1.2);
    assert.strictEqual(e.posX, 10);
  }
  assert.strictEqual(e1.inSec, null); // IN medija ni veljal za vnose
  assert.strictEqual(e2.inSec, 1);
  assert.strictEqual(e3.volumeDb, 0);
  assert.strictEqual(e3.fit, null);
  const lib = JSON.parse(fs.readFileSync(ctl.libraryFile, 'utf8'));
  assert.strictEqual(lib.items[0].volumeDb, undefined);
  assert.strictEqual(lib.items[0].inSec, undefined);
  const pl = JSON.parse(fs.readFileSync(ctl.playlistFile, 'utf8'));
  assert.strictEqual(pl.groups[0].items[1].muted, true);
});

test('projekti: medijska mapa, podmape, kopiranje, premik, izvoz in uvoz', async () => {
  const dir = tmpDir();
  const engine = new Engine({ casparDir: MOCK_DIR, workDir: path.join(dir, 'engine'), amcpPort: portBase++ });
  const trashed = [];
  const ctl = new Controller({ engine, dataDir: dir, listDisplays: async () => [], trashItem: async (p) => { trashed.push(p); fs.rmSync(p); } });
  try {
    assert.strictEqual(ctl.project.name, 'Moj projekt');
    const media = path.join(dir, 'Oddaja');
    fs.mkdirSync(path.join(media, 'Uvod'), { recursive: true });
    fs.writeFileSync(path.join(media, 'Uvod', 'intro.mp4'), 'aaaa');
    fs.writeFileSync(path.join(media, 'logo.png'), 'x');
    fs.writeFileSync(path.join(media, 'opis.txt'), 'ni medij');
    ctl.setMediaDir(media);
    assert.deepStrictEqual(ctl.folders, ['Uvod']);
    assert.deepStrictEqual(ctl.library.items.map((i) => i.rel).sort(), ['Uvod/intro.mp4', 'logo.png']);
    const intro = ctl.library.items.find((i) => i.rel === 'Uvod/intro.mp4');
    await ctl.addToGroup(ctl.playlist.groups[0].id, [intro.id]);
    await ctl.setEntry(ctl.playlist.groups[0].items[0].id, { inSec: 2 });

    // Datoteka od drugje se kopira v projektno mapo (v izbrano podmapo)
    const outside = path.join(dir, 'zunaj.mp4');
    fs.writeFileSync(outside, 'bbbbbb');
    assert.strictEqual(ctl.createFolder('', 'Video'), 'Video');
    assert.strictEqual(await ctl.importFiles([outside], 'Video'), 1);
    assert.ok(fs.existsSync(path.join(media, 'Video', 'zunaj.mp4')));
    assert.ok(fs.existsSync(outside));
    assert.ok(ctl.library.items.some((i) => i.rel === 'Video/zunaj.mp4'));
    await ctl.importFiles([outside], 'Video');
    assert.ok(fs.existsSync(path.join(media, 'Video', 'zunaj (2).mp4')));

    // Premik v drugo podmapo (tudi na disku), id ostane
    await ctl.moveMedia(intro.id, 'Video');
    assert.ok(fs.existsSync(path.join(media, 'Video', 'intro.mp4')));
    assert.ok(!fs.existsSync(path.join(media, 'Uvod', 'intro.mp4')));
    assert.strictEqual(intro.rel, 'Video/intro.mp4');

    // Premik v Raziskovalcu: poveže se po imenu in velikosti
    fs.renameSync(path.join(media, 'Video', 'intro.mp4'), path.join(media, 'Uvod', 'intro.mp4'));
    ctl._rescan();
    assert.strictEqual(ctl.library.items.find((i) => i.id === intro.id).rel, 'Uvod/intro.mp4');
    // Izbrisana datoteka, ki ni v playlisti, izgine s seznama
    fs.rmSync(path.join(media, 'Video', 'zunaj (2).mp4'));
    ctl._rescan();
    assert.ok(!ctl.library.items.some((i) => i.rel === 'Video/zunaj (2).mp4'));

    // Brisanje iz aplikacije gre v koš
    const logo = ctl.library.items.find((i) => i.rel === 'logo.png');
    await ctl.removeItem(logo.id);
    assert.deepStrictEqual(trashed, [path.join(media, 'logo.png')]);

    // Izvoz, nov projekt, preklop
    const file = path.join(dir, 'Oddaja.playout');
    ctl.exportProject(file);
    const firstId = ctl.projectId;
    await ctl.createProject('Drugi');
    assert.strictEqual(ctl.project.name, 'Drugi');
    assert.strictEqual(ctl.library.items.length, 0);
    await ctl.switchProject(firstId);
    assert.strictEqual(ctl.playlist.groups[0].items.length, 1);

    // Uvoz na "drugem računalniku": mediji v drugi mapi in drugače razporejeni
    const other = path.join(dir, 'Drug PC');
    fs.mkdirSync(path.join(other, 'Kar nekaj'), { recursive: true });
    fs.writeFileSync(path.join(other, 'Kar nekaj', 'intro.mp4'), 'aaaa');
    const res = await ctl.importProject(file, other);
    assert.strictEqual(ctl.project.name, 'Moj projekt (2)');
    assert.strictEqual(res.missing, 0);
    const e = ctl.playlist.groups[0].items[0];
    assert.strictEqual(e.inSec, 2);
    const it = ctl.library.items.find((i) => i.id === e.mediaId);
    assert.strictEqual(it.path, path.join(other, 'Kar nekaj', 'intro.mp4'));
    assert.strictEqual(ctl.projects.list().length, 3);
  } finally {
    ctl._unwatch();
    await engine.stop();
  }
});

test('plasti in barve: preview, program, preliv, spremembe v živo', async () => {
  const { ctl, engine, sent, dir } = makeController();
  try {
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    const logo = path.join(dir, 'logo.png');
    for (const f of [a, b, logo]) fs.writeFileSync(f, 'x');
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    ctl.addFiles([a, b, logo]);
    const [ia, ib, il] = ctl.library.items;
    const g = ctl.playlist.groups[0];
    await ctl.addToGroup(g.id, [ia.id, ib.id]);
    const [e1, e2] = ctl.playlist.group(g.id).items;
    await ctl.loadPreview(ia.id, e1.id);
    sent.length = 0;
    const lid = await ctl.addLayer('preview', il.id);
    assert.ok(sent.includes(`MIXER 2-20 FILL 0.0000 0.0000 1.0000 1.0000`), sent.join('\n'));
    assert.ok(sent.some((x) => /^PLAY 2-20 ".*logo\.png"$/.test(x)), sent.join('\n'));
    sent.length = 0;
    await ctl.setLayer('preview', lid, { scale: 0.5, posX: 20, blend: 'multiply', opacity: 0.5 });
    assert.ok(sent.includes('MIXER 2-20 FILL 0.4500 0.2500 0.5000 0.5000'), sent.join('\n'));
    assert.ok(sent.includes('MIXER 2-20 BLEND multiply'));
    assert.ok(!sent.some((x) => x.startsWith('PLAY')), 'brez ponovnega nalaganja');
    await ctl.setLook('preview', { saturation: 0.2 });
    assert.ok(sent.includes('MIXER 2-10 SATURATION 0.2000'), sent.join('\n'));

    sent.length = 0;
    await ctl.take('cut');
    assert.ok(sent.some((x) => /^PLAY 1-20 ".*logo\.png"$/.test(x)), sent.join('\n'));
    assert.ok(sent.includes('MIXER 1-10 SATURATION 0.2000'));
    // Plast na programu se spremeni takoj
    sent.length = 0;
    await ctl.setLayer('program', lid, { hidden: true });
    assert.ok(sent.includes('MIXER 1-20 OPACITY 0.0000 4 LINEAR'), sent.join('\n'));
    // Naslednji vnos brez plasti: AUTO pobledi plasti in vrne barve
    await ctl.loadPreview(ib.id, e2.id);
    sent.length = 0;
    await ctl.take('auto');
    assert.ok(sent.includes('MIXER 1-20 OPACITY 0 12 LINEAR'), sent.join('\n'));
    assert.ok(sent.includes('MIXER 1-10 SATURATION 1.0000 12 LINEAR'), sent.join('\n'));
    await waitFor(() => sent.includes('CLEAR 1-20'), 2000);
    // Vnos z dvema plastema gre v drugo skupino plasti
    await ctl.addToGroup(g.id, [ia.id]);
    const e3 = ctl.playlist.group(g.id).items[2];
    ctl.playlist.addLayer(e3.id, il.id);
    ctl.playlist.addLayer(e3.id, il.id);
    await ctl.loadPreview(ia.id, e3.id);
    sent.length = 0;
    await ctl.take('cut');
    assert.ok(sent.some((x) => /^PLAY 1-41 ".*logo\.png"$/.test(x)), sent.join('\n'));
    // Brisanje medija odstrani plasti
    await ctl.clearProgram();
    await ctl.clearPreview();
    await ctl.removeItem(il.id);
    assert.strictEqual(ctl.playlist.findEntry(e3.id).entry.layers.length, 0);
  } finally {
    await engine.stop();
  }
});

test('fade na začetku in koncu vnosa', async () => {
  const { ctl, engine, sent, dir } = makeController();
  try {
    ctl.settings.fadeSeconds = 0.5;
    const a = path.join(dir, 'a.mp4');
    fs.writeFileSync(a, 'x');
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    ctl.addFiles([a]);
    const [ia] = ctl.library.items;
    const g = ctl.playlist.groups[0];
    await ctl.addToGroup(g.id, [ia.id, ia.id]);
    const [e1, e2] = ctl.playlist.group(g.id).items;
    await ctl.setEntry(e1.id, { outSec: 8 });
    await ctl.loadPreview(ia.id, e1.id);
    sent.length = 0;
    await ctl.take('cut');
    const i0 = sent.indexOf('MIXER 1-10 OPACITY 0.0000');
    const iPlay = sent.findIndex((x) => x.startsWith('PLAY 1-10'));
    assert.ok(i0 !== -1 && i0 < iPlay, sent.join('\n'));
    assert.ok(sent.includes('MIXER 1-10 VOLUME 0'));
    assert.ok(sent.includes('MIXER 1-10 OPACITY 1.0000 25 LINEAR'), sent.join('\n')); // 0,5 s pri 50p
    assert.ok(sent.includes('MIXER 1-10 VOLUME 1.0000 25 LINEAR'), sent.join('\n'));
    // Fade out pred OUT (8 s): naslednji vnos ni samodejen (skupina: ustavi)
    ctl.program.wallStart = Date.now() - 5000;
    sent.length = 0;
    ctl._onOsc({ address: '/channel/1/stage/layer/10/foreground/file/time', args: [7.6, 20] });
    await waitFor(() => sent.some((x) => /^MIXER 1-10 VOLUME 0 \d+ LINEAR$/.test(x)));
    assert.ok(sent.includes('MIXER 1-10 OPACITY 0.0000 20 LINEAR'), sent.join('\n'));
    // Premik nazaj vrne sliko
    sent.length = 0;
    await ctl.seek('program', 2);
    assert.ok(sent.includes('MIXER 1-10 OPACITY 1.0000 4 LINEAR'), sent.join('\n'));
    // Vnos z 0 = brez fade-a, AUTO brez fade-a
    await ctl.setEntry(e2.id, { fadeIn: 0 });
    await ctl.loadPreview(ia.id, e2.id);
    sent.length = 0;
    await ctl.take('cut');
    assert.ok(!sent.includes('MIXER 1-10 OPACITY 0.0000'), sent.join('\n'));
  } finally {
    await engine.stop();
  }
});

test('bližnjice in HTTP vmesnik (Stream Deck / Companion)', async () => {
  const http = require('http');
  const { createServer } = require('../main/server');
  const { ctl, engine, dir } = makeController();
  let srv;
  try {
    const a = path.join(dir, 'a.mp4');
    fs.writeFileSync(a, 'x');
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    ctl.addFiles([a]);
    const g = ctl.playlist.groups[0];
    await ctl.addToGroup(g.id, [ctl.library.items[0].id, ctl.library.items[0].id]);
    assert.strictEqual(ctl.settings.hotkeys.cut, 'Enter');
    await ctl.updateSettings({ hotkeys: { panic: 'F12' } });
    assert.strictEqual(ctl.settings.hotkeys.panic, 'F12');
    assert.strictEqual(ctl.settings.hotkeys.auto, 'Space');
    srv = await createServer({ controller: ctl, uiDir: path.join(__dirname, '..', 'ui'), port: 0 });
    const get = (p) => new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${srv.port}${p}`, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(b) }));
      }).on('error', reject);
    });
    let r = await get('/api/next');
    assert.strictEqual(r.code, 200);
    assert.strictEqual(ctl.preview.src.entryId, g.items[0].id);
    r = await get('/api/next');
    assert.strictEqual(ctl.preview.src.entryId, g.items[1].id);
    r = await get('/api/cut');
    assert.ok(ctl.program.item);
    r = await get(`/api/group/${encodeURIComponent(g.name)}`);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(ctl.preview.src.entryId, g.items[0].id);
    r = await get('/api/panic');
    assert.strictEqual(ctl.panic, true);
    r = await get('/api/state');
    assert.strictEqual(r.body.panic, true);
    assert.strictEqual(r.body.program, 'a.mp4');
    r = await get('/api/action/Ne obstaja');
    assert.strictEqual(r.code, 400);
  } finally {
    if (srv) srv.server.close();
    for (const c of srv ? srv.wss.clients : []) c.terminate();
    await engine.stop();
  }
});

test('napisi: celostna podoba, vklop/izklop, posodobitev v živo, izvoz', async () => {
  const { ctl, engine, sent, dir } = makeController();
  try {
    const logo = path.join(dir, 'logo.png');
    fs.writeFileSync(logo, 'x');
    ctl.templateDir = path.join(dir, 'tpl');
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    assert.ok(fs.existsSync(path.join(dir, 'tpl', 'playout-klasicni.html')), 'predloge so nameščene');
    ctl.addFiles([logo]);
    const logoId = ctl.library.items[0].id;
    await ctl.setBrand({ logo: logoId, bg: '#112233', accent: '#ffcc00', font: 'Arial' });
    const id = ctl.addTitle({ template: 'klasicni', f0: 'Ana "Novak"', f1: 'vodja' });
    const t = ctl.titles.get(id);
    assert.deepStrictEqual(ctl._titleData(t).bg, '#112233');
    assert.ok(ctl._titleData(t).logo.startsWith('file://'));
    sent.length = 0;
    await ctl.titleOn(id);
    const add = sent.find((c) => c.startsWith('CG 1-60 ADD 0 "playout-klasicni" 1 '));
    assert.ok(add, sent.join('\n'));
    assert.ok(add.includes('\\"f0\\":\\"Ana \\\\\\"Novak\\\\\\"\\"'), add); // narekovaji dvojno ubežani
    assert.deepStrictEqual(ctl.titlesState().onAir, [id]);
    // drug napis gre na naslednjo plast
    const id2 = ctl.addTitle({ template: 'logo' });
    await ctl.titleToggle(id2);
    assert.ok(sent.some((c) => c.startsWith('CG 1-61 ADD 0 "playout-logo"')));
    // sprememba besedila in barv velja takoj
    sent.length = 0;
    await ctl.setTitle(id, { f0: 'Ana Kovač', bg: '#ff0000' });
    assert.ok(sent.some((c) => c.startsWith('CG 1-60 UPDATE 0 ') && c.includes('Kovač') && c.includes('#ff0000')), sent.join('\n'));
    sent.length = 0;
    await ctl.setBrand({ accent: '#00ff00' });
    assert.ok(sent.some((c) => c.startsWith('CG 1-60 UPDATE') && c.includes('#00ff00')));
    // predloga zamenjana na programu = ponovno naloži
    sent.length = 0;
    await ctl.setTitle(id, { template: 'moderni' });
    assert.ok(sent.some((c) => c.startsWith('CG 1-60 ADD 0 "playout-moderni"')));
    // izklop: izhodna animacija, nato počisti plast
    sent.length = 0;
    await ctl.titleOff(id);
    assert.ok(sent.includes('CG 1-60 STOP 0'));
    assert.deepStrictEqual(ctl.titlesState().onAir, [id2]);
    await waitFor(() => sent.includes('CLEAR 1-60'), 3000);
    assert.ok(!ctl.titleSlots.has(60));
    // preview
    await ctl.titlePreview(id);
    assert.ok(sent.some((c) => c.startsWith('CG 2-60 ADD 0 "playout-moderni"')));
    // samodejni izklop
    await ctl.setTitle(id2, { duration: 1 });
    await ctl.titleOff(id2);
    await waitFor(() => !ctl.titleSlots.size, 3000);
    await ctl.titleOn(id2);
    await waitFor(() => ctl.titlesState().onAir.length === 0, 3000);
    // ukaz za bližnjico in iskanje po imenu
    await ctl.runCommand(`title:${id}`);
    assert.deepStrictEqual(ctl.titlesState().onAir, [id]);
    assert.strictEqual(ctl.findTitle('ana kovač').id, id);
    await ctl.runCommand('titlesOff');
    assert.deepStrictEqual(ctl.titlesState().onAir, []);
    // korak akcije "Napis"
    const { ActionManager } = require('../main/actions');
    const am = new ActionManager({ file: path.join(dir, 'actions.json') });
    am.local = (st) => ctl._actionLocalStep(st);
    const act = am.saveAction({ name: 'Ime gor', steps: [{ type: 'title', cmd: 'on', target: id2 }] });
    await am.run(typeof act === 'string' ? act : am.actions[0].id);
    assert.deepStrictEqual(ctl.titlesState().onAir, [id2]);
    await ctl._actionLocalStep({ cmd: 'allOff' });
    assert.deepStrictEqual(ctl.titlesState().onAir, []);
    // brisanje logotipa iz medijev: celostna podoba ostane brez njega
    const file = path.join(dir, 'p.playout');
    ctl.exportProject(file);
    const exp = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(exp.titles.items.length, 2);
    assert.strictEqual(exp.brand.accent, '#00ff00');
    await ctl.importProject(file, dir);
    assert.strictEqual(ctl.titles.items.length, 2);
    assert.strictEqual(ctl.project.brand.bg, '#112233');
    // preklop projekta počisti napise
    await ctl.titleOn(ctl.titles.items[0].id);
    assert.strictEqual(ctl.titleSlots.size, 1);
  } finally {
    ctl._unwatch();
    await engine.stop();
  }
});

test('key & fill: drugi zaslon dobi key izhod', async () => {
  const { ctl, engine } = makeController();
  try {
    const d2 = { index: 3, device: '\\\\.\\DISPLAY4', adapter: 'Intel', monitor: 'ATEM 2', active: true, primary: false, x: 3840, y: 0, width: 1920, height: 1080, hz: 50 };
    ctl.listDisplaysFn = async () => [
      { index: 2, device: '\\\\.\\DISPLAY3', adapter: 'Intel', monitor: 'ATEM', active: true, primary: false, x: 1920, y: 0, width: 1920, height: 1080, hz: 50 }, d2];
    await ctl.refreshDisplays();
    ctl.settings.keyOutput = d2.device;
    let o = ctl.engineOptions();
    assert.strictEqual(o.screens.length, 2);
    assert.strictEqual(o.screens[1].keyOnly, true);
    const { buildConfig } = require('../main/engine/caspar-config');
    const cfg = buildConfig({ ...o, paths: { media: '/m', log: '/l', data: '/d', template: '/t' }, amcpPort: 5250 });
    assert.ok(/<device>4<\/device>[\s\S]*<key-only>true<\/key-only>/.test(cfg));
    // isti zaslon kot PROGRAM: key izklopljen z opozorilom
    ctl.settings.keyOutput = '\\\\.\\DISPLAY3';
    o = ctl.engineOptions();
    assert.strictEqual(o.screens.length, 1);
    assert.ok(ctl.keyWarning());
    ctl.settings.keyOutput = 'test';
    o = ctl.engineOptions();
    assert.strictEqual(o.screens[1].windowedTest, true);
    assert.strictEqual(o.screens[1].keyOnly, true);
  } finally {
    ctl._unwatch();
    await engine.stop();
  }
});

test('tablica: omrežni dostop s PIN in samo dovoljeni ukazi', async () => {
  const http = require('http');
  const WebSocket = require('ws');
  const { createServer } = require('../main/server');
  const { ctl, engine } = makeController();
  const lanPort = portBase++;
  let srv;
  const get = (p) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${lanPort}${p}`, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    }).on('error', reject);
  });
  const wsCall = (pin, action, args) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${lanPort}/ws?pin=${pin}`);
    ws.on('error', reject);
    ws.on('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, action, args })));
    ws.on('message', (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.type === 'reply') {
        ws.close();
        resolve(msg);
      }
    });
  });
  try {
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    srv = await createServer({ controller: ctl, uiDir: path.join(__dirname, '..', 'ui'), port: 0, lanPort });
    // izklopljeno: ni strežnika
    await assert.rejects(get('/'));
    await ctl.updateSettings({ lanRemote: true });
    const pin = ctl.settings.lanPin;
    assert.match(pin, /^\d{6}$/);
    await waitFor(() => srv.lanInfo().running, 3000);
    let r = await get('/');
    assert.strictEqual(r.code, 200);
    assert.ok(r.body.includes('remote.js'), 'tablica dobi poenostavljen vmesnik');
    r = await get('/api/state');
    assert.strictEqual(r.code, 401);
    r = await get(`/api/state?pin=${pin}`);
    assert.strictEqual(r.code, 200);
    await assert.rejects(wsCall('000000', 'state.get'), /401/);
    let m = await wsCall(pin, 'state.get');
    assert.strictEqual(m.ok, true);
    m = await wsCall(pin, 'settings.update', { lanRemote: false });
    assert.strictEqual(m.ok, false, 'tablica ne sme spreminjati nastavitev');
    m = await wsCall(pin, 'library.remove', { id: 'x' });
    assert.strictEqual(m.ok, false);
    m = await wsCall(pin, 'program.panic', { on: true });
    assert.strictEqual(m.ok, true);
    assert.strictEqual(ctl.panic, true);
    // nov PIN: stari ne velja več
    await ctl.updateSettings({ lanPin: 'new' });
    assert.notStrictEqual(ctl.settings.lanPin, pin);
    r = await get(`/api/state?pin=${pin}`);
    assert.strictEqual(r.code, 401);
    // izklop zapre strežnik
    await ctl.updateSettings({ lanRemote: false });
    await waitFor(() => !srv.lanInfo().running, 3000);
  } finally {
    if (srv) {
      srv.closeLan();
      srv.server.close();
      for (const c of srv.wss.clients) c.terminate();
    }
    ctl._unwatch();
    await engine.stop();
  }
});

test('preseti iz imen v ATEM in XR18', async () => {
  const { ActionManager } = require('../main/actions');
  const { presetStep } = require('../main/presets');
  const { Xr18Device } = require('../main/devices/xr18');
  const dir = tmpDir();
  const file = path.join(dir, 'actions.json');
  const am = new ActionManager({ file });
  const atemId = await am.saveDevice({ type: 'atem', name: 'Mini', host: '' });
  const xrId = await am.saveDevice({ type: 'xr18', name: 'Miza', host: '' });
  const ran = [];
  let inputs = [{ id: 1, name: 'Kamera 1' }, { id: 2, name: 'Voditelj' }, { id: 1000, name: 'Bars' }, { id: 10010, name: 'Program' }];
  const fake = { connected: true, info: () => ({ connected: true, inputs, aux: 1, macros: [{ index: 0, name: 'Intro' }] }), run: async (s) => ran.push(s), stop: async () => {} };
  am.conns.set(atemId, fake);
  const xr = new Xr18Device({ id: xrId, name: 'Miza', host: '' });
  xr.connected = true;
  xr._onName({ address: '/ch/03/config/name', args: ['Gost'] });
  xr.run = async (s) => ran.push(s);
  am.conns.set(xrId, xr);
  am._updateCache(atemId);
  am._updateCache(xrId);
  let ps = am.presets();
  const lab = (id) => (ps.find((p) => p.id === id) || {}).label;
  assert.strictEqual(lab(`${atemId}.autoTo.2`), 'AUTO → Voditelj');
  assert.strictEqual(lab(`${atemId}.aux.1.1`), 'AUX 1 = Kamera 1');
  assert.strictEqual(lab(`${atemId}.macro.0`), 'Makro: Intro');
  assert.ok(!ps.some((p) => p.id === `${atemId}.cutTo.10010`), 'interni viri niso ponujeni');
  assert.strictEqual(lab(`${xrId}.mute.ch.3`), 'Utišaj: Gost (kanal 3)');
  assert.strictEqual(lab(`${xrId}.mute.lr`), 'Utišaj: glavni izhod LR');
  // preimenovanje v napravi spremeni ime, id ostane
  inputs = [{ id: 1, name: 'Kamera 1' }, { id: 2, name: 'Gost' }];
  am._updateCache(atemId);
  ps = am.presets();
  assert.strictEqual(lab(`${atemId}.autoTo.2`), 'AUTO → Gost');
  await am.run(`preset:${atemId}.autoTo.2`);
  assert.deepStrictEqual(ran.pop(), { type: 'atem', deviceId: atemId, cmd: 'autoTo', input: 2 });
  await am.run(`preset:${xrId}.unmutegroup.2`);
  assert.deepStrictEqual(ran.pop(), { type: 'xr18', deviceId: xrId, cmd: 'unmutegroup', group: 2 });
  // korak "preset" v akciji
  const aid = am.saveAction({ name: 'x', autoName: true, steps: [{ type: 'preset', target: `${xrId}.mute.ch.3` }] });
  await am.run(aid);
  assert.deepStrictEqual(ran.pop(), { type: 'xr18', deviceId: xrId, cmd: 'mute', target: 'ch', num: 3 });
  assert.strictEqual(am.actions.find((a) => a.id === aid).autoName, true);
  // imena ostanejo shranjena, ko naprava ni povezana
  const am2 = new ActionManager({ file });
  const ps2 = am2.presets();
  assert.strictEqual(ps2.find((p) => p.id === `${atemId}.autoTo.2`).label, 'AUTO → Gost');
  assert.strictEqual(ps2.find((p) => p.id === `${xrId}.unmute.ch.3`).label, 'Vklopi: Gost (kanal 3)');
  assert.strictEqual(presetStep('neobstaja.cut', am2.devices), null);
  assert.strictEqual(presetStep(`${atemId}.aux.x.1`, am2.devices), null);
  await assert.rejects(am2.run('preset:neobstaja.cut'), /ne obstaja/);
  assert.ok(!('cache' in am2.getState().devices[0]), 'stanje za vmesnik je brez shranjenih imen');
});

test('slideshow: skupina iz slik, zamegljeno ozadje, dinamični zoom', async () => {
  const { ctl, engine, sent, dir } = makeController();
  try {
    const png = (name, w, h) => {
      const b = Buffer.alloc(64);
      b.writeUInt32BE(0x89504e47, 0);
      b.writeUInt32BE(w, 16);
      b.writeUInt32BE(h, 20);
      const p = path.join(dir, name);
      fs.writeFileSync(p, b);
      return p;
    };
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    ctl.addFiles([png('pokoncna.png', 720, 1080), png('siroka.png', 1920, 1080), path.join(dir, 'clip one.mp4')]);
    await waitFor(() => ctl.library.items.every((i) => i.type !== 'image' || i.width));
    const gid = await ctl.createSlideshow({ name: 'Izlet', mediaIds: ctl.library.items.map((i) => i.id), seconds: 4 });
    const g = ctl.playlist.group(gid);
    assert.strictEqual(g.items.length, 2); // video ni slika
    assert.deepStrictEqual([g.end, g.imageSeconds, g.kenBurns, g.blur, g.loop], ['mix', 4, true, true, false]);

    const portrait = ctl._slotItem(ctl.library.items.find((i) => i.name === 'pokoncna.png'), { groupId: gid, entryId: g.items[0].id });
    assert.strictEqual(portrait.fit, 'blur');
    assert.ok(portrait.kenBurns);
    assert.match(ctl._fitFilter(portrait), /^format=rgba,scale=720:1080,pad=1920:1080:600:0:color=black@0/);
    assert.match(ctl._blurArgs(portrait), /\.still" VF ".*boxblur/);
    const wide = ctl._slotItem(ctl.library.items.find((i) => i.name === 'siroka.png'), { groupId: gid, entryId: g.items[1].id });
    assert.strictEqual(ctl._blurArgs(wide), null); // 16:9 ne potrebuje ozadja

    await ctl.cueGroup(gid);
    assert.ok(sent.some((c) => c.startsWith('PLAY 2-9 ') && c.includes('boxblur')), 'preview dobi zamegljeno ozadje');
    assert.ok(sent.some((c) => c.startsWith('LOADBG 1-9 ')), 'ozadje je pripravljeno na programu');
    sent.length = 0;
    await ctl.take('cut');
    assert.ok(sent.includes('PLAY 1-9'), 'CUT zažene pripravljeno ozadje');
    assert.ok(!sent.some((c) => c.startsWith('MIXER 1-10 FILL')), 'zoom je v sliki, ne v plasti');
    sent.length = 0;
    await ctl.take('auto');
    assert.ok(sent.some((c) => /^PLAY 1-9 EMPTY MIX/.test(c)), 'široka slika: ozadje se odmakne s prelivom');
    const play = sent.find((c) => c.startsWith('PLAY 1-10 '));
    assert.match(play, /loop=loop=-1:size=1,setpts=N\/50\/TB,scale=w='trunc\(1920\*\(1\+0\.12\*min\(n\/\d+,1\)\)\/2\)\*2'/, 'vsaka slika se sama približuje');
    assert.match(play, /crop=1920:1080:x='\(iw-ow\)\*0':y='\(ih-oh\)\*0'/, 'druga slika gre proti drugemu kotu');

    await ctl.setGroup(gid, { kenBurns: false, blur: false });
    assert.strictEqual(ctl.program.item.kenBurns, false);
    sent.length = 0;
    await ctl.clearProgram(false);
  } finally {
    ctl._unwatch && ctl._unwatch();
    await engine.stop();
  }
});

test('ATEM ključi kot preseti', () => {
  const { presetStep, buildPresets } = require('../main/presets');
  const devs = [{ id: 'a1', type: 'atem', name: 'M', cache: { inputs: [], aux: 0, dsk: 2, usk: 1, macros: [] } }];
  const ids = buildPresets(devs, (d) => d.cache).map((p) => p.id);
  assert.ok(ids.includes('a1.dskAuto.2') && ids.includes('a1.uskOn.1') && !ids.includes('a1.uskOn.2'));
  assert.deepStrictEqual(presetStep('a1.dskAuto.2', devs), { type: 'atem', deviceId: 'a1', cmd: 'dskAuto', num: 2 });
  assert.strictEqual(presetStep('a1.dskAuto.9', devs), null);
});

test('napis na vnosu in velikost napisa', async () => {
  const { ctl, engine, sent, media } = makeController();
  try {
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    ctl.addFiles([media]);
    const g = ctl.playlist.groups[0];
    const mid = ctl.library.items[0].id;
    await ctl.addToGroup(g.id, [mid, mid, mid]);
    const tid = ctl.addTitle({ template: 'klasicni', f0: 'Janez', size: 1.3 });
    const [e1, e2, e3] = g.items;
    await ctl.setEntry(e1.id, { titleId: tid });
    await ctl.setEntry(e2.id, { titleId: tid, titleOut: 0.3 });
    assert.strictEqual(ctl.playlist.findEntry(e2.id).entry.titleOut, 0.3);
    await ctl.playDirect(mid, 'cut', e1.id);
    await waitFor(() => ctl._titleOnLayer(tid) !== null);
    await waitFor(() => sent.includes('MIXER 1-60 FILL -0.021 -0.27 1.3 1.3')); // 130 % ob levem spodnjem robu
    const n = sent.filter((c) => c.startsWith('CG 1-60 ADD')).length;
    await ctl.playDirect(mid, 'cut', e2.id); // isti napis ostane, ne začne znova
    assert.strictEqual(sent.filter((c) => c.startsWith('CG 1-60 ADD')).length, n);
    await waitFor(() => sent.includes('CG 1-60 STOP 0'), 2000); // titleOut 0,3 s
    await ctl.playDirect(mid, 'cut', e1.id);
    await waitFor(() => sent.filter((c) => c.startsWith('CG 1-6') && c.includes(' ADD ')).length > n);
    await ctl.playDirect(mid, 'cut', e3.id); // vnos brez napisa: napis gre dol
    await waitFor(() => sent.filter((c) => c === 'CG 1-60 STOP 0' || c === 'CG 1-61 STOP 0').length >= 2);
  } finally {
    ctl._unwatch && ctl._unwatch();
    await engine.stop();
  }
});

test('PTZ kontroler prek USB: povezava, preseti, premik z varnostjo, napake', async () => {
  const { ActionManager } = require('../main/actions');
  const { fakePtzIo } = require('./ptz-sim');
  const io = fakePtzIo();
  const am = new ActionManager({ file: path.join(tmpDir(), 'actions.json'), deviceIo: io });
  const id = await am.saveDevice({ type: 'ptz', name: 'PTZ', host: '' });
  try {
    await waitFor(() => am.conns.get(id).connected && am.devices[0].cache && am.devices[0].cache.presets && am.devices[0].cache.presets[2]);
    const dev = am.getState().devices[0];
    assert.strictEqual(dev.port, 'COM7'); // samodejno najde ESP32 (VID 303a)
    assert.strictEqual(dev.live.sel, 1);
    assert.deepStrictEqual(dev.presets[1].map((p) => p.name), ['Govornik', 'Totala', '']);
    const pids = am.presets().map((p) => p.id);
    assert.ok(pids.includes(`${id}.recall.1.2`) && pids.includes(`${id}.select.2`) && pids.includes(`${id}.stop`));
    assert.ok(!pids.some((p) => p.includes('.select.3')), 'izklopljena kamera nima presetov');
    assert.ok(am.presets().some((p) => p.label === 'JVC: preset 5'));
    const port = io.ports[0];

    await am.run(`preset:${id}.recall.1.2`);
    assert.deepStrictEqual(port.received.at(-1), { cmd: 'preset_recall', n: 2, cam: 1, id: port.received.at(-1).id });

    // premik: ponavlja se, dokler ga vmesnik obnavlja; potem sam ustavi
    am.ptzMove(id, 2, 0.5, 0, 0);
    await new Promise((r) => setTimeout(r, 200));
    const moves = port.received.filter((m) => m.cmd === 'move' && m.pan === 0.5);
    assert.ok(moves.length >= 3, `premik se ponavlja (${moves.length})`);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepStrictEqual(port.received.filter((m) => m.cmd === 'move').map((m) => m.pan).at(-1), 0, 'ustavi, ko vmesnik utihne');
    const n = port.received.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(port.received.length, n, 'po ustavitvi nič več ne pošilja');

    // kamera na programu: kontroler zavrne, vmesnik dobi razlog
    am.ptzMove(id, 1, 0, 0.3, 0);
    await waitFor(() => am.conns.get(id).moveError.includes('na programu'));
    am.ptzMove(id, 1, 0, 0, 0);

    await am.deviceRun(id, { cmd: 'lock' });
    await waitFor(() => am.getState().devices[0].live.lock);
    await assert.rejects(am.deviceRun(id, { cmd: 'recall', cam: 1, num: 1 }), /zaklep/);
    await am.deviceRun(id, { cmd: 'unlock' });

    await am.deviceRun(id, { cmd: 'store', cam: 2, num: 7, name: 'Nov kot' });
    await waitFor(() => am.presets().some((p) => p.id === `${id}.recall.2.7` && p.label === 'AIDA: Nov kot'));

    // izklop kabla: povezava se obnovi sama
    port.close();
    await waitFor(() => !am.conns.get(id).connected);
    await waitFor(() => am.conns.get(id).connected, 6000);
    assert.strictEqual(io.ports.length, 2);
  } finally {
    await am.stop();
  }
});

test('lastne predloge napisov iz mape', async () => {
  const { ctl, engine, dir } = makeController();
  try {
    const tdir = ctl.userTemplatesFolder();
    assert.ok(fs.existsSync(path.join(tdir, 'PREBERI.txt')) && fs.existsSync(path.join(tdir, 'primer.html.txt')));
    fs.copyFileSync(path.join(tdir, 'primer.html.txt'), path.join(tdir, 'Moj Šport.html'));
    assert.strictEqual(await ctl.rescanTemplates(), 1);
    const tpl = ctl.titlesState().templates.find((t) => t.user);
    assert.strictEqual(tpl.id, 'user-moj-sport');
    assert.strictEqual(tpl.name, 'Primer (kopija klasičnega) (moja)');
    assert.deepStrictEqual(tpl.fields.map((f) => f.label), ['Ime', 'Funkcija']);
    assert.ok(!('file' in tpl));
    const id = ctl.addTitle({ template: 'user-moj-sport', f0: 'A', align: 'right' });
    assert.strictEqual(ctl.titles.get(id).template, 'user-moj-sport');
    assert.strictEqual(ctl.titles.get(id).align, 'right');
    ctl.templateDir = path.join(dir, 'tpl');
    ctl._installTemplates();
    assert.ok(fs.existsSync(path.join(dir, 'tpl', 'playout-user-moj-sport.html')));
    assert.ok(fs.existsSync(path.join(dir, 'tpl', 'playout-trak.html')));
    // predloga izgine iz mape: napis ohrani ime predloge, prikaže se s klasično
    fs.rmSync(path.join(tdir, 'Moj Šport.html'));
    await ctl.rescanTemplates();
    const { Titles } = require('../main/titles');
    const again = new Titles(ctl.titles.toJSON());
    assert.strictEqual(again.get(id).template, 'user-moj-sport');
    assert.match(ctl._titleCmd(1, 60, again.get(id), 'add'), /"playout-klasicni"/);
  } finally {
    await engine.stop();
  }
});

test('akcije kot vnosi v playlisti (potek prireditve)', async () => {
  const http = require('http');
  const { ActionManager } = require('../main/actions');
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${srv.address().port}/${p}`;
  const { ctl, engine, dir } = makeController();
  const am = new ActionManager({ file: path.join(dir, 'actions.json') });
  ctl.actions = am;
  try {
    const ax = am.saveAction({ name: 'X', steps: [{ type: 'http', url: url('x'), method: 'GET' }] });
    const ay = am.saveAction({ name: 'Y', steps: [{ type: 'http', url: url('y'), method: 'GET' }] });
    const az = am.saveAction({ name: 'Z', steps: [{ type: 'http', url: url('z'), method: 'GET' }] });
    for (const n of ['v1.mp4', 'v2.mp4']) fs.writeFileSync(path.join(dir, n), 'x');
    await ctl.init();
    await waitFor(() => engine.status === 'running');
    ctl.addFiles([path.join(dir, 'v1.mp4'), path.join(dir, 'v2.mp4')]);
    const g = ctl.playlist.groups[0];
    await ctl.addToGroup(g.id, ctl.library.items.map((x) => x.id));
    await ctl.addActionEntry(g.id, ax, 0);
    await ctl.addActionEntry(g.id, ay, 2);
    const zid = await ctl.addActionEntry(g.id, az, 3);
    await ctl.setEntry(zid, { delay: 0.2 });
    await assert.rejects(() => ctl.addActionEntry(g.id, 'ni-je'));
    assert.deepStrictEqual(g.items.map((e) => e.kind || 'media'), ['action', 'media', 'action', 'action', 'media']);
    const [, v1, , , v2] = g.items;
    const st = ctl.getState().playlist[0].items;
    assert.strictEqual(st[0].type, 'action');
    assert.strictEqual(st[0].name, 'X');
    assert.strictEqual(ctl.playlist.nextAfter(v1.id).entry.id, v2.id);
    assert.strictEqual(ctl.playlist.firstMedia(g.id).id, v1.id);

    // Shrani in naloži znova: akcije ostanejo.
    const { Playlist } = require('../main/playlist');
    const again = new Playlist(JSON.parse(JSON.stringify(ctl.playlist.toJSON())));
    assert.strictEqual(again.groups[0].items[3].delay, 0.2);
    assert.strictEqual(again.groups[0].items.length, 5);

    await ctl.setGroup(g.id, { end: 'cut' });
    await ctl.cueGroup(g.id);
    assert.strictEqual(ctl.preview.src.entryId, v1.id);
    await ctl.take('cut');
    await waitFor(() => hits.includes('/x'));
    assert.strictEqual(ctl.preview.src.entryId, v2.id); // akcije se preskočijo
    assert.ok(!hits.includes('/y'));
    ctl._onOsc({ address: '/channel/1/stage/layer/10/foreground/file/time', args: [9.99, 10] });
    await waitFor(() => hits.includes('/y'));
    assert.ok(!hits.includes('/z'));
    await waitFor(() => hits.includes('/z'), 2000);
    hits.length = 0;
    await ctl.take('cut'); // v2: Y in Z sta se že sprožili
    await new Promise((r) => setTimeout(r, 400));
    assert.deepStrictEqual(hits, []);

    // Skok nazaj na v1 brez konca: X se sproži znova; Y ob zamenjavi z naslednjim (v2).
    await ctl.loadPreview(v1.mediaId, v1.id);
    await ctl.take('cut');
    await waitFor(() => hits.includes('/x'));
    await ctl.take('cut');
    await waitFor(() => hits.includes('/y'));
    await waitFor(() => hits.includes('/z'), 2000);
    assert.deepStrictEqual(ctl.playlist.flatMedia().map((x) => x.entry.id), [v1.id, v2.id]);
  } finally {
    await am.stop();
    await engine.stop();
    srv.closeAllConnections();
    srv.close();
  }
});
