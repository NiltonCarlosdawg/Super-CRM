// Módulo "Definições da aplicação" — CRM MilVendas (Fase 3)
// Configuração operacional por tenant: horário de atendimento (A6), mensagens de
// handoff fixas (D14), SLA e modo de IA por defeito (D13). A validação é zod e
// NUNCA corrige silenciosamente: valor inválido LANÇA (Global Constraint do plano).
// O schema de persistência (app_settings, por tenant) vive em settings.schema.ts.

import { z } from 'zod';

import type { DbClient } from '../../adapters/db/index.js';
import { appSettings } from './settings.schema.js';
import type { AiMode, LineSlug } from '../../ports/ai-provider.js';

export interface Settings {
  businessHours: { timezone: string; days: number[]; open: string; close: string };
  handoffMessages: { default: string; outOfHours: string; byTrigger: Record<string, string> };
  sla: { acceptAlertMinutes: number; firstResponseMinutes: number };
  aiModeDefault: { global: AiMode; byLine: Partial<Record<LineSlug, AiMode>> };
}

const aiModeSchema = z.enum(['ai_active', 'ai_suggest', 'human_only']);
const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

const timezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'timezone inválida' },
);

const businessHoursSchema = z.object({
  timezone: timezoneSchema.default('Africa/Luanda'),
  days: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
  open: hhmmSchema.default('08:00'),
  close: hhmmSchema.default('17:00'),
});

const handoffMessagesSchema = z.object({
  default: z
    .string()
    .default(
      'Vou passar esta conversa a um colega da equipa, que continua consigo. Sou um assistente virtual.',
    ),
  outOfHours: z
    .string()
    .default(
      'Registei o teu pedido — a equipa responde no próximo dia útil. Entretanto posso ajudar com outras perguntas.',
    ),
  byTrigger: z.record(z.string(), z.string()).default({}),
});

const slaSchema = z.object({
  acceptAlertMinutes: z.number().int().positive().default(15),
  firstResponseMinutes: z.number().int().positive().default(120),
});

const aiModeDefaultSchema = z.object({
  global: aiModeSchema.default('ai_suggest'),
  byLine: z
    .object({
      software: aiModeSchema.optional(),
      custom: aiModeSchema.optional(),
      telecom: aiModeSchema.optional(),
      cctv: aiModeSchema.optional(),
    })
    .default({}),
});

const settingsSchema = z
  .object({
    businessHours: businessHoursSchema.prefault({}),
    handoffMessages: handoffMessagesSchema.prefault({}),
    sla: slaSchema.prefault({}),
    aiModeDefault: aiModeDefaultSchema.prefault({}),
  })
  .refine((s) => s.businessHours.close > s.businessHours.open, {
    message: 'businessHours.close tem de ser depois de businessHours.open',
    path: ['businessHours'],
  });

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export function parseSettings(raw: unknown): Settings {
  return settingsSchema.parse(raw);
}

/** Secções de `Settings` guardadas como linhas chave/valor (as 4 chaves). */
const SETTINGS_KEYS = ['businessHours', 'handoffMessages', 'sla', 'aiModeDefault'] as const;

type SettingsKey = (typeof SETTINGS_KEYS)[number];

/** Semeia as 4 secções por omissão. Idempotente: devolve o nº de linhas realmente
 *  criadas (4 na 1.ª chamada, 0 nas seguintes — `ON CONFLICT DO NOTHING`). */
export async function ensureSettingsSeed(db: DbClient): Promise<number> {
  const defaults = DEFAULT_SETTINGS as Record<SettingsKey, unknown>;
  const rows = SETTINGS_KEYS.map((key) => ({ key, value: defaults[key] }));
  const inserted = await db
    .insert(appSettings)
    .values(rows)
    .onConflictDoNothing()
    .returning({ key: appSettings.key });
  return inserted.length;
}

/** Lê as 4 secções, validando-as com `parseSettings` (qualquer secção em falta
 *  cai nos defaults; valor inválido LANÇA — nunca corrigido em silêncio). */
export async function readSettings(db: DbClient): Promise<Settings> {
  const rows = await db.select().from(appSettings);
  const raw: Record<string, unknown> = {};
  for (const row of rows) raw[row.key] = row.value;
  return parseSettings(raw);
}
