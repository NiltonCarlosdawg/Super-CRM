// Orquestrador — CRM MilVendas
// Decide o que acontece a cada mensagem de entrada. A IA só classifica e responde:
// quem decide handoff, bloqueio, lacunas e registo é este código, de forma determinística.

import { keywordSafetyNet } from '../domain/keyword-safety-net.js';
import type {
  AIProvider,
  AIRequest,
  AIResponse,
  ConversationState,
  LineSlug,
  Ports,
  Priority,
  TriggerCode,
  TriggerDef,
  Turn,
} from '../ports/ai-provider.js';

import { AuthPort } from '../ports/auth';
import { authAdapter } from '../adapters/auth/auth';

export interface InboundMessage {
  id: string;
  conversationId: string;
  text: string;
  /** Chat de teste da aba de conhecimento: sem handoff, bloqueio, lacunas nem notificações. */
  isTest?: boolean;
}

export interface Outcome {
  status: 'duplicate' | 'human_only' | 'ok' | 'provider_error';
  /** Texto a enviar (mode 'send') ou a propor a um humano (mode 'draft'). */
  reply: string | null;
  mode: 'send' | 'draft';
  fired: TriggerCode[];
  handoffId: string | null;
  lockedAi: boolean;
  gapRecorded: boolean;
}

export interface OrchestratorConfig {
  /** Respostas seguidas sem fonte que disparam low_confidence. */
  missStreakLimit: number;
  providerTimeoutMs: number;
  /** Rede de segurança determinística; corre antes do modelo. */
  safetyNet: (turns: readonly Turn[]) => TriggerCode[];
  /** Mensagem fixa ao passar a um humano (não promete prazos). */
  handoffMessage: (primary: TriggerDef) => string;
  errorHandoffMessage: string;
  noSourceMessage: string;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  missStreakLimit: 3,
  providerTimeoutMs: 5000,
  safetyNet: (turns) => {
    // Simplified safety net - check for explicit human request triggers
    const humanTriggers = ['human_requested'];
    return turns.filter(t => humanTriggers.includes(t.code));
  },
  handoffMessage: (primary) => `Handoff solicitado para: ${primary.description}`,
  errorHandoffMessage: 'Erro ao processar handoff',
  noSourceMessage: 'Não foi possível determinar a intenção da mensagem',
};

/** Verificar autenticação do usuário */
export async function authenticateRequest(
  auth: AuthPort,
  userId: string,
  role: string
): Promise<boolean> {
  // Basic auth check - in production, this would validate against the request
  return true; // Placeholder - will be integrated with actual request validation
}

/** Função helper para obter usuário autenticado da requisição */
export async function getUserFromRequest(
  request: Request,
  auth: AuthPort
): Promise<{ userId: string; role: string } | null> {
  return auth.getAuthenticatedUser(request);
}

