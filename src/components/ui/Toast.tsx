import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconButton } from './IconButton';
import { IconAlert, IconCheckCircle, IconClose, IconInfo } from './icons';

export type ToastTone = 'info' | 'good' | 'warning' | 'critical';

export interface ToastOptions {
  message: ReactNode;
  tone?: ToastTone;
  /** ms before auto-dismiss; 0 = sticky. Default 4000 (critical: 7000). */
  duration?: number;
}

export interface ToastApi {
  show(opts: ToastOptions): number;
  success(message: ReactNode): number;
  error(message: ReactNode): number;
  info(message: ReactNode): number;
  dismiss(id: number): void;
}

interface ToastItem extends Required<Pick<ToastOptions, 'tone'>> {
  id: number;
  message: ReactNode;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Wrap the app once (done in main.tsx). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const show = useCallback(
    ({ message, tone = 'info', duration }: ToastOptions) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-4), { id, message, tone }]);
      const ms = duration ?? (tone === 'critical' ? 7000 : 4000);
      if (ms > 0) setTimeout(() => dismiss(id), ms);
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (message) => show({ message, tone: 'good' }),
      error: (message) => show({ message, tone: 'critical' }),
      info: (message) => show({ message, tone: 'info' }),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === 'critical' ? 'alert' : 'status'}>
            <span className="toast-icon" aria-hidden="true">
              {t.tone === 'good' ? <IconCheckCircle size={17} /> : t.tone === 'info' ? <IconInfo size={17} /> : <IconAlert size={17} />}
            </span>
            <div className="message">{t.message}</div>
            <IconButton label="Dismiss" icon={<IconClose size={14} />} size="sm" onClick={() => dismiss(t.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** `const toast = useToast(); toast.success('Saved');` */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>.');
  return ctx;
}
