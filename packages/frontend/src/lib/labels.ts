// Rótulos PT-AO partilhados por toda a UI (docs do desenho, Global
// Constraints). Tarefas futuras acrescentam os seus vocabulários aqui.

import type {
  AccountPurpose,
  AccountStatus,
  AiMode,
  MessageStatus,
  Role,
  TenantStatus,
} from "./types";
import type { HandoffPriority } from "./socket";
import type { SessionError } from "./auth";
import { ApiError } from "./api";

const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrador",
  editor: "Editor",
  agent: "Agente",
  platform_admin: "Plataforma",
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

// --- Definições e reposição de password (Onda 1, Task 11) ---

/** Modal de confirmação de POST /v1/auth/password: mantém a sessão actual,
 * revoga as outras (backend login.ts:112 — `revokeAllForUser(id, sessionId)`). */
export const OWN_PASSWORD_SESSIONS_WARNING =
  "As outras sessões desta conta serão terminadas — a sessão actual mantém-se.";

/** Modal de repo (PATCH /v1/users/:id {password}): revoga TODAS as sessões do alvo. */
export const RESET_PASSWORD_SESSIONS_WARNING =
  "As sessões activas desta conta serão terminadas.";

/** Nota honesta: não existe rota para desactivar TOTP (backend sem endpoint). */
export const TOTP_DISABLE_NOTE =
  "Desactivar o TOTP não está disponível — contacte o suporte.";

export const PASSWORD_CHANGED_MESSAGE = "Palavra-passe alterada";
export const PASSWORD_RESET_MESSAGE = "Palavra-passe reposta";
export const TOTP_ENABLED_MESSAGE = "TOTP activado";

/** Toast honesto de RequireAdmin(notice) em /accounts (admin-only no cliente). */
export const ACCOUNTS_FORBIDDEN_NOTICE =
  "Acesso restrito: só administradores podem abrir as Contas.";

/** Códigos do problem+json de POST /v1/auth/password → copy PT-AO. */
const PASSWORD_CHANGE_ERRORS: Record<string, string> = {
  invalid_credentials: "A palavra-passe actual está incorrecta",
  weak_password: "A palavra-passe é demasiado fraca — usa pelo menos 12 caracteres",
  network: "Sem ligação ao servidor",
};

/** Códigos do problem+json de POST /v1/auth/totp/* → copy PT-AO. */
const TOTP_ERRORS: Record<string, string> = {
  invalid_code: "Código inválido — tenta de novo",
  network: "Sem ligação ao servidor",
};

function problemText(error: unknown, map: Record<string, string>, fallback: string): string {
  if (error instanceof ApiError) return map[error.title] ?? error.detail ?? fallback;
  return "Erro inesperado";
}

/** Erro da mudança da password própria (a política e a sessão são do servidor). */
export function passwordChangeErrorText(error: unknown): string {
  return problemText(error, PASSWORD_CHANGE_ERRORS, "Erro ao mudar a palavra-passe");
}

/** Erro do setup/verify de TOTP (o código inválido vem do servidor — 400). */
export function totpErrorText(error: unknown): string {
  return problemText(error, TOTP_ERRORS, "Erro ao configurar o TOTP");
}

// --- Plataforma (Onda 1, Task 10) ---

const TENANT_STATUS_LABELS: Record<TenantStatus, string> = {
  active: "Activo",
  suspended: "Suspenso",
};

/** Estado do tenant na lista de plataforma (coluna `status` de TenantListItem). */
export function tenantStatusLabel(status: TenantStatus): string {
  return TENANT_STATUS_LABELS[status];
}
