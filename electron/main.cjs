'use strict';
// Electron main process. Plain CommonJS, no build step.
//
// Dev:   start Vite, then `VITE_DEV_SERVER_URL=http://localhost:5173 electron .`
// Prod:  loads dist/index.html (run `npm run build` first).
//
// Hidden smoke test (never shows a window; for CI / reviewers):
//   QL_SMOKE=1                      enable smoke mode
//   QL_SMOKE_OUT=path/shot.png      where to save a screenshot (optional)
//   QL_SMOKE_WAIT=2500              ms to wait after load before checking (optional)
//   QL_SMOKE_EXPECT="Sign in"       text that must appear on the page (optional)
//   QL_SMOKE_JS="..."               script run in the page after the wait; its result is printed (optional)
//   QL_SMOKE_JS_WAIT=5000           ms to wait after QL_SMOKE_JS before the screenshot (optional)
//   QL_SMOKE_JS_AFTER="..."         script run after that wait; its result is printed (optional)
// The app is light-only: the colour scheme is always forced to light.
// Exit code: 0 ok, 1 load failure / renderer crash / blank page / missing text, 3 timeout.
//
// Updates (packaged builds only; never in dev or smoke mode): see setupUpdater() below.
const { app, BrowserWindow, Menu, shell, session, screen, nativeTheme, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_NAME = 'Quest Labs Dialer';
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const SMOKE = process.env.QL_SMOKE === '1';
const MIN_WIDTH = 1000;
const MIN_HEIGHT = 680;
/** Height of the strip the window buttons sit in; keep in sync with --titlebar-height in theme.css. */
const TITLEBAR_HEIGHT = 30;

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.questlabs.dialer');

if (SMOKE) {
  // Throwaway profile: fresh demo data, and no clash with a real running instance.
  app.setPath('userData', path.join(os.tmpdir(), 'questlabs-smoke-' + process.pid));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
}

/** @type {BrowserWindow | null} */
let mainWindow = null;

const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Light-only app: ignore the OS dark mode (prefers-color-scheme is always "light").
    nativeTheme.themeSource = 'light';
    setupPermissions();
    setupMenu();
    if (SMOKE) {
      runSmoke().catch((err) => smokeExit(1, 'smoke error: ' + (err && err.message ? err.message : err)));
      return;
    }
    createWindow();
    setupUpdater();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || SMOKE) app.quit();
  });
}

// ---------------------------------------------------------------------------
// Permissions: only the microphone, nothing else (no camera, location, notifications...).
// ---------------------------------------------------------------------------
function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission !== 'media') return callback(false);
    // The embedded booking page never gets the microphone.
    if (details && details.requestingUrl && isCalendlyUrl(details.requestingUrl)) return callback(false);
    const types = (details && details.mediaTypes) || [];
    callback(types.length > 0 && types.every((t) => t === 'audio'));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (permission !== 'media') return false;
    if (origin && isCalendlyUrl(origin)) return false;
    return !details || !details.mediaType || details.mediaType === 'audio';
  });
  ses.setDevicePermissionHandler(() => false);
}

// ---------------------------------------------------------------------------
// Menu: none on Windows/Linux (no browser feel); minimal native menu on macOS.
// ---------------------------------------------------------------------------
function setupMenu() {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
}

// ---------------------------------------------------------------------------
// Window state (size / position / maximized) remembered between runs.
// ---------------------------------------------------------------------------
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  const fallback = { width: 1280, height: 820 };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const width = Math.max(MIN_WIDTH, Number(s.width) || fallback.width);
    const height = Math.max(MIN_HEIGHT, Number(s.height) || fallback.height);
    const state = { width, height, maximized: !!s.maximized };
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      // Only restore the position if it is still on a connected display.
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return s.x + 80 > a.x && s.y + 40 > a.y && s.x < a.x + a.width - 80 && s.y < a.y + a.height - 40;
      });
      if (visible) Object.assign(state, { x: s.x, y: s.y });
    }
    return state;
  } catch {
    return fallback;
  }
}

function trackWindowState(win) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    try {
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized }));
    } catch {
      /* non-fatal */
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on('resize', later);
  win.on('move', later);
  win.on('close', () => {
    clearTimeout(timer);
    save();
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function iconPath() {
  const p = path.join(__dirname, '..', 'build', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

function isAppUrl(url) {
  if (DEV_URL && url.startsWith(DEV_URL)) return true;
  return url.startsWith('file://');
}

function isExternal(url) {
  return !isAppUrl(url) && /^(https?:|mailto:|tel:)/i.test(url);
}

// ---------------------------------------------------------------------------
// Embedded pages: the only site the app itself may put in an <iframe> is Calendly (booking modal).
// Frames *inside* the Calendly page (its own widgets, captcha, payment) are Calendly's business and
// are allowed as long as they are https. Everything else is blocked.
// ---------------------------------------------------------------------------
function isCalendlyUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'calendly.com' || u.hostname.endsWith('.calendly.com'));
  } catch {
    return false;
  }
}

function isBlankFrameUrl(url) {
  return url === 'about:blank' || url === 'about:srcdoc';
}

/** Decides whether a sub-frame may navigate to `url`. `parentUrl` is the frame's parent document URL. */
function allowSubframe(url, parentUrl) {
  if (isBlankFrameUrl(url)) return true;
  // Direct children of our own page: Calendly only.
  if (!parentUrl || isAppUrl(parentUrl)) return isCalendlyUrl(url);
  // Nested inside an embedded page: https only.
  return /^https:/i.test(url);
}

function buildWindow({ hidden, width, height, x, y }) {
  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: APP_NAME,
    icon: iconPath(),
    show: false,
    useContentSize: !!hidden,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    // No title bar: the page runs to the top edge and the window buttons float over it
    // (Windows: overlaid at the top right; macOS: traffic lights inset at the top left).
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: { color: '#ffffff', symbolColor: '#2f2e2b', height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Call timers and audio must keep running while the window is behind others.
      backgroundThrottling: false,
      offscreen: !!hidden,
    },
  });

  // Keep our own title (the page cannot rename the window).
  win.on('page-title-updated', (e) => e.preventDefault());

  // Tell the page it has no title bar, so its CSS leaves a draggable strip for the window buttons.
  win.webContents.on('dom-ready', () => {
    win.webContents
      .executeJavaScript(`document.documentElement.classList.add('frameless', 'platform-${process.platform}')`)
      .catch(() => {});
  });

  // External links open in the system browser, never inside the app. This also covers links that an
  // embedded page (Calendly) opens in a new window or tab.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isExternal(url)) shell.openExternal(url);
  });
  // Sub-frames (iframes): Calendly only for our own page; see allowSubframe().
  win.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return; // handled by will-navigate above
    let parentUrl = null;
    try {
      parentUrl = event.frame && event.frame.parent ? event.frame.parent.url : null;
    } catch {
      parentUrl = null;
    }
    if (!allowSubframe(event.url, parentUrl)) {
      event.preventDefault();
      if (SMOKE || DEV_URL) console.log('blocked frame navigation: ' + event.url);
    }
  });

  // Developer tools only in development.
  win.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key).toLowerCase();
    const devtools = (input.control || input.meta) && input.shift && key === 'i';
    if (devtools || key === 'f12') {
      if (DEV_URL) win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  return win;
}

function loadApp(win) {
  if (DEV_URL) return win.loadURL(DEV_URL);
  return win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function createWindow() {
  const state = loadWindowState();
  mainWindow = buildWindow({ hidden: false, ...state });
  trackWindowState(mainWindow);
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    if (state.maximized) mainWindow.maximize();
    mainWindow.show();
  });
  loadApp(mainWindow).catch(() => {
    /* did-fail-load shows Chromium's error page; nothing else to do */
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Smoke mode
// ---------------------------------------------------------------------------
function smokeExit(code, message) {
  console.log(message);
  try {
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
  } catch {
    /* in use; harmless */
  }
  app.exit(code);
}

async function runSmoke() {
  const timeout = setTimeout(() => smokeExit(3, 'SMOKE FAIL: timed out'), 60000);
  nativeTheme.themeSource = 'light';
  const win = buildWindow({ hidden: true, width: 1280, height: 820 });
  mainWindow = win;
  const problems = [];
  let fatal = null;
  let frames = 0;
  win.webContents.on('paint', () => frames++);
  win.webContents.setFrameRate(30);
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) fatal = `load failed: ${desc} (${code}) ${url}`;
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    fatal = 'renderer crashed: ' + d.reason;
  });
  win.webContents.on('preload-error', (_e, p, err) => problems.push('preload error ' + p + ': ' + err.message));
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') problems.push(String(event.message));
  });

  const target = DEV_URL || 'file://' + path.join(__dirname, '..', 'dist', 'index.html');
  try {
    await loadApp(win);
  } catch (err) {
    fatal = fatal || 'load failed: ' + (err && err.message ? err.message : err);
  }
  await new Promise((r) => setTimeout(r, Number(process.env.QL_SMOKE_WAIT) || 2500));

  let info = null;
  if (!fatal) {
    info = await win.webContents.executeJavaScript(
      `({ title: document.title, text: (document.getElementById('root') || document.body).innerText.slice(0, 400),
          nodes: document.getElementById('root') ? document.getElementById('root').querySelectorAll('*').length : 0,
          desktop: !!window.desktop, version: window.desktop ? window.desktop.version : null,
          overlay: (() => { const o = document.querySelector('vite-error-overlay'); const m = o && o.shadowRoot && o.shadowRoot.querySelector('.message');
                            return o ? (m ? m.textContent : 'Vite error overlay shown') : null; })() })`,
      true,
    );
    if (info.overlay) fatal = 'dev server compile error: ' + info.overlay.replace(/\s+/g, ' ').slice(0, 300);
    else if (!info.nodes) fatal = 'blank page: #root rendered nothing';
    const expect = process.env.QL_SMOKE_EXPECT;
    if (!fatal && expect && !info.text.includes(expect)) fatal = `expected text not found: "${expect}"`;
    if (!fatal && !info.desktop) fatal = 'preload bridge (window.desktop) missing';
    const js = process.env.QL_SMOKE_JS;
    if (!fatal && js) {
      try {
        const result = await win.webContents.executeJavaScript(`(async () => { ${js} })()`, true);
        console.log('js result: ' + JSON.stringify(result));
      } catch (err) {
        problems.push('QL_SMOKE_JS failed: ' + (err && err.message ? err.message : err));
      }
      await new Promise((r) => setTimeout(r, Number(process.env.QL_SMOKE_JS_WAIT) || 0));
      const js2 = process.env.QL_SMOKE_JS_AFTER;
      if (js2) {
        try {
          console.log('js after: ' + JSON.stringify(await win.webContents.executeJavaScript(`(async () => { ${js2} })()`, true)));
        } catch (err) {
          problems.push('QL_SMOKE_JS_AFTER failed: ' + (err && err.message ? err.message : err));
        }
      }
    }
  }

  const out = process.env.QL_SMOKE_OUT;
  if (out && frames > 0) {
    try {
      const image = await win.webContents.capturePage();
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(path.resolve(out), image.toPNG());
      console.log('screenshot: ' + path.resolve(out));
    } catch (err) {
      problems.push('screenshot failed: ' + (err && err.message ? err.message : err));
    }
  }

  clearTimeout(timeout);
  console.log('loaded: ' + target);
  if (info) console.log('page: ' + JSON.stringify({ title: info.title, nodes: info.nodes, version: info.version, text: info.text.replace(/\s+/g, ' ').slice(0, 160) }));
  if (problems.length) console.log('console errors:\n  ' + problems.join('\n  '));
  if (fatal) smokeExit(1, 'SMOKE FAIL: ' + fatal);
  else smokeExit(0, 'SMOKE OK');
}

// ---------------------------------------------------------------------------
// Updates from GitHub Releases (electron-updater; feed comes from the `build.publish` config).
//
// Windows: checks ~20 s after launch and every 4 hours, downloads in the background, and NEVER
//   restarts by itself (a caller may be on a call). Once downloaded the page shows "Update ready";
//   the update installs when the app quits, or right away when the user clicks Restart.
// macOS: the app is unsigned (ad-hoc), and Squirrel.Mac cannot update unsigned apps, so it only
//   checks; the page then offers a link to the download page in the system browser.
// Every failure (offline, GitHub unreachable, rate limit, no release yet) is logged to the console
// only and never shown to the user.
// ---------------------------------------------------------------------------
const RELEASES_URL = 'https://github.com/questlabsco/questlabs-dialer/releases/latest';
const UPDATES_ENABLED = app.isPackaged && !SMOKE && !DEV_URL;
const CAN_SELF_UPDATE = process.platform === 'win32';
const FIRST_CHECK_DELAY = 20 * 1000;
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;

/** What the page is told: 'none' | 'ready' (downloaded, Windows) | 'available' (download manually, macOS). */
let updateStatus = { state: 'none' };
/** @type {import('electron-updater').AppUpdater | null} */
let updater = null;

function updateLog(level, message) {
  const text = message instanceof Error ? message.message : String(message);
  (level === 'error' ? console.warn : console.log)('[updater] ' + text.split('\n')[0].slice(0, 300));
}

function setUpdateStatus(status) {
  updateStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('desktop:updateStatus', updateStatus);
  }
}

function checkForUpdates() {
  if (!updater || updateStatus.state === 'ready') return;
  updater.checkForUpdates().catch((err) => updateLog('error', err));
}

function setupUpdater() {
  if (!UPDATES_ENABLED) return;
  try {
    updater = require('electron-updater').autoUpdater;
  } catch (err) {
    updateLog('error', err);
    return;
  }
  updater.logger = {
    info: (m) => updateLog('info', m),
    warn: (m) => updateLog('warn', m),
    error: (m) => updateLog('error', m),
    debug: () => {},
  };
  updater.autoDownload = CAN_SELF_UPDATE;
  updater.autoInstallOnAppQuit = CAN_SELF_UPDATE;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.on('error', (err) => updateLog('error', err));
  updater.on('update-available', (info) => {
    if (!CAN_SELF_UPDATE) setUpdateStatus({ state: 'available', version: String(info.version), url: RELEASES_URL });
  });
  updater.on('update-downloaded', (info) => {
    if (CAN_SELF_UPDATE) setUpdateStatus({ state: 'ready', version: String(info.version) });
  });
  setTimeout(checkForUpdates, FIRST_CHECK_DELAY);
  setInterval(checkForUpdates, CHECK_INTERVAL);
}

ipcMain.handle('desktop:updateGetStatus', () => updateStatus);
ipcMain.handle('desktop:updateCheck', () => {
  checkForUpdates();
  return !!updater;
});
ipcMain.handle('desktop:updateRestart', () => {
  // Only when the user asked for it (the page disables the button during a call).
  if (!updater || !CAN_SELF_UPDATE || updateStatus.state !== 'ready') return false;
  setImmediate(() => {
    try {
      // Silent install (keeps the existing install folder), then start the app again.
      updater.quitAndInstall(true, true);
    } catch (err) {
      updateLog('error', err);
    }
  });
  return true;
});

// ---------------------------------------------------------------------------
// IPC for the preload bridge.
// ---------------------------------------------------------------------------
ipcMain.handle('desktop:openExternal', async (_event, url) => {
  if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});
ipcMain.on('desktop:version', (event) => {
  event.returnValue = app.getVersion();
});
