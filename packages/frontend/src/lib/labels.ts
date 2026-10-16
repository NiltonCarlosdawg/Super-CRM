// Rótulos PT-AO partilhados por toda a UI (docs do desenho, Global
// Constraints). Tarefas futuras acrescentam os seus vocabulários aqui.

import type { Role } from "./types";

const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrador",
  editor: "Editor",
  agent: "Agente",
};

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}
