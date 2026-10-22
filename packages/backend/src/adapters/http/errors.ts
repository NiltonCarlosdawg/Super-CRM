// Erros HTTP — RFC 9457 (problem+json) numa única saída (Task 9).
// A fronteira decide o status; o domínio só lança DomainError (docs/02 §1).

import { ZodError } from 'zod';
import { DomainError } from '../../domain/error.js';

export interface ProblemJson {
  type: string;
  title: string;
  status: number;
  detail: string;
  requestId?: string;
  [key: string]: unknown;
}

/** Erro já mapeado para a fronteira: rotas e guards lançam estes. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    readonly headers?: Record<string, string>,
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

/** Mapeamento DomainError → [status, detail]. Chaves fora desta lista = 500. */
const DOMAIN: Record<string, [number, string]> = {
  weak_password: [400, 'password rejeitada pela política (12–100 caracteres, sem só espaços)'],
  unauthenticated: [401, 'sessão ausente, expirada ou revogada'],
  invalid_credentials: [401, 'credenciais inválidas'],
  forbidden: [403, 'papel insuficiente para a operação'],
  csrf_invalid: [403, "header 'x-csrf-token' ausente ou inválido"],
  mfa_required: [403, 'segundo fator pendente: complete o TOTP'],
  cannot_modify_self: [403, 'não pode alterar o próprio papel ou estado'],
  // Onda 1, Task 3: tenant suspenso — plano multitenancy (registo de erros novos)
  tenant_suspended: [403, 'empresa suspensa'],
  not_found: [404, 'recurso não encontrado'],
  user_not_found: [404, 'utilizador não encontrado'],
  email_already_exists: [409, 'email já registado'],
  last_admin: [409, 'não é possível remover o último administrador ativo'],
  // Task 12 (ruling R29): setup TOTP repetido de um utilizador já activo —
  // o segredo activo nunca é rodado sem verify (lockout).
  totp_already_enabled: [409, 'TOTP já ativado nesta conta'],
  // Task 21: paginação e envio de mensagens
  invalid_cursor: [400, 'cursor de paginação inválido'],
  message_empty: [400, 'mensagem vazia ou só espaços'],
  message_too_long: [400, 'texto excede WA_MAX_MESSAGE_CHARS'],
  // Task 18: aprovação/rejeição de rascunhos (ai_suggest)
  draft_rejected: [409, 'rascunho rejeitado não pode ser aprovado'],
  draft_not_pending: [409, 'rascunho não está pendente de aprovação'],
};

export function toProblem(
  err: unknown,
  requestId?: string,
): { status: number; body: ProblemJson } {
  const mk = (status: number, code: string, detail: string) => ({
    status,
    body: { type: `about:blank#${code}`, title: code, status, detail, requestId },
  });

  if (err instanceof HttpError) {
    return mk(err.status, err.code, err.detail ?? err.code);
  }
  if (err instanceof DomainError) {
    const mapped = DOMAIN[err.code];
    if (mapped !== undefined) return mk(mapped[0], err.code, mapped[1]);
  }
  if (err instanceof ZodError) {
    const detail = err.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return mk(400, 'validation_failed', detail);
  }
  // Erros nativos do Fastify (4xx do rate-limit, body inválido, ...): status próprio.
  const e = err as { statusCode?: number; code?: string; message?: string };
  if (typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    return mk(e.statusCode, e.code ?? 'error', e.message ?? 'pedido inválido');
  }
  // Desconhecido: 500 sem ecoar mensagem interna (docs/03 — nada de detalhes aos clientes).
  return mk(500, 'internal_error', 'erro interno');
}
