/**
 * Dev tool: renders a page inside a hidden, offscreen Electron window (the real Electron runtime,
 * never shown on screen) and saves PNG screenshots. Each run gets throwaway storage, so demo data
 * starts fresh.
 *
 * Run it with plain Node (recommended; it starts Electron for you with a clean environment):
 *
 *   node scripts/capture.cjs --url http://localhost:5187 --out shot.png
 *   node scripts/capture.cjs --url http://localhost:5187 --steps steps.json [--dark] [--width 1280 --height 820]
 *   node scripts/capture.cjs --url file:///C:/path/page.html --out icon.png --width 1024 --height 1024 --transparent
 *
 * Or directly with Electron, using the --key=value form for any URL:
 *
 *   npx electron scripts/capture.cjs --url=http://localhost:5187 --out=shot.png
 *
 * Why: on Windows, Electron refuses to start (silently, exit code 127, before any script runs)
 * when a bare URL-like argument such as `http://...` or `localhost:5173` is followed by another
 * plain argument -- its guard against protocol-handler argument injection. `--url=http://...`
 * is a single switch and is accepted. The Node launcher below rewrites arguments into that form.
 *
 * Options:
 *   --url <url>        page to load (default http://localhost:5187)
 *   --out <file>       screenshot path when no --steps are given (default shot.png)
 *   --steps <file>     JSON: [{ "js": "<code; may await; return value is printed>", "wait": 400, "shot": "file.png" }]
 *   --dark             emulate the dark colour scheme (nativeTheme.themeSource = 'dark')
 *   --width/--height   content size in CSS px (default 1280 x 820)
 *   --wait <ms>        delay after load before the first step (default 900)
 *   --transparent      transparent window background (for rendering icons)
 *   --timeout <ms>     hard limit for the whole run (default 120000)
 * Exit code: 0 ok, 1 a step/load failed, 2 timeout.
 */
'use strict';

const path = require('path');

// ---------------------------------------------------------------------------
// Launcher mode: running under plain Node -> spawn Electron with safe args.
// ---------------------------------------------------------------------------
if (!process.versions.electron) {
  const { spawn } = require('child_process');
  let electronPath;
  try {
    electronPath = require('electron'); // the electron npm package exports the binary path under Node
  } catch (err) {
    console.error('Cannot find the electron package: ' + (err && err.message ? err.message : err));
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && !a.includes('=') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      args.push(a + '=' + argv[i + 1]);
      i++;
    } else {
      args.push(a);
    }
  }
  const env = { ...process.env };
  // Inherited from a parent Electron-based app, these make the child misbehave.
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_FORCE_IS_PACKAGED', 'CHROME_CRASHPAD_PIPE_NAME']) delete env[k];
  const child = spawn(electronPath, [__filename, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
  child.stdout.pipe(process.stdout);
  child.stderr.on('data', (d) => {
    // Chromium's own noise (GPU / network-service lines) is not interesting.
    const text = String(d)
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^\[\d+:\d+\/\d+\.\d+:(ERROR|WARNING|INFO):/.test(l))
      .join('\n');
    if (text) process.stderr.write(text + '\n');
  });
  child.on('exit', (code, signal) => {
    if (code === 127) console.error('Electron refused the command line (exit 127). Pass URLs as --url=<url>.');
    process.exit(code === null ? (signal ? 1 : 0) : code);
  });
  return;
}

// ---------------------------------------------------------------------------
// Electron mode.
// ---------------------------------------------------------------------------
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');

function arg(name, fallback) {
  const eq = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes('--' + name) || process.argv.includes('--' + name + '=true');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const url = arg('url', 'http://localhost:5187');
const out = arg('out', 'shot.png');
const width = Number(arg('width', 1280));
const height = Number(arg('height', 820));
const stepsFile = arg('steps');
const initialWait = Number(arg('wait', 900));
const transparent = has('transparent');
const hardTimeout = Number(arg('timeout', 120000));

const tmpProfile = path.join(os.tmpdir(), 'questlabs-capture-' + process.pid);
app.setPath('userData', tmpProfile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');

setTimeout(() => {
  console.log('capture timed out after ' + hardTimeout + 'ms');
  app.exit(2);
}, hardTimeout).unref();

app.whenReady().then(async () => {
  nativeTheme.themeSource = has('dark') ? 'dark' : 'light';
  const win = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    frame: false,
    transparent,
    backgroundColor: transparent ? '#00000000' : undefined,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(30);

  // capturePage() fails with "UnknownVizError" until the first frame has been produced,
  // so remember the newest painted frame and wait for one before capturing.
  let lastFrame = null;
  let frames = 0;
  win.webContents.on('paint', (_e, _dirty, image) => {
    lastFrame = image;
    frames++;
  });

  const problems = [];
  // Electron 45: the details live on the event object (positional args are deprecated).
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') problems.push(String(event.message));
  });
  win.webContents.on('render-process-gone', (_e, details) => problems.push('renderer gone: ' + details.reason));

  const shoot = async (file) => {
    const start = Date.now();
    while (frames === 0 && Date.now() - start < 5000) await wait(50);
    let image = null;
    for (let attempt = 0; attempt < 5 && !image; attempt++) {
      try {
        image = await win.webContents.capturePage();
        if (image.isEmpty()) image = null;
      } catch {
        await wait(150);
      }
    }
    if (!image) image = lastFrame;
    if (!image) throw new Error('no frame was painted');
    const target = path.resolve(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, image.toPNG());
    console.log('saved ' + target);
  };

  let exitCode = 0;
  try {
    await win.loadURL(url);
    await wait(initialWait);
    if (stepsFile) {
      const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
      for (const [i, step] of steps.entries()) {
        if (step.js) {
          try {
            const result = await win.webContents.executeJavaScript(`(async () => { ${step.js} })()`, true);
            if (result !== undefined && result !== null) console.log(`step ${i + 1} result: ${JSON.stringify(result)}`);
          } catch (err) {
            exitCode = 1;
            console.log(`step ${i + 1} FAILED: ${err && err.message ? err.message : err}`);
          }
        }
        await wait(step.wait ?? 400);
        if (step.shot) await shoot(step.shot);
      }
    } else {
      await shoot(out);
    }
  } catch (err) {
    exitCode = 1;
    console.log('capture failed: ' + (err && err.message ? err.message : err));
  }
  if (problems.length) console.log('page errors:\n  ' + problems.join('\n  '));
  try {
    fs.rmSync(tmpProfile, { recursive: true, force: true });
  } catch {
    /* in use until exit; harmless */
  }
  app.exit(exitCode);
});
