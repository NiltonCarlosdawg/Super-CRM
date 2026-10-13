import { createCipheriv, decryptiv, randomBytes } from 'crypto';

const algorithm = 'aes-256-gcm';
const key = randomBytes(32);

/** Criptografar dados */
export function encrypt(data: string): { iv: string; encryptedData: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.finalize()]);
  return { iv: encrypted.toString('hex'), encryptedData: encrypted.toString('base64') };
}

/** Descriptografar dados */
export function decrypt(encryptedData: string, iv: string): string {
  const decipher = decipheriv(
    algorithm,
    key,
    Buffer.from(iv, 'hex')
  );
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedData, 'base64')), decipher.finalize()]);
  return decrypted.toString();
}
