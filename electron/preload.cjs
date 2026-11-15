'use strict';
// Preload: exposes a tiny, safe bridge as `window.desktop`.
const { contextBridge, ipcRenderer } = require('electron');

let version = '0.0.0';
try {
  version = ipcRenderer.sendSync('desktop:version');
} catch {
  /* ignore */
}

/** Copies only the known fields of an update status, so nothing else crosses the bridge. */
function cleanStatus(s) {
  if (s && s.state === 'ready') return { state: 'ready', version: String(s.version) };
  if (s && s.state === 'available') return { state: 'available', version: String(s.version), url: String(s.url) };
  return { state: 'none' };
}

contextBridge.exposeInMainWorld('desktop', {
  version,
  /** Opens an http(s)/mailto URL in the system browser. */
  openExternal: (url) => ipcRenderer.invoke('desktop:openExternal', String(url)),
  /** Calls `listener` with the current update status now and whenever it changes. Returns an unsubscribe function. */
  onUpdateStatus: (listener) => {
    if (typeof listener !== 'function') return () => {};
    let active = true;
    const handler = (_event, status) => {
      if (active) listener(cleanStatus(status));
    };
    ipcRenderer.on('desktop:updateStatus', handler);
    ipcRenderer
      .invoke('desktop:updateGetStatus')
      .then((status) => {
        if (active) listener(cleanStatus(status));
      })
      .catch(() => {});
    return () => {
      active = false;
      ipcRenderer.removeListener('desktop:updateStatus', handler);
    };
  },
  /** Installs a downloaded update and restarts the app (Windows). Resolves false if there is nothing to install. */
  restartToUpdate: () => ipcRenderer.invoke('desktop:updateRestart'),
  /** Asks for an update check now. Resolves false when updates are off (dev builds). */
  checkForUpdates: () => ipcRenderer.invoke('desktop:updateCheck'),
});
