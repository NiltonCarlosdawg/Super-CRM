// Ponto de entrada do schema da base — CRM MilVendas.
// 16 tabelas base (docs/01 §6: 14 do esboço + sessions por A2 + campaign_accounts
// pelas "contas permitidas"). Os 12 exports do módulo de conhecimento mantêm-se em
// src/modules/knowledge/knowledge.schema.ts.

export * from './enums.js';
export * from './users.schema.js';
export * from './sessions.schema.js';
export * from './whatsapp-accounts.schema.js';
export * from './contacts.schema.js';
export * from './leads.schema.js';
export * from './conversations.schema.js';
export * from './messages.schema.js';
export * from './inbound-events.schema.js';
export * from './outbox.schema.js';
export * from './campaigns.schema.js';
export * from './followups.schema.js';
export * from './audit.schema.js';
