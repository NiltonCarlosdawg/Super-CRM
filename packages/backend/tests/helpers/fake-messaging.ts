// Fake do MessagingProvider para testes (Task 9): grava as chamadas de
// sendText/sendMedia e devolve resultados controláveis (Task 13+ usa-o para
// o worker da outbox). Nenhuma rede é tocada.

import type {
  MessagingProvider,
  ProviderEvent,
  SendResult,
  SessionStatus,
} from '../../src/ports/messaging-provider.js';

export function createFakeMessaging() {
  const sendTextCalls: Array<{ sessionId: string; to: string; text: string; idempotencyKey: string }> = [];
  const sendMediaCalls: Array<{ sessionId: string; to: string; mediaUrl: string; caption?: string; mimeType: string; idempotencyKey: string }> = [];
  let nextResult: SendResult | Error = { providerMessageId: 'fake-wa-1', outcome: 'accepted' };

  const provider: MessagingProvider = {
    name: 'fake',
    health: async () => ({ ok: true }),
    createSession: async ({ label }) => ({ sessionId: `fake-session-${label}` }),
    getSession: async (): Promise<{ status: SessionStatus }> => ({ status: 'connected' }),
    getQr: async () => null,
    logout: async () => undefined,
    sendText: async (input) => {
      sendTextCalls.push(input);
      // Task 18: um Error programado é LANÇADO (simula ProviderUnavailableError,
      // timeout, etc.); um SendResult é devolvido normalmente.
      if (nextResult instanceof Error) throw nextResult;
      return { ...nextResult };
    },
    sendMedia: async (input) => {
      sendMediaCalls.push(input);
      if (nextResult instanceof Error) throw nextResult;
      return { ...nextResult };
    },
    verifyAndParseWebhook: (): ProviderEvent[] => [],
  };

  return {
    provider,
    sendTextCalls,
    sendMediaCalls,
    /** Programa o resultado dos próximos envios ('unknown' p/ timeout; Error é lançado). */
    queueResult(result: SendResult | Error): void {
      nextResult = result;
    },
  };
}
