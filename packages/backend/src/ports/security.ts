// Port de hash de palavras-passe (docs/03): argon2id por implementação.

export interface PasswordHasher {
  hash(plain: string): Promise<string>; // argon2id
  verify(hash: string, plain: string): Promise<boolean>;
}

// TOTP (docs/03; A2: obrigatório para admin) — RFC 6238, sem dependências.
export interface Totp {
  generateSecret(): string; // 20 bytes → base32 RFC 4648 (32 chars)
  /** Acrescentado à lista do plano: produzir códigos é necessário aos testes
   * (integracão MFA) e `verify` usa-o internamente. */
  generate(secret: string, at?: Date): string;
  otpauthUrl(input: { secret: string; accountEmail: string; issuer: string }): string;
  verify(input: { secret: string; code: string; at?: Date; window?: number }): boolean; // janela ±1 de 30s, window default 1
}
