import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface ToastItem {
  id: number;
  message: string;
  tone: "info" | "error";
}

interface ToastApi {
  show(message: string): void;
  error(message: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextToastId = 0;
const AUTO_DISMISS_MS = 6000;

/** Provider com o Toaster embutido: a app só precisa de envolver o shell. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (message: string, tone: ToastItem["tone"]) => {
      const id = ++nextToastId;
      setItems((prev) => [...prev, { id, message, tone }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show: (message: string) => push(message, "info"),
      error: (message: string) => push(message, "error"),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {items.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === "error" ? "alert" : "status"}
            className={`flex items-center gap-3 border bg-surface px-4 py-2 text-sm text-fg ${
              toast.tone === "error" ? "border-danger" : "border-border"
            }`}
          >
            <span>{toast.message}</span>
            <button
              type="button"
              aria-label="Fechar aviso"
              onClick={() => dismiss(toast.id)}
              className="text-muted hover:text-fg"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) throw new Error("useToast fora do ToastProvider");
  return ctx;
}
