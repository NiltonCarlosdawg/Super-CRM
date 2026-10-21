// Fase 3, Task 17: chat de teste da aba de conhecimento (docs/05). Corre o
// orquestrador com `isTest: true` — sem handoff, bloqueio, lacunas nem
// notificações (o `canAct` e o `recordGap` são desligados pelo `isTest`) — e
// devolve `{ reply, sources }`. Os `sources` são lidos do `answer_trace`
// gravado pelo `saveTrace` do orquestrador (fonte única da resposta).

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';

import type { AIConfig } from '../../adapters/ai/config.js';
import type { DbClient } from '../../adapters/db/index.js';
import { buildOrchestratorConfig } from '../../application/process-inbound.js';
import { handleInbound } from '../../application/orchestrator.js';
import type { AIProvider, Ports, SourceRef } from '../../ports/ai-provider.js';
import type { Settings } from '../settings/settings.js';
import { answerTraces } from './knowledge.schema.js';

export interface TestChatDeps {
  ports: Ports;
  provider: AIProvider;
  settings: Settings;
  aiCfg: AIConfig;
  /** Conversa de teste alvo (o chat corre sobre ela com `isTest: true`). */
  conversationId: string;
  db: DbClient;
}

export interface TestChatResult {
  reply: string | null;
  sources: SourceRef[];
}

export function createTestChat(d: TestChatDeps) {
  return async function testChat({ text }: { text: string }): Promise<TestChatResult> {
    const outcome = await handleInbound(
      d.ports,
      d.provider,
      // id único por chamada: cada chat de teste claima a sua própria "mensagem".
      { id: `test:${randomUUID()}`, conversationId: d.conversationId, text, isTest: true },
      buildOrchestratorConfig(d.settings, d.aiCfg),
    );

    // Fontes vêm do answer_trace gravado pelo orquestrador (mais recente desta pergunta).
    const [trace] = await d.db
      .select({ sources: answerTraces.sources })
      .from(answerTraces)
      .where(
        and(
          eq(answerTraces.conversationId, d.conversationId),
          eq(answerTraces.question, text),
          eq(answerTraces.isTest, true),
        ),
      )
      .orderBy(desc(answerTraces.createdAt))
      .limit(1);

    return {
      reply: outcome.reply,
      sources: (trace?.sources as SourceRef[] | null) ?? [],
    };
  };
}
