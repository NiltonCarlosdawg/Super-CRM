// Port de hash de palavras-passe (docs/03): argon2id por implementação.

export interface PasswordHasher {
  hash(plain: string): Promise<string>; // argon2id
  verify(hash: string, plain: string): Promise<boolean>;
}
