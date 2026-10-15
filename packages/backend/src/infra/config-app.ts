// Config de autenticação e de mensagens da Fase 1 — reutiliza `ConfigError` e a
// mecânica de issues da Fase 0 (`config.ts`): ordem fixa, mensagens em português,
// nunca ecoar valores recebidos (segredos nunca em logs, AGENTS.md §4).

import { ConfigError, loadConfig, type AppConfig } from './config.js';

export interface AuthConfig {
  authSecret: string;
  sessionTtlHours: number;
  loginRateMax: number;
  loginRateWindowMs: number;
  loginLockMaxMs: number;
  totpIssuer: string;
  httpRateMax: number;
  httpRateWindowMs: number;
  bodyLimitBytes: number;
}

export interface MessagingConfig {
  waAkgBaseUrl: string;
  waAkgApiKey: string;
  waWebhookSecret: string;
  replyDelayMs: { min: number; max: number };
  sendTimeoutMs: number;
  sendMaxAttempts: number;
  outboxRetryDelayMs: number;
  outboxTickMs: number;
  claimTtlMs: number;
  failWindow: number;
  failRatio: number;
  cbThreshold: number;
  cbCooldownMs: number;
  maxMessageChars: number;
}

/** string vazia conta como ausente (convenção da Fase 0). */
function optional(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** Inteiro no intervalo [min, max]; fora ou não-numérico → issue `X: fora do intervalo min-max`. */
function intOf(
  env: NodeJS.ProcessEnv,
  key: string,
  def: number,
  min: number,
  max: number,
  issues: string[],
): number {
  const raw = optional(env[key]);
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    issues.push(`${key}: fora do intervalo ${min}-${max}`);
    return def;
  }
  return n;
}

/** Autenticação (A2, docs/06): sessão server-side, TOTP para admin, rate limiting. */
export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const issues: string[] = [];

  const authSecret = optional(env.AUTH_SECRET);
  if (authSecret === undefined) issues.push('falta AUTH_SECRET');
  else if (authSecret.length < 32) issues.push('AUTH_SECRET: mínimo 32 caracteres');

  const totpIssuer = optional(env.AUTH_TOTP_ISSUER);
  if (totpIssuer === undefined) issues.push('falta AUTH_TOTP_ISSUER');

  // Pontos de partida conservadores nossos, a calibrar (docs/03; docs/04 §7 para
  // o registo dos valores iniciais). Sessão: 72h.
  const sessionTtlHours = intOf(env, 'AUTH_SESSION_TTL_HOURS', 72, 1, 8760, issues);
  const loginRateMax = intOf(env, 'AUTH_LOGIN_RATE_MAX', 5, 1, 1000, issues);
  const loginRateWindowMs = intOf(env, 'AUTH_LOGIN_RATE_WINDOW_MS', 300_000, 1000, 3_600_000, issues);
  const loginLockMaxMs = intOf(env, 'AUTH_LOGIN_LOCK_MAX_MS', 900_000, 1000, 86_400_000, issues);
  const httpRateMax = intOf(env, 'HTTP_RATE_MAX', 300, 1, 100_000, issues);
  const httpRateWindowMs = intOf(env, 'HTTP_RATE_WINDOW_MS', 60_000, 1000, 3_600_000, issues);
  const bodyLimitBytes = intOf(env, 'HTTP_BODY_LIMIT_BYTES', 1_048_576, 1024, 33_554_432, issues);

  if (issues.length > 0) throw new ConfigError(issues);
  return {
    authSecret: authSecret as string,
    sessionTtlHours,
    loginRateMax,
    loginRateWindowMs,
    loginLockMaxMs,
    totpIssuer: totpIssuer as string,
    httpRateMax,
    httpRateWindowMs,
    bodyLimitBytes,
  };
}

/** Mensagens (docs/04 §7): valores iniciais nossos, a calibrar com monitorização. */
export function loadMessagingConfig(env: NodeJS.ProcessEnv): MessagingConfig {
  const issues: string[] = [];

  const waAkgBaseUrl = optional(env.WA_AKG_BASE_URL);
  if (waAkgBaseUrl === undefined) issues.push('falta WA_AKG_BASE_URL');
  else if (!/^https?:\/\/\S+$/.test(waAkgBaseUrl)) issues.push('WA_AKG_BASE_URL: formato http(s):// esperado');

  const waAkgApiKey = optional(env.WA_AKG_API_KEY);
  if (waAkgApiKey === undefined) issues.push('falta WA_AKG_API_KEY');

  const waWebhookSecret = optional(env.WA_WEBHOOK_SECRET);
  if (waWebhookSecret === undefined) issues.push('falta WA_WEBHOOK_SECRET');
  else if (waWebhookSecret.length < 32) issues.push('WA_WEBHOOK_SECRET: mínimo 32 caracteres');

  // WA_REPLY_DELAY_MS: `min-max` com 0 ≤ min ≤ max ≤ 600000 (docs/04 §7).
  let replyDelayMs = { min: 1000, max: 5000 };
  const delayRaw = optional(env.WA_REPLY_DELAY_MS);
  if (delayRaw !== undefined) {
    const m = /^(\d+)-(\d+)$/.exec(delayRaw);
    if (m === null || m[1] === undefined || m[2] === undefined) {
      issues.push('WA_REPLY_DELAY_MS: formato min-max esperado');
    } else {
      const min = Number(m[1]);
      const max = Number(m[2]);
      if (min > max) issues.push('WA_REPLY_DELAY_MS: min > max');
      else if (min < 0 || max > 600_000) issues.push('WA_REPLY_DELAY_MS: fora do intervalo 0-600000');
      else replyDelayMs = { min, max };
    }
  }

  // WA_FAIL_RATIO: racio de falhas (0,1] dentro da `failWindow`.
  let failRatio = 0.3;
  const ratioRaw = optional(env.WA_FAIL_RATIO);
  if (ratioRaw !== undefined) {
    const n = Number(ratioRaw);
    if (!Number.isFinite(n) || n <= 0 || n > 1) issues.push('WA_FAIL_RATIO: fora do intervalo (0,1]');
    else failRatio = n;
  }

  const sendTimeoutMs = intOf(env, 'WA_SEND_TIMEOUT_MS', 15_000, 1000, 600_000, issues);
  const sendMaxAttempts = intOf(env, 'WA_SEND_MAX_ATTEMPTS', 5, 1, 20, issues);
  const outboxRetryDelayMs = intOf(env, 'WA_OUTBOX_RETRY_DELAY_MS', 30_000, 1000, 3_600_000, issues);
  const outboxTickMs = intOf(env, 'WA_OUTBOX_TICK_MS', 1000, 100, 60_000, issues);
  const claimTtlMs = intOf(env, 'WA_CLAIM_TTL_MS', 60_000, 1000, 3_600_000, issues);
  const failWindow = intOf(env, 'WA_FAIL_WINDOW', 20, 1, 1000, issues);
  const cbThreshold = intOf(env, 'WA_CB_THRESHOLD', 5, 1, 100, issues);
  const cbCooldownMs = intOf(env, 'WA_CB_COOLDOWN_MS', 30_000, 1000, 3_600_000, issues);
  const maxMessageChars = intOf(env, 'WA_MAX_MESSAGE_CHARS', 4096, 1, 65_536, issues);

  if (issues.length > 0) throw new ConfigError(issues);
  return {
    waAkgBaseUrl: waAkgBaseUrl as string,
    waAkgApiKey: waAkgApiKey as string,
    waWebhookSecret: waWebhookSecret as string,
    replyDelayMs,
    sendTimeoutMs,
    sendMaxAttempts,
    outboxRetryDelayMs,
    outboxTickMs,
    claimTtlMs,
    failWindow,
    failRatio,
    cbThreshold,
    cbCooldownMs,
    maxMessageChars,
  };
}

/** Config completa: base (Fase 0) + auth + messaging, lendo o env uma vez. */
export function loadFullConfig(
  env: NodeJS.ProcessEnv,
): AppConfig & { auth: AuthConfig; messaging: MessagingConfig } {
  const base = loadConfig(env); // falha primeiro por DATABASE_URL no arranque
  const auth = loadAuthConfig(env);
  const messaging = loadMessagingConfig(env);
  return { ...base, auth, messaging };
}
