// Rótulos PT-AO partilhados por toda a UI (docs do desenho, Global
// Constraints). Tarefas futuras acrescentam os seus vocabulários aqui.

import type { AccountPurpose, AccountStatus, Role } from "./types";

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
