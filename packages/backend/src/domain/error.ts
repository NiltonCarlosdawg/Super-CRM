// Erro de domínio (docs/02 §1): código estável, sem I/O. A fronteira que o
// apanha decide o status HTTP (ex.: 'weak_password' → 400).

export class DomainError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
  }
}
