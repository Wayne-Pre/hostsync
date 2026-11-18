import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * F-04 — one ARIA live region for the whole app.
 *
 * Save and error feedback goes through here, never through an ad-hoc <div>.
 * Screen readers hear the message because the region already exists in the DOM
 * before the text arrives.
 */
export type ToastTone = 'ok' | 'error';

interface ToastState {
  id: number;
  message: string;
  tone: ToastTone;
}

const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => {});

export function useToast(): (message: string, tone?: ToastTone) => void {
  return useContext(ToastContext);
}

export const TOAST_TIMEOUT_MS = 4_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const counter = useRef(0);

  const announce = useCallback((message: string, tone: ToastTone = 'ok') => {
    counter.current += 1;
    setToast({ id: counter.current, message, tone });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), TOAST_TIMEOUT_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={announce}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications alt+T">
        <div
          className={`toast toast-${toast?.tone ?? 'ok'}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="toast"
          data-visible={toast ? 'true' : 'false'}
          data-toast-id={toast?.id ?? 0}
        >
          {toast?.message ?? ''}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
