'use strict';
// HTTP + WebSocket strežnik. Isti vmesnik uporablja okno aplikacije in
// (v kasnejšem koraku) tablica prek omrežja.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

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
function createServer({ controller, uiDir, port, host = '127.0.0.1', extraActions = {}, sysload = null }) {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
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
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.normalize(path.join(uiDir, urlPath));
    if (!file.startsWith(path.normalize(uiDir))) {
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
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

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
    'playlist.removeGroup': (a) => controller.removeGroup(a.groupId),
    'playlist.setGroup': (a) => controller.setGroup(a.groupId, a.patch),
    'playlist.moveGroup': (a) => controller.moveGroup(a.groupId, a.index),
    'playlist.add': (a) => controller.addToGroup(a.groupId, a.mediaIds, a.index),
    'playlist.removeEntry': (a) => controller.removeEntry(a.entryId),
    'playlist.moveEntry': (a) => controller.moveEntry(a.entryId, a.groupId, a.index),
    'playlist.setEntry': (a) => controller.setEntry(a.entryId, a.patch),
    'preview.mark': (a) => controller.markPreview(a.which, !!a.clear),
    'playlist.cueGroup': (a) => controller.cueGroup(a.groupId),
    'preview.clear': () => controller.clearPreview(),
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

  controller.on('state', (state) => broadcast({ type: 'state', state }));
  controller.on('times', (times) => broadcast({ type: 'times', times }));
  if (sysload) sysload.on('update', (load) => broadcast({ type: 'load', load: { ...load, engine: controller.engineRate() } }));
  controller.engine.on('log', (line) => broadcast({ type: 'log', line }));

  wss.on('connection', (ws, req) => {
    ws.isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    ws.send(JSON.stringify({ type: 'state', state: controller.getState() }));

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const { id, action, args } = msg;
      const fn = actions[action];
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
    server.listen(port, host, () => resolve({ server, wss, port: server.address().port }));
  });
}

module.exports = { createServer };
