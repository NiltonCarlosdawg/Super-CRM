// Enums da base de dados — CRM MilVendas
// Único sítio dos enums da base (Task 9). Cada vocabulário vem dos docs, com a
// fonte indicada em comentário. Vocabulários NÃO definidos nos docs ficam como
// `text NOT NULL` na própria tabela e são perguntas do gate (docs/schema-base.md).

import { pgEnum } from 'drizzle-orm/pg-core';

// docs/01 §6: role (admin, editor, agent)
export const userRoleEnum = pgEnum('user_role', ['admin', 'editor', 'agent']);

// docs/01 §6 e docs/04 §6: connecting | connected | disconnected | suspected_ban.
// (`logged_out`/`qr_pending` são estados do contrato de sessão, docs/04 §5 —
// não são estados guardados em whatsapp_accounts.status.)
export const whatsappAccountStatusEnum = pgEnum('whatsapp_account_status', [
  'connecting',
  'connected',
  'disconnected',
  'suspected_ban',
]);

// docs/01 §6 e docs/04 §6: support | sales | campaigns
export const whatsappPurposeEnum = pgEnum('whatsapp_purpose', ['support', 'sales', 'campaigns']);

// docs/01 §6 (direction); valores 'inbound' | 'outbound' usados em
// docs/plans/2026-10-07-fase1-nucleo-whatsapp.md (Task 19/21)
export const messageDirectionEnum = pgEnum('message_direction', ['inbound', 'outbound']);

// docs/01 §6: sender (customer, ai, human, campaign)
export const messageSenderEnum = pgEnum('message_sender', ['customer', 'ai', 'human', 'campaign']);

// docs/04 §5: tipo do contrato ProviderEvent (message.kind)
export const messageKindEnum = pgEnum('message_kind', [
  'text',
  'audio',
  'image',
  'video',
  'document',
  'other',
]);

// docs/01 §6: estado (queued, sent, delivered, read, failed); docs/04 §8: os
// estados só avançam, nunca recuam.
export const messageStatusEnum = pgEnum('message_status', [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
]);

// docs/04 §5: unknown_delivery = timeout de envio sem retry automático (nunca
// duplicar mensagem ao cliente); queued | sending | sent | failed são o ciclo de
// descrito em docs/plans/2026-10-07-fase1-nucleo-whatsapp.md (Task 18).
export const outboxStatusEnum = pgEnum('outbox_status', [
  'queued',
  'sending',
  'sent',
  'failed',
  'unknown_delivery',
]);

// docs/01 §6 (estado da campanha); vocabulário fechado em
// docs/plans/2026-10-07-fase4-campanhas.md (Task 2).
export const campaignStatusEnum = pgEnum('campaign_status', [
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
]);

// docs/01 §6 (estado por destinatário: enviado, falhou, respondeu, opt-out);
// vocabulário fechado em docs/plans/2026-10-07-fase4-campanhas.md (Task 2).
export const campaignRecipientStatusEnum = pgEnum('campaign_recipient_status', [
  'pending',
  'sent',
  'failed',
  'replied',
  'opted_out',
]);
