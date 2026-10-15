// Bloqueio progressivo de login (docs/plans/...fase1, Task 7): em memória,
// instância única (ADR-0001: um só servidor, sem Redis).
//
// Fórmulas (passo 3 do plano):
// - falhas contadas dentro da janela `windowMs`;
// - `failures >= max` → `lockedUntil = now + min(lockMaxMs, 2^(failures-max) * 30000)`;
// - `reset` limpa a entrada (sucesso de login);
// - entrada expirada é removida no acesso; cap de 10000 chaves, descarta a mais antiga.

const LOCK_BASE_MS = 30_000;
const MAX_KEYS = 10_000;

interface Entry {
  failures: number;
  windowStartMs: number;
  lockedUntilMs: number;
}

export type LoginLimiter = {
  check(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number };
  fail(key: string): void;
  reset(key: string): void;
};

export function createLoginLimiter(
  cfg: { max: number; windowMs: number; lockMaxMs: number },
  now: () => Date,
): LoginLimiter {
  const entries = new Map<string, Entry>();

  /** Janela expirada E sem bloqueio ativo → descarta a entrada. */
  function fresh(key: string, tMs: number): Entry | undefined {
    const e = entries.get(key);
    if (e === undefined) return undefined;
    if (tMs >= e.lockedUntilMs && tMs - e.windowStartMs > cfg.windowMs) {
      entries.delete(key);
      return undefined;
    }
    return e;
  }

  return {
    check(key) {
      const tMs = now().getTime();
      const e = fresh(key, tMs);
      if (e !== undefined && tMs < e.lockedUntilMs) {
        return { allowed: false, retryAfterSeconds: Math.ceil((e.lockedUntilMs - tMs) / 1000) };
      }
      return { allowed: true };
    },
    fail(key) {
      const tMs = now().getTime();
      const e = fresh(key, tMs) ?? { failures: 0, windowStartMs: tMs, lockedUntilMs: 0 };
      e.failures += 1;
      if (e.failures >= cfg.max) {
        const lockMs = Math.min(cfg.lockMaxMs, 2 ** (e.failures - cfg.max) * LOCK_BASE_MS);
        e.lockedUntilMs = tMs + lockMs;
      }
      if (!entries.has(key) && entries.size >= MAX_KEYS) {
        // cap: descarta a entrada mais antiga (ordem de inserção do Map)
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, e);
    },
    reset(key) {
      entries.delete(key);
    },
  };
}
