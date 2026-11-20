'use strict';
// Vstopna točka aplikacije (Electron glavni proces).

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const { Engine } = require('./engine/engine');
const { listDisplays } = require('./engine/displays');
const { Controller } = require('./controller');
const { createServer } = require('./server');
const { ALL_EXT } = require('./media');

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
    listDisplays,
    templateDir: path.join(engineDir, 'templates'),
  });

  const extraActions = {
    'library.pickFiles': async () => {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Dodaj medije',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Mediji', extensions: ALL_EXT },
          { name: 'Vse datoteke', extensions: ['*'] },
        ],
      });
      if (res.canceled) return 0;
      return controller.addFiles(res.filePaths);
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
      return controller.addFiles(files);
    },
  };

  let srv;
  try {
    srv = await createServer({ controller, uiDir: path.join(__dirname, '..', 'ui'), port: UI_PORT, extraActions });
  } catch {
    // Vrata so zasedena: uporabimo poljubna prosta.
    srv = await createServer({ controller, uiDir: path.join(__dirname, '..', 'ui'), port: 0, extraActions });
  }
  uiUrl = `http://127.0.0.1:${srv.port}/`;

  ipcMain.handle('app:isDesktop', () => true);

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
  controller.engine
    .stop()
    .catch(() => {})
    .finally(() => {
      engineStopped = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  app.quit();
});
