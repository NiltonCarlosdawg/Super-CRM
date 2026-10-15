// TOTP RFC 6238 (HMAC-SHA1, 6 dígitos, período 30s) e cifra do segredo —
// node:crypto puro, sem dependências (ADR-0006, decisão explícita).
//
// O segredo guardado em BD é SEMPRE cifrado (AES-256-GCM com chave derivada do
// AUTH_SECRET via HKDF-SHA256, info 'crm-totp'): segredos nunca em claro (docs/03).

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Totp } from '../../ports/security.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648, sem padding
const PERIOD_S = 30;
const DIGITS = 6;

/** bytes → base32 RFC 4648 (20 bytes → 32 chars, sem '=') */
function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** base32 RFC 4648 → bytes */
function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('base32 inválido');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP: HMAC-SHA1(secretBytes, counter big-endian 8 bytes) → truncamento dinâmico → 6 dígitos. */
function hotp(secretBytes: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secretBytes).update(msg).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function createTotp(): Totp {
  return {
    generateSecret: () => base32Encode(randomBytes(20)), // 160 bits, RFC 4226

    generate(secret, at = new Date()) {
      const counter = Math.floor(at.getTime() / 1000 / PERIOD_S);
      return hotp(base32Decode(secret), counter);
    },

    otpauthUrl({ secret, accountEmail, issuer }) {
      return (
        `otpauth://totp/${issuer}:${accountEmail}?secret=${secret}` +
        `&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD_S}`
      );
    },

    verify({ secret, code, at = new Date(), window = 1 }) {
      if (!/^\d{6}$/.test(code)) return false;
      const secretBytes = base32Decode(secret);
      const counter = Math.floor(at.getTime() / 1000 / PERIOD_S);
      const expected = Buffer.from(hotp(secretBytes, counter));
      const given = Buffer.from(code);
      let ok = expected.length === given.length && timingSafeEqual(expected, given);
      // janela ±1 (e além, se window > 1) por clock skew
      for (let i = 1; !ok && i <= window; i++) {
        for (const c of [counter - i, counter + i]) {
          if (c < 0) continue;
          const cand = Buffer.from(hotp(secretBytes, c));
          if (cand.length === given.length && timingSafeEqual(cand, given)) ok = true;
        }
      }
      return ok;
    },
  };
}

/** AES-256-GCM: chave = HKDF-SHA256(authSecret, salt '', info 'crm-totp', 32). */
function deriveKey(authSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(authSecret, 'utf8'), '', 'crm-totp', 32));
}

/** Cifra o segredo base32; devolve base64(iv 12B | tag 16B | ciphertext). IV novo por chamada. */
export function encryptSecret(plain: string, authSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(authSecret), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Decifra o blob; chave errada ou blob corrompido lançam (GCM autentica). */
export function decryptSecret(blob: string, authSecret: string): string {
  const raw = Buffer.from(blob, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(authSecret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
