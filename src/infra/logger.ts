import pino, { type Logger } from 'pino';

export type { Logger };

export interface CreateLoggerOptions {
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Para testes: stream em memória. Em produção, omitir (stdout). */
  stream?: NodeJS.WritableStream;
}

/** Formato E.164: `+` e pelo menos um dígito (usado para extrair país/local). */
const SHAPE_RE = /^\+[1-9]\d+$/;
/** E.164 estrito: 7-15 dígitos no total. */
const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Logger JSON. Nível em string (`"level":"info"`). Nunca registar telefones completos. */
export function createLogger(options: CreateLoggerOptions): Logger {
  const config = {
    level: options.level,
    formatters: { level: (label: string) => ({ level: label }) },
  };
  return options.stream === undefined ? pino(config) : pino(config, options.stream);
}

/** Cria logger filho com `correlationId` no payload de cada linha. */
export function withCorrelationId(parent: Logger, correlationId: string): Logger {
  return parent.child({ correlationId });
}

/**
 * Mascara um telefone E.164: mantém o código do país, o 1.º dígito local e os 2 últimos.
 * `+244912345612` → `+244 9** *** *12` (grupos de 3 do dígito local, separados por espaço).
 * Local com < 4 dígito → `+<país> ***`. Formato inválido → `***`.
 *
 * Nota: o branch `local.length < 4` vem ANTES da validação de comprimento estrito para que
 * `+244912` caia nele (contrato em `tests/unit/logger.test.ts`).
 */
export function maskPhoneE164(e164: string): string {
  if (!SHAPE_RE.test(e164)) return '***';

  const digits = e164.slice(1);
  const country = digits.startsWith('244') ? '244' : digits.slice(0, 3);
  const local = digits.slice(country.length);
  if (local.length === 0) return '***';
  if (local.length < 4) return `+${country} ***`;
  if (!E164_RE.test(e164)) return '***';

  const masked = local.charAt(0) + '*'.repeat(local.length - 3) + local.slice(-2);
  const groups = masked.match(/.{1,3}/g) ?? [];
  return `+${country} ${groups.join(' ')}`;
}
