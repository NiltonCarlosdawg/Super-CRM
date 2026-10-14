import { prisma } from '../lib/prisma';

export interface TwoFactorConfig {
  enabled: boolean;
  method: 'totp' | 'sms' | 'email';
  backupCodes: string[];
}

/** Verificar se 2FA está ativado para o usuário */
export async function is2FAEnabled(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user?.twoFactorEnabled === true;
}

/** Gerar códigos de backup */
export async function generateBackupCodes(userId: string): Promise<string[]> {
  const codes = [];
  for (let i = 0; i < 8; i++) {
    codes.push(Math.random().toString(36).substring(2, 8).toUpperCase());
  }
  // Armazenar códigos de backup
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorBackupCodes: codes },
  });
  return codes;
}

/** Verificar código 2FA */
export async function verify2FA(userId: string, code: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const backupCodes = user?.twoFactorBackupCodes || [];
  return backupCodes.includes(code);
}
