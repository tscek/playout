'use strict';
// HTTP + WebSocket strežnik. Okno aplikacije uporablja lokalni naslov (127.0.0.1).
// Tablica prek omrežja: drug strežnik na vseh omrežnih vmesnikih (vrata LAN_PORT), samo če je vklopljeno
// v nastavitvah, s PIN kodo; tam so dovoljeni samo ukazi za upravljanje (REMOTE_ACTIONS).

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const LAN_PORT = 8090;

/** Ukazi, ki jih sme poslati tablica (nič, kar briše datoteke ali spreminja nastavitve računalnika). */
const REMOTE_ACTIONS = new Set([
  'state.get', 'take.cut', 'take.auto', 'preview.load', 'preview.clear', 'program.clear', 'program.panic', 'program.direct',
  'playlist.cueGroup', 'seek', 'step', 'playPause', 'media.volume', 'media.mute', 'actions.run', 'ovl.go', 'ovl.off', 'ovl.next', 'ovl.step', 'ovl.source', 'ovl.tableTitle', 'playlist.fireEntry', 'tables.cue', 'tables.uncue', 'tables.active',
  'titles.on', 'titles.off', 'titles.toggle', 'titles.allOff', 'titles.preview', 'remote.command', 'atem.run', 'device.run', 'ptz.move',
]);

/** Naslovi IPv4 tega računalnika v lokalnem omrežju. */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/**
 * @param {object} o
 * @param {import('./controller').Controller} o.controller
 * @param {string} o.uiDir
 * @param {number} o.port
 * @param {string} o.host
 * @param {Record<string, Function>} o.extraActions  ukazi, ki potrebujejo Electron (npr. izbira datotek)
 */
function createServer({ controller, uiDir, port, host = '127.0.0.1', extraActions = {}, sysload = null, lanPort = LAN_PORT }) {
  // Zaščita pred ugibanjem PIN: po 10 napačnih poskusih z istega naslova 60 s premora.
  const fails = new Map();
  const pinOk = (req) => {
    const ip = req.socket.remoteAddress || '';
    const f = fails.get(ip);
    if (f && f.n >= 10 && Date.now() - f.at < 60000) return false;
    const pin = new URL(req.url || '/', 'http://x').searchParams.get('pin') || req.headers['x-playout-pin'] || '';
    const want = String(controller.settings.lanPin || '');
    const ok = !!want && String(pin) === want && controller.settings.lanRemote;
    if (ok) fails.delete(ip);
    else fails.set(ip, { n: (f && Date.now() - f.at < 60000 ? f.n : 0) + 1, at: Date.now() });
    return ok;
  };

  const handler = (remote) => (req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (remote && (urlPath.startsWith('/monitor/') || urlPath.startsWith('/api/')) && !pinOk(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Napačen PIN');
      return;
    }
    if (remote && urlPath === '/') urlPath = '/remote.html';
    const mon = /^\/monitor\/(\d+)\.mjpg$/.exec(urlPath);
    if (mon) {
      const m = controller.monitors && controller.monitors[mon[1]];
      if (!m) {
        res.writeHead(404).end();
        return;
      }
      const fps = Number(new URL(req.url, 'http://x').searchParams.get('fps')) || 0;
      m.serve(req, res, fps);
      return;
    }
    // HTTP vmesnik za Stream Deck / Bitfocus Companion: /api/cut, /api/auto, /api/action/<ime ali id> ...
    if (urlPath.startsWith('/api/')) {
      handleApi(urlPath.slice(5), res);
      return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    if (urlPath === '/remote') urlPath = '/remote.html';
    // zastave za tabelo oseb (iz predlog napisov)
    const flag = /^\/flags\/([a-z]{2}(?:-[a-z]{2,4})?|[a-z]{2,6})\.svg$/.exec(urlPath);
    const root = flag ? path.join(__dirname, 'gfx', 'flags') : uiDir;
    if (flag) urlPath = `/${flag[1]}.svg`;
    const file = path.normalize(path.join(root, urlPath));
    if (!file.startsWith(path.normalize(root))) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('Ni najdeno');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': flag ? 'max-age=86400' : 'no-store',
      });
      res.end(data);
    });
  };
  const server = http.createServer(handler(false));

  async function handleApi(p, res) {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    try {
      const parts = p.split('/').filter(Boolean);
      if (!parts.length || parts[0] === 'state') return send(200, { ok: true, ...controller.briefState() });
      let cmd = parts[0];
      const find = (list, key) => {
        const k = String(key || '').toLowerCase();
        const hit = list.find((x) => x.id === key) || list.find((x) => x.name.toLowerCase() === k);
        if (!hit) throw new Error(`Ni najdeno: ${key}`);
        return hit.id;
      };
      const st = controller.briefState();
      if (cmd === 'action') cmd = `action:${find(st.actions, parts.slice(1).join('/'))}`;
      else if (cmd === 'group') cmd = `group:${find(st.groups, parts.slice(1).join('/'))}`;
      else if (cmd === 'titles' && parts[1] === 'off') cmd = 'titlesOff';
      else if (cmd === 'overlay' && parts[1] === 'go') cmd = 'ovlGo';
      else if (cmd === 'overlay' && parts[1] === 'off') cmd = 'ovlOff';
      else if (cmd === 'overlay' && parts[1] === 'next') cmd = 'ovlNext';
      else if (cmd === 'overlay' && parts[1] === 'prev') cmd = 'ovlPrev';
      else if (cmd === 'person' && parts[1]) cmd = `person:${parseInt(parts[1], 10)}`;
      else if (cmd === 'preset') {
        // /api/preset/<id> ali /api/preset/<naprava>/<ime preseta>, npr. /api/preset/ATEM/AUTO → Kamera 1
        const key = parts.slice(1).join('/');
        const list = controller.actions ? controller.actions.presets() : [];
        const k = key.toLowerCase();
        const hit = list.find((p) => p.id === key)
          || list.find((p) => `${p.group.replace(/^(ATEM|XR18) /, '')}/${p.label}`.toLowerCase() === k)
          || list.find((p) => p.label.toLowerCase() === k);
        if (!hit) throw new Error(`Ni najdeno: ${key}`);
        cmd = `preset:${hit.id}`;
      }
      else if (cmd === 'title') {
        // /api/title/<ime ali id>[/on|/off|/toggle]
        let rest = parts.slice(1);
        let op = 'toggle';
        if (rest.length > 1 && ['on', 'off', 'toggle'].includes(rest[rest.length - 1])) op = rest.pop();
        const t = controller.findTitle(rest.join('/'));
        if (!t) throw new Error(`Ni najdeno: ${rest.join('/')}`);
        if (op === 'on') await controller.titleOn(t.id);
        else if (op === 'off') await controller.titleOff(t.id);
        else await controller.titleToggle(t.id);
        return send(200, { ok: true });
      }
      await controller.runCommand(cmd);
      return send(200, { ok: true });
    } catch (e) {
      return send(400, { ok: false, error: e.message });
    }
  }

  const wss = new WebSocketServer({ noServer: true });
  const onUpgrade = (remote) => (req, sock, head) => {
    let p = '';
    try {
      p = new URL(req.url || '/', 'http://x').pathname;
    } catch { /* neveljaven naslov */ }
    if (p !== '/ws' || (remote && !pinOk(req))) {
      sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      sock.destroy();
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      ws.remote = remote;
      wss.emit('connection', ws, req);
    });
  };
  server.on('upgrade', onUpgrade(false));

  // Strežnik za tablico (vklopi se v nastavitvah).
  let lan = null;
  let lanError = '';
  const syncLan = () => {
    const want = !!controller.settings.lanRemote && !!controller.settings.lanPin;
    if (want && !lan) {
      const s = http.createServer(handler(true));
      s.on('upgrade', onUpgrade(true));
      lan = s;
      s.once('error', (e) => {
        lanError = e.code === 'EADDRINUSE' ? `Vrata ${lanPort} so zasedena` : e.message;
        if (lan === s) lan = null;
        controller.engine._log(`Tablica: ${lanError}`);
      });
      s.listen(lanPort, '0.0.0.0', () => {
        lanError = '';
        controller.engine._log(`Tablica: upravljanje prek omrežja vklopljeno (vrata ${lanPort})`);
      });
    } else if (!want && lan) {
      const s = lan;
      lan = null;
      for (const c of wss.clients) if (c.remote) c.terminate();
      s.close();
      controller.engine._log('Tablica: upravljanje prek omrežja izklopljeno');
    }
  };
  const lanInfo = () => ({
    enabled: !!controller.settings.lanRemote,
    running: !!lan && lan.listening,
    port: lanPort,
    pin: controller.settings.lanPin || '',
    urls: lanAddresses().map((a) => ({ name: a.name, url: `http://${a.address}:${lanPort}/` })),
    error: lanError,
    clients: [...wss.clients].filter((c) => c.remote).length,
  });

  const actions = {
    'state.get': () => controller.getState(),
    'engine.log': () => controller.engine.logLines,
    'engine.restart': () => controller.engine.restart(controller.engineOptions()),
    'displays.refresh': () => controller.refreshDisplays().then(() => true),
    'settings.update': (a) => controller.updateSettings(a || {}),
    'audio.devices': (a) => controller.setAudioDevices(a && a.devices),
    'library.addPaths': (a) => controller.importFiles((a && a.paths) || [], a && a.folder),
    'library.moveTo': (a) => controller.moveMedia(a.id, a.folder),
    'library.newFolder': (a) => controller.createFolder(a.parent, a.name),
    'project.switch': (a) => controller.switchProject(a.id),
    'project.create': (a) => controller.createProject(a && a.name),
    'project.rename': (a) => controller.renameProject(a.id, a.name),
    'project.remove': (a) => controller.removeProject(a.id),
    'library.remove': (a) => controller.removeItem(a.id),
    'library.move': (a) => controller.moveItem(a.id, a.index),
    'program.play': (a) => controller.play(a.id),
    'program.direct': (a) => controller.playDirect(a.id, a.kind, a.entryId),
    'program.clear': (a) => controller.clearProgram(!!(a && a.fade)),
    'media.volume': (a) => controller.setLook(a.which, { volumeDb: a.db }),
    'seek': (a) => controller.seek(a.which, a.seconds),
    'step': (a) => controller.step(a.which, a.delta),
    'playPause': (a) => controller.playPause(a.which, a.play),
    'media.mute': (a) => controller.setLook(a.which, { muted: a.muted }),
    'media.transform': (a) => controller.setLook(a.which || 'preview', a.patch),
    'entry.look': (a) => controller.setEntryLook(a.entryId, a.patch),
    'entry.layers.add': (a) => controller.addEntryLayer(a.entryId, a.mediaId),
    'entry.layers.set': (a) => controller.setEntryLayer(a.entryId, a.layerId, a.patch),
    'entry.layers.remove': (a) => controller.removeEntryLayer(a.entryId, a.layerId),
    'entry.layers.move': (a) => controller.moveEntryLayer(a.entryId, a.layerId, a.dir),
    'layers.add': (a) => controller.addLayer(a.which || 'preview', a.mediaId),
    'layers.set': (a) => controller.setLayer(a.which || 'preview', a.layerId, a.patch),
    'layers.remove': (a) => controller.removeLayer(a.which || 'preview', a.layerId),
    'layers.move': (a) => controller.moveLayer(a.which || 'preview', a.layerId, a.dir),
    'actions.run': (a) => controller.runAction(a.id),
    'actions.saveDevice': (a) => controller.actions.saveDevice(a.device),
    'actions.removeDevice': (a) => controller.actions.removeDevice(a.id),
    'actions.save': (a) => controller.actions.saveAction(a.action),
    'actions.remove': (a) => controller.actions.removeAction(a.id),
    'actions.move': (a) => controller.actions.moveAction(a.id, a.index),
    'program.panic': (a) => controller.setPanic(!!(a && a.on)),
    'preview.load': (a) => controller.loadPreview(a.id, a.entryId),
    'playlist.addGroup': (a) => controller.addGroup(a && a.name),
    'playlist.slideshow': (a) => controller.createSlideshow(a || {}),
    'playlist.removeGroup': (a) => controller.removeGroup(a.groupId),
    'playlist.setGroup': (a) => controller.setGroup(a.groupId, a.patch),
    'playlist.moveGroup': (a) => controller.moveGroup(a.groupId, a.index),
    'playlist.add': (a) => controller.addToGroup(a.groupId, a.mediaIds, a.index),
    'playlist.addAction': (a) => controller.addActionEntry(a.groupId, a.actionId, a.index),
    'playlist.addTitle': (a) => controller.addTitleEntry(a.groupId, a.spec, a.index),
    'playlist.fireEntry': (a) => controller.fireTitleEntry(a.entryId),
    'ovl.add': (a) => controller.addOverlay(a.spec, a.index),
    'ovl.set': (a) => controller.setOverlay(a.id, a.patch),
    'ovl.remove': (a) => controller.removeOverlay(a.id),
    'ovl.move': (a) => controller.moveOverlay(a.id, a.index),
    'ovl.next': (a) => controller.setOverlayNext(a.id),
    'ovl.go': (a) => controller.overlayGo((a && a.id) || null),
    'ovl.off': (a) => controller.overlayOff((a && a.id) || null),
    'ovl.step': (a) => controller.overlayStep(a.dir),
    'ovl.source': (a) => controller.setGfxSource(a.src),
    'ovl.tableTitle': (a) => controller.setTable(a.id, { titleId: a.titleId || null }),
    'tables.addTitle': (a) => controller.addTableTitle(a.id),
    'tables.add': (a) => controller.addTable(a && a.name),
    'tables.remove': (a) => controller.removeTable(a.id),
    'tables.active': (a) => controller.setActiveTable(a.id),
    'tables.set': (a) => controller.setTable(a.id, a.patch),
    'tables.addColumn': (a) => controller.addColumn(a.id, a.name, a.kind),
    'tables.setColumn': (a) => controller.setColumn(a.id, a.colId, a.patch),
    'tables.removeColumn': (a) => controller.removeColumn(a.id, a.colId),
    'tables.moveColumn': (a) => controller.moveColumn(a.id, a.colId, a.index),
    'tables.addRows': (a) => controller.addRows(a.id, a.count, a.index),
    'tables.removeRows': (a) => controller.removeRows(a.id, a.rowIds),
    'tables.moveRow': (a) => controller.moveRow(a.id, a.rowId, a.index),
    'tables.setCells': (a) => controller.setCells(a.id, a.cells),
    'tables.cue': (a) => controller.cueRow(a || {}),
    'tables.uncue': () => controller._uncueRow(),
    'playlist.removeEntry': (a) => controller.removeEntry(a.entryId),
    'playlist.moveEntry': (a) => controller.moveEntry(a.entryId, a.groupId, a.index),
    'playlist.setEntry': (a) => controller.setEntry(a.entryId, a.patch),
    'preview.mark': (a) => controller.markPreview(a.which, !!a.clear),
    'playlist.cueGroup': (a) => controller.cueGroup(a.groupId),
    'preview.clear': () => controller.clearPreview(),
    'titles.add': (a) => controller.addTitle((a && a.patch) || {}, a && a.after),
    'titles.set': (a) => controller.setTitle(a.id, a.patch),
    'titles.remove': (a) => controller.removeTitle(a.id),
    'titles.move': (a) => controller.moveTitle(a.id, a.index),
    'titles.on': (a) => controller.titleOn(a.id),
    'titles.off': (a) => controller.titleOff(a.id),
    'titles.toggle': (a) => controller.titleToggle(a.id),
    'titles.allOff': () => controller.titlesAllOff(),
    'titles.preview': (a) => controller.titlePreview(a && a.id),
    'brand.set': (a) => controller.setBrand(a.patch),
    'titles.rescan': () => controller.rescanTemplates(),
    'titles.openTemplates': () => controller.userTemplatesFolder(),
    'lan.info': () => lanInfo(),
    'remote.command': (a) => controller.runCommand(a.cmd),
    'atem.run': (a) => {
      if (!controller.actions) throw new Error('Naprave niso na voljo');
      return controller.actions.deviceRun(a.deviceId, a.step || {});
    },
    'device.run': (a) => {
      if (!controller.actions) throw new Error('Naprave niso na voljo');
      return controller.actions.deviceRun(a.deviceId, a.step || {});
    },
    'ptz.move': (a) => {
      if (!controller.actions) throw new Error('Naprave niso na voljo');
      return controller.actions.ptzMove(a.deviceId, a.cam, a.pan, a.tilt, a.zoom);
    },
    'ptz.ports': async () => (await require('./devices/ptz').listSerial()).map((p) => ({
      path: p.path, name: p.friendlyName || p.manufacturer || '', esp: String(p.vendorId || '').toLowerCase() === '303a',
    })),
    'take.cut': () => controller.take('cut'),
    'take.auto': () => controller.take('auto'),
    ...extraActions,
  };

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) {
      if (c.readyState === 1) c.send(data);
    }
  }

  controller.on('state', (state) => {
    syncLan();
    broadcast({ type: 'state', state });
  });
  controller.on('times', (times) => broadcast({ type: 'times', times }));
  controller.on('devLive', (a) => broadcast({ type: 'dev', id: a.id, live: a.live }));
  if (sysload) sysload.on('update', (load) => broadcast({ type: 'load', load: { ...load, engine: controller.engineRate() } }));
  controller.engine.on('log', (line) => broadcast({ type: 'log', line }));

  wss.on('connection', (ws, req) => {
    ws.isLocal = !ws.remote;
    ws.send(JSON.stringify({ type: 'state', state: controller.getState() }));

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const { id, action, args } = msg;
      const fn = ws.remote && !REMOTE_ACTIONS.has(action) ? null : actions[action];
      if (!fn) {
        ws.send(JSON.stringify({ type: 'reply', id, ok: false, error: `Neznan ukaz: ${action}` }));
        return;
      }
      try {
        const data = await fn(args, ws);
        ws.send(JSON.stringify({ type: 'reply', id, ok: true, data: data === undefined ? null : data }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'reply', id, ok: false, error: e.message }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      syncLan();
      resolve({ server, wss, port: server.address().port, lanInfo, closeLan: () => { if (lan) lan.close(); lan = null; } });
    });
  });
}

module.exports = { createServer, LAN_PORT, REMOTE_ACTIONS, lanAddresses };
