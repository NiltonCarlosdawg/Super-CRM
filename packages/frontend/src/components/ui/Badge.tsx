import type { ReactNode } from "react";

export type BadgeTone = "success" | "info" | "warning" | "danger" | "neutral";

/**
 * Estado sempre com TEXTO + cor — nunca só cor (a11y §6 do desenho).
 * `icon` é decorativo (aria-hidden): quem lê ecrãs tem o texto.
 */
const TONES: Record<BadgeTone, string> = {
  success: "border-success/40 text-success",
  info: "border-accent/40 text-accent",
  warning: "border-warning/40 text-warning",
  danger: "border-danger/40 text-danger",
  neutral: "border-border text-muted",
};

export function Badge({
  tone,
  icon,
  children,
}: {
  tone: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs ${TONES[tone]}`}>
      {icon !== undefined && (
        <span aria-hidden="true" className="leading-none">
          {icon}
        </span>
      )}
      <span>{children}</span>
    </span>
  );
}
