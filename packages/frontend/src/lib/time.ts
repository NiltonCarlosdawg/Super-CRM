// Hora relativa em PT-AO (Task 8: fila de conversas; reutilizada na thread).

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";

  const diffSeconds = Math.round((then - now) / 1000);
  const abs = Math.abs(diffSeconds);
  const rtf = new Intl.RelativeTimeFormat("pt-AO", { numeric: "auto" });

  if (abs < MINUTE) return rtf.format(0, "second"); // "agora mesmo"
  if (abs < HOUR) return rtf.format(Math.round(diffSeconds / MINUTE), "minute");
  if (abs < DAY) return rtf.format(Math.round(diffSeconds / HOUR), "hour");
  return new Intl.DateTimeFormat("pt-AO", { day: "2-digit", month: "short" }).format(then);
}
