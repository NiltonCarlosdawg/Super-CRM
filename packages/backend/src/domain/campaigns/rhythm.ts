// Fase 4, Task 3: regras puras de ritmo (sem I/O, relógio e rng injetados).
// Conversões de fuso sempre via `Intl` com timeZone explícita — nunca o
// `getTimezoneOffset()` do host (docs/plans/2026-10-07-fase4-campanhas.md Task 3).

import type { CampaignConfig } from '../../modules/campaigns/config.js';

type QuietHoursConfig = Pick<CampaignConfig, 'quietHours' | 'timezone'>;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const partsInTz = (date: Date, timeZone: string): Record<string, number> => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const out: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
};

/** Offset (ms) do fuso naquele instante: hora local interpretada como UTC − instante. */
const offsetMs = (date: Date, timeZone: string): number => {
  const p = partsInTz(date, timeZone);
  // `hour: '2-digit'` pode devolver 24 em algumas implementações; normaliza.
  const hour = p.hour === 24 ? 0 : (p.hour ?? 0);
  const asUtc = Date.UTC(p.year!, (p.month ?? 1) - 1, p.day!, hour, p.minute ?? 0, p.second ?? 0);
  return asUtc - date.getTime();
};

/** Instante UTC de um minuto local (Y-M-D + minutos desde meia-noite). */
const fromLocal = (y: number, m: number, d: number, minute: number, timeZone: string): Date => {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0) + minute * MINUTE_MS;
  const offset = offsetMs(new Date(guess), timeZone);
  return new Date(guess - offset);
};

const localMinute = (now: Date, timeZone: string): number => {
  const p = partsInTz(now, timeZone);
  const hour = p.hour === 24 ? 0 : (p.hour ?? 0);
  return hour * 60 + (p.minute ?? 0);
};

export function isQuietHours(now: Date, cfg: QuietHoursConfig): boolean {
  const minute = localMinute(now, cfg.timezone);
  const { startMinute, endMinute } = cfg.quietHours;
  return startMinute > endMinute
    ? minute >= startMinute || minute < endMinute
    : minute >= startMinute && minute < endMinute;
}

export function nextCampaignWindowOpen(now: Date, cfg: QuietHoursConfig): Date {
  if (!isQuietHours(now, cfg)) return now;
  const p = partsInTz(now, cfg.timezone);
  const minute = localMinute(now, cfg.timezone);
  const sameDay = minute < cfg.quietHours.endMinute;
  const day = sameDay ? p.day! : p.day! + 1;
  return fromLocal(p.year!, p.month!, day, cfg.quietHours.endMinute, cfg.timezone);
}

/** Dia de vida da conta, 1-based (dia de criação = 1). */
export function accountAgeDays(createdAt: Date, now: Date): number {
  return Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS) + 1;
}

export function rampCapFor(ageDays: number, ramp: CampaignConfig['ramp']): number {
  for (const band of ramp.bands) {
    if (ageDays >= band.fromDay && ageDays <= band.toDay) return band.cap;
  }
  return ramp.defaultCap;
}

/** min(ramp da idade da conta, dailyLimit da campanha | sem teto). */
export function effectiveDailyCap(input: {
  ageDays: number;
  ramp: CampaignConfig['ramp'];
  campaignDailyLimit: number | null;
}): number {
  const ramp = rampCapFor(input.ageDays, input.ramp);
  return input.campaignDailyLimit === null ? ramp : Math.min(ramp, input.campaignDailyLimit);
}

/** minMs + floor(rng() * (maxMs - minMs + 1)), inclusivo nos dois extremos. */
export function randomDelayMs(delay: CampaignConfig['delay'], rng: () => number): number {
  const span = delay.maxMs - delay.minMs + 1;
  return delay.minMs + Math.floor(rng() * span);
}

/** Meia-noite local de `now` em `timeZone` (instante UTC ainda anterior a now). */
export function dayStartInTz(now: Date, timeZone: string): Date {
  const p = partsInTz(now, timeZone);
  return fromLocal(p.year!, p.month!, p.day!, 0, timeZone);
}

export function nextDayStartInTz(now: Date, timeZone: string): Date {
  const p = partsInTz(now, timeZone);
  return fromLocal(p.year!, p.month!, p.day! + 1, 0, timeZone);
}
