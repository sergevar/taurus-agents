import { useState, useCallback, useEffect, useRef } from 'react';

interface ToastItem {
  id: number;
  message: string;
  type: 'error' | 'info';
}

interface ToastState extends ToastItem {
  timeoutId: ReturnType<typeof setTimeout> | null;
}

let nextId = 0;
const TOAST_DURATION = 6000;

export function useToast() {
  const [toasts, setToasts] = useState<ToastState[]>([]);

  const showToast = useCallback((message: string, type: 'error' | 'info' = 'error') => {
    const id = nextId++;
    const timeoutId = setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, TOAST_DURATION);

    setToasts(prev => [...prev, { id, message, type, timeoutId }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => {
      const toast = prev.find(t => t.id === id);
      if (toast?.timeoutId) clearTimeout(toast.timeoutId);
      return prev.filter(t => t.id !== id);
    });
  }, []);

  const pause = useCallback((id: number) => {
    setToasts(prev => prev.map(t => {
      if (t.id !== id || !t.timeoutId) return t;
      clearTimeout(t.timeoutId);
      return { ...t, timeoutId: null };
    }));
  }, []);

  const resume = useCallback((id: number) => {
    setToasts(prev => prev.map(t => {
      if (t.id !== id || t.timeoutId) return t;
      // Reset to full duration on resume
      const timeoutId = setTimeout(() => {
        setToasts(p => p.filter(toast => toast.id !== id));
      }, TOAST_DURATION);
      return { ...t, timeoutId };
    }));
  }, []);

  return { toasts, showToast, dismiss, pause, resume };
}

export function ToastContainer({
  toasts,
  onDismiss,
  onPause,
  onResume
}: {
  toasts: ToastState[];
  onDismiss: (id: number) => void;
  onPause: (id: number) => void;
  onResume: (id: number) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map(t => (
        <Toast
          key={t.id}
          toast={t}
          onDismiss={() => onDismiss(t.id)}
          onPause={() => onPause(t.id)}
          onResume={() => onResume(t.id)}
        />
      ))}
    </div>
  );
}

function Toast({
  toast,
  onDismiss,
  onPause,
  onResume
}: {
  toast: ToastState;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
    };
  }, []);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(toast.message);
      setCopied(true);
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
      copiedTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API failed (e.g. not in secure context) — just dismiss
      onDismiss();
    }
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDismiss();
  };

  return (
    <div
      className={`toast toast--${toast.type} ${visible ? 'toast--visible' : ''} ${copied ? 'toast--copied' : ''}`}
      onClick={handleClick}
      onMouseEnter={onPause}
      onMouseLeave={onResume}
      title="Click to copy"
    >
      <span className="toast__message">{copied ? 'Copied!' : toast.message}</span>
      <button className="toast__close" onClick={handleClose} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
