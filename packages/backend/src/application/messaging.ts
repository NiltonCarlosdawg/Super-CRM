// Envio de mensagens humanas (Task 21; docs/01 §5, docs/04 §7): a outbox é a
// ÚNICA saída — este caso de uso nunca chama o provider. Idempotência por
// Idempotency-Key do chamador: a chave composta é estável, por isso um replay
// devolve a mensagem existente e um corpo diferente na mesma chave é conflito.

import { DomainError } from '../domain/error.js';
import type { Audit } from '../ports/audit.js';
import type { ConversationsRepository, MessageView } from '../ports/conversations.js';
import type { Outbox } from '../ports/outbox.js';

export function createMessageSender(deps: {
  outbox: Outbox;
  repo: ConversationsRepository;
  audit: Audit;
  cfg: { maxMessageChars: number };
  now(): Date;
}) {
  return {
    async sendHumanMessage(input: {
      conversationId: string;
      text: string;
      idempotencyKey: string;
      actorId: string;
      ip: string;
    }): Promise<{ message: MessageView; replayed: boolean } | { conflict: true }> {
      // Fronteira do caso de uso: texto não vazio (sem só espaços) e dentro do
      // limite do WhatsApp (WA_MAX_MESSAGE_CHARS) → DomainError mapeado a 400.
      if (input.text.trim().length === 0) throw new DomainError('message_empty');
      if (input.text.length > deps.cfg.maxMessageChars) throw new DomainError('message_too_long');

      const found = await deps.repo.get(input.conversationId);
      if (found === null) throw new DomainError('not_found');

      const { outboxId, duplicate } = await deps.outbox.enqueue({
        accountId: found.conversation.accountId,
        contactId: found.conversation.contactId,
        conversationId: input.conversationId,
        sender: 'human',
        text: input.text,
        idempotencyKey: `rest:${input.conversationId}:${input.idempotencyKey}`,
      });

      const message = await deps.repo.getMessageByOutbox(outboxId);
      if (message === null) throw new Error('mensagem criada pelo enqueue não encontrada');

      if (duplicate) {
        // Replay: mesmo corpo → devolve a mensagem existente; corpo diferente →
        // a rota responde 409 idempotency_conflict.
        if (message.body === input.text) return { message, replayed: true };
        return { conflict: true };
      }

      // 1.ª entrega: audita (o evento message.created já saiu do enqueue).
      await deps.audit.record({
        actorId: input.actorId,
        action: 'message.sent',
        entity: 'message',
        entityId: message.id,
        detail: { conversationId: input.conversationId },
        at: deps.now(),
        ip: input.ip,
      });
      return { message, replayed: false };
    },
  };
}

export type MessageSender = ReturnType<typeof createMessageSender>;
