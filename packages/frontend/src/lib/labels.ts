// Rótulos PT-AO partilhados por toda a UI (docs do desenho, Global
// Constraints). Tarefas futuras acrescentam os seus vocabulários aqui.

import type { AccountPurpose, AccountStatus, AiMode, MessageStatus, Role } from "./types";
import type { HandoffPriority } from "./socket";
import type { SessionError } from "./auth";

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

/** Estado activo/inactivo do utilizador (coluna `active` de UserSummary). */
export function userStatusLabel(active: boolean): string {
  return active ? "Activo" : "Inactivo";
}

/** Estado optimista do composer enquanto o POST está no ar. */
export function composerSendingLabel(): string {
  return "A enviar…";
}

// --- Registo público (Onda 1, Task 9) ---

/** Dica da palavra-passe no form de registo (a política real é do servidor). */
export const PASSWORD_HINT = "Mínimo de 12 caracteres (a validação é feita no servidor)";

/** Códigos do problem+json de POST /v1/auth/register → copy PT-AO. */
const REGISTER_ERRORS: Record<string, string> = {
  email_already_exists: "Email já registado — entra ou usa outro email",
  weak_password: "A palavra-passe é demasiado fraca — usa pelo menos 12 caracteres",
  rate_limited: "Muitas tentativas — tenta de novo dentro de um minuto",
  network: "Sem ligação ao servidor",
};

/** Mensagem de erro do registo; o resto cai no detail do backend. */
export function registerErrorText(error: SessionError | null): string | null {
  if (error === null) return null;
  return REGISTER_ERRORS[error.title] ?? error.detail ?? "Erro ao criar a conta";
}

const HANDOFF_PRIORITY_LABELS: Record<HandoffPriority, string> = {
  urgent: "Urgente",
  high: "Alta",
  normal: "Normal",
};

export function handoffPriorityLabel(priority: HandoffPriority): string {
  return HANDOFF_PRIORITY_LABELS[priority];
}
