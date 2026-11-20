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
