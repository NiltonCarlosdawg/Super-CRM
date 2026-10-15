// Política de palavra-passe (docs/03): 12–100 caracteres, sem só espaços.
// Regra pura de domínio; a fronteira (CLI/HTTP) chama-a antes de hashear.

import { DomainError } from './error.js';

export function assertPasswordPolicy(plain: string): void {
  if (plain.length < 12 || plain.length > 100 || plain.trim().length === 0) {
    throw new DomainError('weak_password');
  }
}
