// Estados das mensagens (Task 20; docs/04 §8): o estado SÓ avança
// (queued < sent < delivered < read); `failed` é aceite a partir de
// queued/sent/delivered e é TERMINAL; `read` nunca recua e `failed` não o
// sobrepõe. Eventos atrasados (ex.: 'sent' depois de 'delivered') são no-ops.

import { advanceMessageStatusRow } from '../adapters/db/inbound.js';
import type { DbClient } from '../adapters/db/index.js';
import type { NotifyEvent } from '../ports/notify.js';

export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

const RANK: Record<MessageStatus, number> = { failed: -1, queued: 0, sent: 1, delivered: 2, read: 3 };

export function nextStatus(current: MessageStatus, incoming: MessageStatus): MessageStatus {
  if (current === 'failed') return 'failed'; // terminal
  if (incoming === 'failed') {
    return RANK[current] <= RANK.delivered ? 'failed' : current; // read não recua
  }
  return RANK[incoming] > RANK[current] ? incoming : current; // só avança
}

export async function advanceMessageStatus(
  deps: {
    db: DbClient;
    notifySink: (e: NotifyEvent) => Promise<void>;
    now(): Date;
  },
  input: {
    accountId: string;
    providerMessageId: string;
    status: Exclude<MessageStatus, 'queued'>;
    at: Date;
  },
): Promise<{ changed: boolean }> {
  const result = await advanceMessageStatusRow(deps.db, {
    accountId: input.accountId,
    providerMessageId: input.providerMessageId,
    at: input.at,
    computeNext: (current) => nextStatus(current, input.status),
  });
  if (result.changed) {
    await deps.notifySink({
      type: 'message',
      phase: 'status',
      messageId: result.row.messageId,
      conversationId: result.row.conversationId,
      accountId: input.accountId,
      sender: result.row.sender,
      status: result.row.status,
      providerMessageId: input.providerMessageId,
      createdAt: input.at,
    });
  }
  return { changed: result.changed };
}
