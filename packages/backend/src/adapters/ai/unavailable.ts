// IA não configurada (Task 19; docs/05 §3.4): o orquestrador continua a decidir
// — com `respond`/`summarizeForHandoff` a rejeitarem com DomainError, este cai
// no failSafe: mensagem fixa + passagem a humano (ai_active) ou rascunho
// (ai_suggest). Nunca há respostas inventadas sem modelo.

import { DomainError } from '../../domain/error.js';
import type { AIProvider } from '../../ports/ai-provider.js';

export function createUnavailableAiProvider(reason = 'ai_not_configured'): AIProvider {
  return {
    respond: async (): Promise<never> => {
      throw new DomainError(reason);
    },
    summarizeForHandoff: async (): Promise<never> => {
      throw new DomainError(reason);
    },
  };
}
