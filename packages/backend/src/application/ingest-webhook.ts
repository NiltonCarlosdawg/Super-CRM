// Recepção idempotente de webhooks (Task 20; docs/04 §5): verifica assinatura,
// normaliza e regista UMA linha por evento (chave `provider_event_id` única) e
// enfileira o processamento. A resposta 202 sai ANTES de qualquer processamento
// — o pipeline inteiro corre no job `inbound.process`. Logs só com ip,
// providerEventId e resultado (nunca o corpo, docs/03).

import { insertInboundEvent } from '../adapters/db/inbound.js';
import type { DbClient } from '../adapters/db/index.js';
import type { JobQueue } from '../ports/job-queue.js';
import type { MessagingProvider } from '../ports/messaging-provider.js';

export async function ingestWebhook(
  deps: {
    db: DbClient;
    provider: MessagingProvider;
    jobs: JobQueue;
    now(): Date;
    logger: { warn(obj: object, msg?: string): void };
  },
  input: { headers: Record<string, string | undefined>; rawBody: Buffer; ip: string },
): Promise<{ accepted: number; duplicates: number }> {
  // WebhookError('invalid_signature' | 'payload_invalid') propaga → a rota
  // responde 401/400 (verificação e parse na fronteira do adaptador, docs/04 §5).
  const events = deps.provider.verifyAndParseWebhook(input.headers, input.rawBody);

  let accepted = 0;
  let duplicates = 0;
  for (const ev of events) {
    const row = await insertInboundEvent(deps.db, {
      providerEventId: ev.providerEventId,
      payload: ev, // jsonb: o timestamp serializa como ISO (reidratado no job)
    });
    if (row === null) {
      duplicates += 1; // redelivery: o job enfileirado continua a existir
      continue;
    }
    accepted += 1;
    await deps.jobs.enqueue(
      'inbound.process',
      { eventId: row.id, correlationId: `webhook:${ev.providerEventId}` },
      {
        idempotencyKey: `inbound-event:${ev.providerEventId}`,
        correlationId: `webhook:${ev.providerEventId}`,
      },
    );
  }

  if (duplicates > 0) {
    deps.logger.warn(
      { ip: input.ip, accepted, duplicates, providerEventIds: events.map((e) => e.providerEventId) },
      'webhook.ingest',
    );
  }
  return { accepted, duplicates };
}
