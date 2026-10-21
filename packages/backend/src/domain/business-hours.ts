// Fase 3, Task 3: domínio de horário de atendimento (docs/05 §6, A6).
// Sem dependências e sem cálculo manual de UTC+1: o dia-da-semana e a hora local
// de um instante vêm de `Intl.DateTimeFormat(..., { timeZone })`; a conversão
// "parede local → instante UTC" usa resolução de offset em dois passos (correcta
// para offset fixo como Africa/Luanda e robusta a fusos com DST).
//
// Convenção dos `days`: ISO-8601 (1 = segunda … 7 = domingo) — igual ao default
// de `Settings['businessHours'].days` ([1,2,3,4,5] = dias úteis).

export interface BusinessHours {
  timezone: string;
  days: number[];
  open: string;
  close: string;
}

interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  m: number;
}

function partsMap(fmt: Intl.DateTimeFormat, instant: Date): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) if (p.type !== 'literal') map[p.type] = p.value;
  return map;
}

/** Data+hora locais (fuso `timezone`) de um instante. `h` normalizado (ICU pode
 *  devolver "24" para meia-noite; `% 24` garante 0–23). */
function localParts(instant: Date, timezone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const map = partsMap(fmt, instant);
  return {
    y: Number(map.year),
    mo: Number(map.month),
    d: Number(map.day),
    h: Number(map.hour) % 24,
    m: Number(map.minute),
  };
}

/** Dia-da-semana ISO (1=seg … 7=dom) de uma data de calendário. */
function weekdayOf(y: number, mo: number, d: number): number {
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

function addDays(y: number, mo: number, d: number, n: number): { y: number; mo: number; d: number } {
  const dt = new Date(Date.UTC(y, mo - 1, d) + n * 86_400_000);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function dayNumber(y: number, mo: number, d: number): number {
  return Math.round(Date.UTC(y, mo - 1, d) / 86_400_000);
}

function fromDayNumber(n: number): { y: number; mo: number; d: number } {
  const dt = new Date(n * 86_400_000);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Offset (local − UTC) em ms de um instante no fuso `timezone`. */
function tzOffsetMs(instant: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const map = partsMap(fmt, instant);
  const localAsUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second),
  );
  return localAsUtc - instant.getTime();
}

/** Parede local (y/mo/d h:m) → instante UTC, resolvendo o offset em 2 passos. */
function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  m: number,
  timezone: string,
): Date {
  const wall = Date.UTC(y, mo - 1, d, h, m, 0, 0);
  let ts = wall;
  for (let i = 0; i < 2; i++) ts = wall - tzOffsetMs(new Date(ts), timezone);
  return new Date(ts);
}

function parseHHMM(hhmm: string): { h: number; m: number } {
  const i = hhmm.indexOf(':');
  return { h: Number(hhmm.slice(0, i)), m: Number(hhmm.slice(i + 1, i + 3)) };
}

function toMin(hhmm: string): number {
  const { h, m } = parseHHMM(hhmm);
  return h * 60 + m;
}

/** Aberto no instante `instant`? Janela [open, close) no fuso de `b` (fecho exclusivo). */
export function isOpenAt(instant: Date, b: BusinessHours): boolean {
  const p = localParts(instant, b.timezone);
  if (!b.days.includes(weekdayOf(p.y, p.mo, p.d))) return false;
  const t = p.h * 60 + p.m;
  return t >= toMin(b.open) && t < toMin(b.close);
}

/** Próxima abertura estritamente após `instant`; `null` se `days` vazio. */
export function nextOpening(instant: Date, b: BusinessHours): Date | null {
  if (b.days.length === 0) return null;
  const p = localParts(instant, b.timezone);
  const { h: oh, m: om } = parseHHMM(b.open);
  for (let i = 0; i < 8; i++) {
    const day = addDays(p.y, p.mo, p.d, i);
    if (!b.days.includes(weekdayOf(day.y, day.mo, day.d))) continue;
    const opening = zonedToUtc(day.y, day.mo, day.d, oh, om, b.timezone);
    if (opening.getTime() > instant.getTime()) return opening;
  }
  return null;
}

/** Minutos dentro do horário entre `from` e `to` (por janelas de dia local). */
export function businessMinutesBetween(from: Date, to: Date, b: BusinessHours): number {
  if (to.getTime() <= from.getTime()) return 0;
  const { h: oh, m: om } = parseHHMM(b.open);
  const { h: ch, m: cm } = parseHHMM(b.close);
  const fromDay = localParts(from, b.timezone);
  const toDay = localParts(to, b.timezone);
  const startN = dayNumber(fromDay.y, fromDay.mo, fromDay.d);
  const endN = dayNumber(toDay.y, toDay.mo, toDay.d);
  let total = 0;
  for (let n = startN; n <= endN; n++) {
    const day = fromDayNumber(n);
    if (!b.days.includes(weekdayOf(day.y, day.mo, day.d))) continue;
    const openI = zonedToUtc(day.y, day.mo, day.d, oh, om, b.timezone).getTime();
    const closeI = zonedToUtc(day.y, day.mo, day.d, ch, cm, b.timezone).getTime();
    const s = Math.max(openI, from.getTime());
    const e = Math.min(closeI, to.getTime());
    if (s < e) total += (e - s) / 60_000;
  }
  return total;
}
