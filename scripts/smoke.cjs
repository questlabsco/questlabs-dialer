/**
 * Runs the REAL app entry point (electron/main.cjs) in its hidden smoke mode and reports the result.
 * Never shows a window. Works the same from PowerShell, cmd and Git Bash.
 *
 *   node scripts/smoke.cjs                                    production build (dist/index.html; run `npm run build` first)
 *   node scripts/smoke.cjs --dev http://localhost:5187        against a running Vite dev server
 *   options: --out shot.png  --wait 2500  --expect "Sign in"  --js "<code>" --js-wait 5000 --js-after "<code>"
 *   (the app is light-only; the old --dark flag is accepted and ignored)
 *
 * Equivalent without this helper (bash):
 *   QL_SMOKE=1 QL_SMOKE_OUT=shot.png [VITE_DEV_SERVER_URL=http://localhost:5187] npx electron .
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

function arg(name) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf('--' + name);
  return i > -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

const env = { ...process.env, QL_SMOKE: '1' };
for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'VITE_DEV_SERVER_URL']) delete env[k];
const dev = arg('dev');
if (dev) env.VITE_DEV_SERVER_URL = dev;
if (arg('out')) env.QL_SMOKE_OUT = path.resolve(arg('out'));
if (arg('wait')) env.QL_SMOKE_WAIT = arg('wait');
if (arg('expect')) env.QL_SMOKE_EXPECT = arg('expect');
// --js "<code>" runs in the page after the wait (result printed); --js-wait <ms>; --js-after "<code>".
if (arg('js')) env.QL_SMOKE_JS = arg('js');
if (arg('js-wait')) env.QL_SMOKE_JS_WAIT = arg('js-wait');
if (arg('js-after')) env.QL_SMOKE_JS_AFTER = arg('js-after');
if (process.argv.includes('--dark')) console.log('note: --dark is ignored (the app is light-only)');
delete env.QL_SMOKE_DARK;

const root = path.join(__dirname, '..');
const child = spawn(require('electron'), [root], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
child.stdout.pipe(process.stdout);
child.stderr.on('data', (d) => {
  const text = String(d)
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\[\d+:\d+\/\d+\.\d+:(ERROR|WARNING|INFO):/.test(l))
    .join('\n');
  if (text) process.stderr.write(text + '\n');
});
child.on('exit', (code) => process.exit(code ?? 1));
