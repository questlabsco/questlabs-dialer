/** Bridge to the Electron preload (`window.desktop`). Safe in a plain browser. */

/**
 * App update state from the Electron main process.
 * - `none`: up to date, still checking, or updates are off (dev / browser).
 * - `ready`: a newer version is downloaded and installs on restart or quit (Windows).
 * - `available`: a newer version exists but must be downloaded by hand from `url` (macOS, unsigned).
 */
export type UpdateStatus =
  | { state: 'none' }
  | { state: 'ready'; version: string }
  | { state: 'available'; version: string; url: string };

export interface DesktopBridge {
  version: string;
  openExternal(url: string): Promise<boolean>;
  /** Called with the current status right away and on every change. Returns an unsubscribe function. */
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  /** Installs the downloaded update and restarts the app. Resolves false if nothing is ready. */
  restartToUpdate(): Promise<boolean>;
  /** Checks for an update now. Resolves false when updates are off. */
  checkForUpdates(): Promise<boolean>;
}

declare global {
  interface Window {
    /** Present only inside the Electron app. */
    desktop?: DesktopBridge;
  }
}

export const isElectron = typeof window !== 'undefined' && !!window.desktop;

export const appVersion = (typeof window !== 'undefined' && window.desktop?.version) || 'web';

/** Opens an http(s)/mailto URL in the system browser (Electron) or a new tab (browser). */
export function openExternal(url: string): void {
  if (typeof window === 'undefined') return;
  if (window.desktop) void window.desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** Subscribes to app update status. Outside Electron it never fires and the unsubscribe is a no-op. */
export function onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
  if (typeof window === 'undefined' || !window.desktop?.onUpdateStatus) return () => {};
  return window.desktop.onUpdateStatus(listener);
}

/** Installs a downloaded update and restarts the app (Electron, Windows). */
export function restartToUpdate(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.desktop?.restartToUpdate) return Promise.resolve(false);
  return window.desktop.restartToUpdate();
}

/** Asks the main process to check for an update now. */
export function checkForUpdates(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.desktop?.checkForUpdates) return Promise.resolve(false);
  return window.desktop.checkForUpdates();
}

/** Calendly link prefilled with the lead's name and email. */
export function calendlyLink(baseUrl: string, name: string, email: string): string {
  try {
    const u = new URL(baseUrl);
    if (name) u.searchParams.set('name', name);
    if (email) u.searchParams.set('email', email);
    return u.toString();
  } catch {
    return baseUrl;
  }
}
