// Fase 3, Task 17: processa uma mensagem de entrada pelo orquestrador e liga os
// efeitos REAIS — rascunho em `ai_drafts` (ai_suggest) ou outbox (ai_active) —
// sem nunca chamar o envio direto (docs/01 §8: WhatsApp só sai pela outbox).
//
// Caminho ADITIVO ao `handleInboundEvent` da Fase 1 (que, por ser anterior à
// tabela `ai_drafts`, só fazia log do rascunho): aqui o rascunho é PERSISTIDO e
// fica pendente de aprovação (Task 18). Não substitui nem toca na Fase 1.
//
// Review Focus nº 1: se o processamento LANÇA (qualquer passo), o claim do
// evento é libertado para o retry do job voltar a conseguir claimar sem esperar
// o TTL — é este o contrato que este módulo garante no caminho de erro.

import type { AIConfig } from '../adapters/ai/config.js';
import { isOpenAt, nextOpening } from '../domain/business-hours.js';
import type { Settings } from '../modules/settings/settings.js';
import type { AIProvider, Ports, TriggerCode } from '../ports/ai-provider.js';
import {
  handleInbound,
  type InboundMessage,
  type OrchestratorConfig,
  type Outcome,
} from './orchestrator.js';

/** Claim do evento (Task 16 `releaseClaim`): libertar no caminho de erro. */
export interface MessageClaimsPort {
  release(eventId: string): Promise<void>;
}

/** Outbox com a forma fixada pela Fase 1 Task 17. */
export interface OutboxEnqueue {
  enqueue(input: {
    accountId: string;
    contactId: string;
    conversationId: string;
    sender: 'ai';
    text: string;
    idempotencyKey: string;
    scheduledAt?: Date;
  }): Promise<{ outboxId: string; duplicate: boolean }>;
}

/** Rascunhos (Task 2): cria uma linha em `ai_drafts` pendente de aprovação. */
export interface DraftsRepo {
  create(input: {
    conversationId: string;
    text: string;
    firedTriggers: TriggerCode[];
  }): Promise<string>;
}

export interface ProcessInboundDeps {
  ports: Ports;
  provider: AIProvider;
  claims: MessageClaimsPort;
  settings: Settings;
  aiCfg: AIConfig;
  outbox: OutboxEnqueue;
  drafts: DraftsRepo;
  /**
   * accountId/contactId da conversa — o enqueue da outbox exige-os e vêm da
   * conversa carregada (o `msg` só leva `conversationId`).
   */
  loadConversation(conversationId: string): Promise<{ accountId: string; contactId: string }>;
}

/** Mapeia Settings + AIConfig para a config do orquestrador (defaults do domínio no resto). */
export function buildOrchestratorConfig(s: Settings, aiCfg: AIConfig): Partial<OrchestratorConfig> {
  return {
    isOpen: (at: Date) => isOpenAt(at, s.businessHours),
    nextOpening: (at: Date) => nextOpening(at, s.businessHours),
    now: () => new Date(),
    missStreakLimit: aiCfg.missStreakLimit,
    handoffMessage: (t) => s.handoffMessages.byTrigger[t.code] ?? s.handoffMessages.default,
    outOfHoursHandoffMessage: () => s.handoffMessages.outOfHours,
    providerTimeoutMs: aiCfg.timeoutMs,
  };
}

export async function processInbound(
  d: ProcessInboundDeps,
  msg: InboundMessage,
): Promise<Outcome> {
  try {
    const outcome = await handleInbound(
      d.ports,
      d.provider,
      msg,
      buildOrchestratorConfig(d.settings, d.aiCfg),
    );

    // duplicate / human_only / sem resposta → nenhum efeito.
    if (outcome.reply === null) return outcome;

    if (outcome.mode === 'draft') {
      // ai_suggest: só cria o rascunho (aprovação é a Task 18); NADA é enviado.
      await d.drafts.create({
        conversationId: msg.conversationId,
        text: outcome.reply,
        firedTriggers: outcome.fired,
      });
    } else {
      // ai_active: enfileira (WhatsApp só sai pela outbox); idempotente por evento.
      const conv = await d.loadConversation(msg.conversationId);
      await d.outbox.enqueue({
        accountId: conv.accountId,
        contactId: conv.contactId,
        conversationId: msg.conversationId,
        sender: 'ai',
        text: outcome.reply,
        idempotencyKey: `inbound:${msg.id}`,
      });
    }
    return outcome;
  } catch (err) {
    // Review Focus nº 1: liberta o claim (best-effort) para o retry voltar a
    // claimar sem esperar o TTL; o erro ORIGINAL é sempre propagado.
    await d.claims.release(msg.id).catch(() => undefined);
    throw err;
  }
}
