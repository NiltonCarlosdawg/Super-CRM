import type { ReactNode } from "react";

/** Superfície do tema: fundo #121215 com borda de 1px, sem sombra. */
export function Card({ className = "", children }: { className?: string; children?: ReactNode }) {
  return <div className={`bg-surface border border-border ${className}`}>{children}</div>;
}
