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
function createServer({ controller, uiDir, port, host = '127.0.0.1', extraActions = {} }) {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
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
    'library.addPaths': (a) => controller.addFiles((a && a.paths) || []),
    'library.remove': (a) => controller.removeItem(a.id),
    'library.loop': (a) => controller.setLoop(a.id, a.loop),
    'library.move': (a) => controller.moveItem(a.id, a.index),
    'program.play': (a) => controller.play(a.id),
    'program.clear': () => controller.clearProgram(),
    ...extraActions,
  };

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) {
      if (c.readyState === 1) c.send(data);
    }
  }

  controller.on('state', (state) => broadcast({ type: 'state', state }));
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
