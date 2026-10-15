// Port de outbox (docs/01 §6, docs/04 §7) — forma EXATA consumida pela Fase 4
// (CampaignOutbox). Enfileirar é a ÚNICA porta de saída de mensagens: nenhum
// handler HTTP chama send() diretamente. A implementação (transação com
// ON CONFLICT idempotente) vive no adaptador de BD.

export interface Outbox {
  enqueue(input: {
    accountId: string;
    contactId: string;
    conversationId: string;
    sender: 'ai' | 'human' | 'campaign';
    text: string;
    idempotencyKey: string;
    scheduledAt?: Date;
  }): Promise<{ outboxId: string; duplicate: boolean }>;
  /** Filas 'queued' + 'sending' da conta (limite de conversas em voo, docs/04 §7). */
  pendingConversationCount(accountId: string): Promise<number>;
}
