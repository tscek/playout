'use strict';
// Vstopna točka aplikacije (Electron glavni proces).

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, dialog, ipcMain, session, shell, screen, globalShortcut } = require('electron');
const { Engine } = require('./engine/engine');
const { listDisplays } = require('./engine/displays');
const { Controller } = require('./controller');
const { ActionManager } = require('./actions');
const { ChannelMonitor } = require('./engine/monitor');
const { OscListener } = require('./engine/osc');
const { createServer } = require('./server');
const { ALL_EXT } = require('./media');
const { SysLoad } = require('./sysload');

const UI_PORT = 8088;

// Samo ena kopija aplikacije naenkrat (dva motorja bi se tepla za izhode).
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let controller = null;
let uiUrl = '';
let quitting = false;

function resourcesDir() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
}

function casparDir() {
  if (process.env.PLAYOUT_CASPAR_DIR) return process.env.PLAYOUT_CASPAR_DIR;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'casparcg')
    : path.join(__dirname, '..', 'vendor', 'casparcg');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#111317',
    title: 'Playout',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // vmesnik mora biti odziven tudi v ozadju
    },
  });
  mainWindow.loadURL(uiUrl);

  // Če se vmesnik sesuje, ga samo znova naložimo. Motor in program tečeta naprej.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('Vmesnik se je sesul:', details.reason);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(uiUrl);
    }, 500);
  });

  // Zunanje povezave odpremo v brskalniku, ne v aplikaciji.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    if (quitting) return;
    const onAir = controller && controller.program.item;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Prekliči', 'Zapri Playout'],
      defaultId: 0,
      cancelId: 0,
      title: 'Zapri Playout',
      message: onAir
        ? `Na programu je "${controller.program.item.name}". Če zapreš aplikacijo, se izhod ustavi.`
        : 'Ali res želiš zapreti Playout? Izhodi se bodo ugasnili.',
    });
    if (choice !== 1) {
      e.preventDefault();
      return;
    }
    quitting = true;
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  // Dovolimo branje imen zvočnih naprav (za izbiro izhoda).
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));

  const dataDir = app.getPath('userData');
  const engineDir = path.join(dataDir, 'engine');
  fs.mkdirSync(engineDir, { recursive: true });

  const engine = new Engine({ casparDir: casparDir(), workDir: engineDir });
  controller = new Controller({
    engine,
    dataDir,
    listDisplays: () => listDisplays(screen),
    monitors: { 1: new ChannelMonitor(1), 2: new ChannelMonitor(2) },
    osc: new OscListener(0),
    templateDir: path.join(engineDir, 'templates'),
    actions: new ActionManager({ file: path.join(dataDir, 'actions.json'), log: (l) => engine._log(l) }),
    trashItem: (p) => shell.trashItem(p),
  });

  const extraActions = {
    'library.pickFiles': async (a) => {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Dodaj medije',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Mediji', extensions: ALL_EXT },
          { name: 'Vse datoteke', extensions: ['*'] },
        ],
      });
      if (res.canceled) return 0;
      return controller.importFiles(res.filePaths, a && a.folder);
    },
    'project.pickFolder': async () => {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Medijska mapa projekta',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: controller.project.mediaDir || undefined,
      });
      if (res.canceled || !res.filePaths.length) return null;
      controller.setMediaDir(res.filePaths[0]);
      return res.filePaths[0];
    },
    'project.export': async () => {
      const safe = controller.project.name.replace(/[<>:"/\\|?*]/g, '').trim() || 'projekt';
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'Izvozi projekt',
        defaultPath: path.join(controller.project.mediaDir || app.getPath('documents'), `${safe}.playout`),
        filters: [{ name: 'Projekt Playout', extensions: ['playout'] }],
      });
      if (res.canceled || !res.filePath) return null;
      return controller.exportProject(res.filePath);
    },
    'project.import': async () => {
      const f = await dialog.showOpenDialog(mainWindow, {
        title: 'Uvozi projekt',
        properties: ['openFile'],
        filters: [{ name: 'Projekt Playout', extensions: ['playout'] }],
      });
      if (f.canceled || !f.filePaths.length) return null;
      const d = await dialog.showOpenDialog(mainWindow, {
        title: 'Kje so mediji tega projekta? Izberi medijsko mapo',
        properties: ['openDirectory'],
        defaultPath: path.dirname(f.filePaths[0]),
      });
      if (d.canceled || !d.filePaths.length) return null;
      return controller.importProject(f.filePaths[0], d.filePaths[0]);
    },
    'app.openLogs': () => shell.openPath(path.join(engineDir, 'logs')),
    'app.info': () => ({
      version: app.getVersion(),
      dataDir,
      casparDir: casparDir(),
      testMedia: path.join(resourcesDir(), app.isPackaged ? 'test-media' : 'assets/test-media'),
    }),
    'library.addTestMedia': () => {
      const dir = path.join(resourcesDir(), app.isPackaged ? 'test-media' : 'assets/test-media');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => path.join(dir, f)) : [];
      return controller.importFiles(files);
    },
  };

  const sysload = new SysLoad();
  sysload.start();
  app.on('will-quit', () => sysload.stop());
  let srv;
  try {
    srv = await createServer({ controller, uiDir: path.join(__dirname, '..', 'ui'), port: UI_PORT, extraActions, sysload });
  } catch {
    // Vrata so zasedena: uporabimo poljubna prosta.
    srv = await createServer({ controller, uiDir: path.join(__dirname, '..', 'ui'), port: 0, extraActions, sysload });
  }
  uiUrl = `http://127.0.0.1:${srv.port}/`;

  ipcMain.handle('app:isDesktop', () => true);

  // Globalne bližnjice (delujejo tudi, ko okno ni v ospredju): samo F-tipke in kombinacije s Ctrl/Alt.
  let hotkeySig = '';
  const applyGlobalHotkeys = () => {
    const st = controller.settings;
    const sig = JSON.stringify([st.globalHotkeys, st.hotkeys]);
    if (sig === hotkeySig) return;
    hotkeySig = sig;
    globalShortcut.unregisterAll();
    if (!st.globalHotkeys) return;
    const failed = [];
    for (const [cmd, acc] of Object.entries(st.hotkeys || {})) {
      if (!acc || !/(^|\+)(F\d{1,2})$|Ctrl\+|Alt\+|CommandOrControl\+/.test(acc)) continue;
      try {
        const ok = globalShortcut.register(acc, () => {
          controller.runCommand(cmd).catch((e) => engine._log(`Bližnjica ${acc}: ${e.message}`));
        });
        if (!ok) failed.push(acc);
      } catch {
        failed.push(acc);
      }
    }
    if (failed.length) engine._log(`Globalnih bližnjic ni bilo mogoče nastaviti (zasedene?): ${failed.join(', ')}`);
  };
  controller.on('state', applyGlobalHotkeys);
  applyGlobalHotkeys();
  app.on('will-quit', () => globalShortcut.unregisterAll());

  createWindow();
  controller.init().catch((e) => console.error(e));
});

app.on('before-quit', () => {
  quitting = true;
});

let engineStopped = false;
app.on('will-quit', (e) => {
  if (engineStopped || !controller) return;
  e.preventDefault();
  Promise.all([controller.engine.stop(), controller.actions ? controller.actions.stop() : null])
    .catch(() => {})
    .finally(() => {
      engineStopped = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  app.quit();
});
