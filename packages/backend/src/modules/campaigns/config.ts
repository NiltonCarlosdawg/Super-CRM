// Fase 4, Task 1: config de campanhas validada no arranque (docs/04 §7).
// Limites são config, nunca constantes soltas; erros mencionam a chave mas nunca
// o valor recebido (segredos nunca em logs, AGENTS.md §4).

export interface CampaignConfig {
  delay: { minMs: number; maxMs: number };
  ramp: { bands: readonly { fromDay: number; toDay: number; cap: number }[]; defaultCap: number };
  quietHours: { startMinute: number; endMinute: number };
  timezone: 'Africa/Luanda';
  optOutKeywords: readonly string[];
  optOutFooter: string;
  pause: { failWindow: number; failRatio: number; optOutWindow: number; optOutCount: number };
}

export class CampaignConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const DEFAULT_DELAY = '15000-45000';
const DEFAULT_RAMP = '1-3:30,4-7:60,8-14:100,default:150';
const DEFAULT_QUIET_HOURS = '20:00-08:00';
const DEFAULT_KEYWORDS = 'sair';
const DEFAULT_FOOTER = 'Responde SAIR para sair desta lista.';

/** string vazia conta como ausente (convenção da Fase 0). */
const value = (env: Env, key: string, fallback: string): string => {
  const raw = env[key];
  return raw === undefined || raw === '' ? fallback : raw;
};

function fail(key: string, message: string): never {
  throw new CampaignConfigError(`${key}: ${message}`);
}

const normalize = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

function parseDelay(raw: string): { minMs: number; maxMs: number } {
  const m = /^(\d+)-(\d+)$/.exec(raw);
  if (m === null) fail('WA_CAMPAIGN_DELAY_MS', 'formato min-max esperado');
  const minMs = Number(m[1]);
  const maxMs = Number(m[2]);
  if (minMs > maxMs) fail('WA_CAMPAIGN_DELAY_MS', 'min > max');
  return { minMs, maxMs };
}

function parseRamp(raw: string): CampaignConfig['ramp'] {
  const bands: { fromDay: number; toDay: number; cap: number }[] = [];
  let defaultCap: number | undefined;
  for (const part of raw.split(',')) {
    const band = /^(\d+)-(\d+):(\d+)$/.exec(part);
    if (band !== null) {
      const fromDay = Number(band[1]);
      const toDay = Number(band[2]);
      const cap = Number(band[3]);
      if (fromDay < 1 || toDay < fromDay || cap < 1) {
        fail('WA_CAMPAIGN_RAMP', `banda inválida (${part})`);
      }
      bands.push({ fromDay, toDay, cap });
      continue;
    }
    const def = /^default:(\d+)$/.exec(part);
    if (def === null || defaultCap !== undefined) fail('WA_CAMPAIGN_RAMP', 'formato from-to:cap,default:cap esperado');
    defaultCap = Number(def[1]);
    if (defaultCap < 1) fail('WA_CAMPAIGN_RAMP', 'default:cap tem de ser ≥ 1');
  }
  if (defaultCap === undefined) fail('WA_CAMPAIGN_RAMP', 'falta a entrada default:cap');
  bands.sort((a, b) => a.fromDay - b.fromDay);
  for (let i = 1; i < bands.length; i++) {
    if (bands[i]!.fromDay <= bands[i - 1]!.toDay) fail('WA_CAMPAIGN_RAMP', 'bandas sobrepostas');
  }
  return { bands, defaultCap };
}

function parseQuietHours(raw: string): CampaignConfig['quietHours'] {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(raw);
  if (m === null) fail('WA_QUIET_HOURS', 'formato HH:MM-HH:MM esperado');
  const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) fail('WA_QUIET_HOURS', 'hora fora do intervalo 0-1439');
  const startMinute = sh * 60 + sm;
  const endMinute = eh * 60 + em;
  if (startMinute === endMinute) fail('WA_QUIET_HOURS', 'início e fim iguais');
  return { startMinute, endMinute };
}

function parseKeywords(raw: string): string[] {
  const keywords = [...new Set(raw.split(',').map(normalize).filter((k) => k !== ''))];
  if (keywords.length === 0) fail('CAMPAIGN_OPTOUT_KEYWORDS', 'pelo menos uma palavra-chave esperada');
  return keywords;
}

function parseThreshold(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = value(env, key, String(fallback));
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(key, `fora do intervalo ${min}-${max}`);
  }
  return n;
}

export function loadCampaignConfig(env: Env): CampaignConfig {
  const delay = parseDelay(value(env, 'WA_CAMPAIGN_DELAY_MS', DEFAULT_DELAY));
  const ramp = parseRamp(value(env, 'WA_CAMPAIGN_RAMP', DEFAULT_RAMP));
  const quietHours = parseQuietHours(value(env, 'WA_QUIET_HOURS', DEFAULT_QUIET_HOURS));
  const optOutKeywords = parseKeywords(value(env, 'CAMPAIGN_OPTOUT_KEYWORDS', DEFAULT_KEYWORDS));

  const optOutFooter = value(env, 'CAMPAIGN_OPT_OUT_FOOTER', DEFAULT_FOOTER);
  const normalizedFooter = normalize(optOutFooter);
  if (!optOutKeywords.some((k) => normalizedFooter.includes(k))) {
    fail('CAMPAIGN_OPT_OUT_FOOTER', 'tem de conter uma palavra-chave de opt-out');
  }

  const failWindow = parseThreshold(env, 'CAMPAIGN_FAIL_WINDOW', 20, 1, 1000);
  const failRatioRaw = value(env, 'CAMPAIGN_FAIL_RATIO', '0.30');
  const failRatio = Number(failRatioRaw);
  if (!Number.isFinite(failRatio) || failRatio <= 0 || failRatio > 1) {
    fail('CAMPAIGN_FAIL_RATIO', 'fora do intervalo (0,1]');
  }
  const optOutWindow = parseThreshold(env, 'CAMPAIGN_OPTOUT_WINDOW', 50, 1, 1000);
  const optOutCount = parseThreshold(env, 'CAMPAIGN_OPTOUT_COUNT', 5, 1, 1000);

  return {
    delay,
    ramp,
    quietHours,
    timezone: 'Africa/Luanda',
    optOutKeywords,
    optOutFooter,
    pause: { failWindow, failRatio, optOutWindow, optOutCount },
  };
}
