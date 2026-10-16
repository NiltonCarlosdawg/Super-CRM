import type { ReactNode } from "react";

/** Vazio do tema: superfície, título display e descrição secundária. */
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="border border-border bg-surface px-6 py-12 text-center">
      <h3 className="font-display text-lg text-fg">{title}</h3>
      {description !== undefined && <p className="mt-2 text-sm text-muted">{description}</p>}
      {children !== undefined && <div className="mt-4">{children}</div>}
    </div>
  );
}
