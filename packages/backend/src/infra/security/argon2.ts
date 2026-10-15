// Implementação argon2id (docs/03): parâmetros OWASP — m=19456 KiB, t=2, p=1.
// Binding oficial `argon2` (ADR-0006); sal novo por hash (a lib gera-o).

import argon2 from 'argon2';
import type { PasswordHasher } from '../../ports/security.js';

export function createArgon2Hasher(): PasswordHasher {
  return {
    hash: (plain) =>
      argon2.hash(plain, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    verify: (hash, plain) => argon2.verify(hash, plain),
  };
}
