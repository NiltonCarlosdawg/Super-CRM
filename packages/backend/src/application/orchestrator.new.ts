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
}

/** Middleware de autenticação para rotas de mensagem */
export async function withAuth(
  handler: (ports: Ports, provider: AIProvider, msg: InboundMessage, cfg?: any) => Promise<Outcome>,
  ports: Ports,
  provider: AIProvider,
  msg: InboundMessage
): Promise<Outcome> {
  // Verificar autenticação
  const user = await authAdapter.getAuthenticatedUser();
  if (!user) {
    return { status: 'provider_error', reply: 'Não autenticado' };
  }
  
  // Adicionar contexto de usuário à mensagem
  msg.from = user.userId; // Quem está enviando (ID do usuário)
  
  return handler(ports, provider, msg);
}

