// Rótulos PT-AO partilhados por toda a UI (docs do desenho, Global
// Constraints). Tarefas futuras acrescentam os seus vocabulários aqui.

import type { AccountPurpose, AccountStatus, AiMode, MessageStatus, Role } from "./types";
import type { HandoffPriority } from "./socket";

const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrador",
  editor: "Editor",
  agent: "Agente",
};

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}

const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  connecting: "A ligar",
  connected: "Ligada",
  disconnected: "Desligada",
  suspected_ban: "Suspeita de bloqueio",
};

export function accountStatusLabel(status: AccountStatus): string {
  return ACCOUNT_STATUS_LABELS[status];
}

const ACCOUNT_PURPOSE_LABELS: Record<AccountPurpose, string> = {
  support: "Atendimento",
  sales: "Vendas",
  campaigns: "Campanhas",
};

export function accountPurposeLabel(purpose: AccountPurpose): string {
  return ACCOUNT_PURPOSE_LABELS[purpose];
}

const AI_MODE_LABELS: Record<AiMode, string> = {
  ai_active: "IA activa",
  ai_suggest: "IA só sugere",
  human_only: "Só humanos",
};

export function aiModeLabel(mode: AiMode): string {
  return AI_MODE_LABELS[mode];
}

const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  queued: "Na fila",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  failed: "Falhou",
};

export function messageStatusLabel(status: MessageStatus): string {
  return MESSAGE_STATUS_LABELS[status];
}

/** Estado optimista do composer enquanto o POST está no ar. */
export function composerSendingLabel(): string {
  return "A enviar…";
}

const HANDOFF_PRIORITY_LABELS: Record<HandoffPriority, string> = {
  urgent: "Urgente",
  high: "Alta",
  normal: "Normal",
};

export function handoffPriorityLabel(priority: HandoffPriority): string {
  return HANDOFF_PRIORITY_LABELS[priority];
}
