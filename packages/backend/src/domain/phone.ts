// Normalização de telefones E.164 e máscara para logs (docs/02 §10).
// Domínio puro: sem I/O, sem dependências (docs/02 §1).

/** Devolve `+` e dígitos (10–15) ou null. Nunca infere país. */
export function normalizePhoneE164(input: string): string | null {
  let s = input.trim().replace(/[\s.\-()]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`; // 00 internacional → +
  if (!s.startsWith('+')) return null;
  const digits = s.slice(1);
  if (!/^\d{10,15}$/.test(digits)) return null; // letras/outros caracteres → null
  return `+${digits}`;
}

/** `+244923111222` → `+244 9** *** *12` (docs/02 §10); não-E.164 → `***`. */
export function maskPhone(phone: string): string {
  const m = /^\+(\d{10,15})$/.exec(phone);
  if (!m || m[1] === undefined) return '***';
  const digits = m[1];
  // Código de país: 244 (Angola) se os dígitos assim começarem, senão os 3 primeiros.
  const country = digits.startsWith('244') ? '244' : digits.slice(0, 3);
  const national = digits.slice(country.length);
  // 1.º dígito + '*' até n-3 + últimos 2, agrupado em blocos de 3.
  const masked =
    national.charAt(0) + '*'.repeat(national.length - 3) + national.slice(-2);
  const grouped = (masked.match(/.{1,3}/g) ?? []).join(' ');
  return `+${country} ${grouped}`;
}
