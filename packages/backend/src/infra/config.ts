import { z } from 'zod';

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  logLevel: LogLevel;
}

/**
 * Configuração inválida. A mensagem lista só os issues (nunca os valores
 * recebidos) — segredos nunca em logs (AGENTS.md §4).
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`config inválida (${issues.length} problemas):\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = Object.freeze([...issues]);
  }
}

const NODE_ENVS = ['development', 'test', 'production'] as const;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** Ordem fixa dos problemas reportados (plano Fase 0, Task 3). */
const VAR_ORDER = ['NODE_ENV', 'PORT', 'DATABASE_URL', 'REDIS_URL', 'LOG_LEVEL'] as const;

type VarKey = (typeof VAR_ORDER)[number];
type RawEnv = Partial<Record<VarKey, string>>;

const configSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://')),
  REDIS_URL: z.string().refine((value) => value.startsWith('redis://') || value.startsWith('rediss://')),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

/** string vazia conta como ausente; nunca reler process.env dentro da função. */
function toOptional(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** Mapeamento manual do issue zod para a mensagem portuguesa, por variável. */
function issueMessage(key: VarKey, raw: string | undefined): string {
  if (key === 'DATABASE_URL') {
    return raw === undefined
      ? 'falta DATABASE_URL'
      : 'DATABASE_URL: formato postgres:// ou postgresql:// esperado';
  }
  if (key === 'REDIS_URL') {
    return raw === undefined ? 'falta REDIS_URL' : 'REDIS_URL: formato redis:// esperado';
  }
  if (key === 'PORT') return 'PORT: fora do intervalo 1-65535';
  if (key === 'NODE_ENV') return 'NODE_ENV: valor não permitido';
  return 'LOG_LEVEL: valor não permitido';
}

/** Lê as env vars UMA vez. Lança ConfigError sem ecoar valores. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const raw: RawEnv = {
    NODE_ENV: toOptional(env.NODE_ENV),
    PORT: toOptional(env.PORT),
    DATABASE_URL: toOptional(env.DATABASE_URL),
    REDIS_URL: toOptional(env.REDIS_URL),
    LOG_LEVEL: toOptional(env.LOG_LEVEL),
  };

  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const failed = new Set<string>();
    for (const issue of result.error.issues) {
      const key = issue.path?.[0];
      if (typeof key === 'string') failed.add(key);
    }
    const issues: string[] = [];
    for (const key of VAR_ORDER) {
      if (failed.has(key)) issues.push(issueMessage(key, raw[key]));
    }
    throw new ConfigError(issues);
  }

  return {
    nodeEnv: result.data.NODE_ENV,
    port: result.data.PORT,
    databaseUrl: result.data.DATABASE_URL,
    redisUrl: result.data.REDIS_URL,
    logLevel: result.data.LOG_LEVEL,
  };
}
