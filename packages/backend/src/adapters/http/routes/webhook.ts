// Rota pública de webhook (Task 20; docs/04 §5): POST /v1/webhooks/wa-akg —
// SEM sessão/CSRF, corpo BRUTO (o HMAC-SHA256 é sobre os bytes exatos; Task 9
// preserva request.rawBody). Resposta rápida 202 — o processamento é o job
// 'inbound.process'. Sem log de corpo: só ip + resultado (docs/03).

import type { FastifyInstance } from 'fastify';
import { ingestWebhook } from '../../../application/ingest-webhook.js';
import { WebhookError } from '../../../ports/messaging-provider.js';
import type { HttpDeps } from '../app.js';
import { HttpError } from '../errors.js';

export async function webhookRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const db = deps.db;
  const provider = deps.waProvider;
  const jobs = deps.jobs;
  if (db === undefined || provider === undefined || jobs === undefined) return;

  app.post('/v1/webhooks/wa-akg', async (request, reply) => {
    const raw = request.rawBody;
    if (raw === undefined) throw new HttpError(400, 'payload_invalid', 'corpo JSON em falta');
    try {
      const result = await ingestWebhook(
        {
          db,
          provider,
          jobs,
          now: deps.now,
          logger: { warn: (o) => request.log.warn(o) },
        },
        {
          headers: request.headers as Record<string, string | undefined>,
          rawBody: raw,
          ip: request.ip,
        },
      );
      return reply.status(202).send({ received: true, events: result.accepted });
    } catch (error) {
      if (error instanceof WebhookError) {
        // invalid_signature → 401; payload_invalid → 400 (problem+json global).
        throw new HttpError(error.code === 'invalid_signature' ? 401 : 400, error.code);
      }
      throw error; // resto → toProblem (500)
    }
  });
}
