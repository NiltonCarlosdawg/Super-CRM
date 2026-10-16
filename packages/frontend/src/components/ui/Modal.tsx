import type { ReactNode } from "react";

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md border border-border bg-surface p-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="font-display text-lg text-fg">{title}</h2>
          <button
            type="button"
            aria-label="Fechar"
            onClick={onClose}
            className="px-2 text-muted hover:text-fg"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
