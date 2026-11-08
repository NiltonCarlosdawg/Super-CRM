// Fase 4, Task 9: adaptador BullMQ do tick de campanha. Payload só com IDs;
// o `ensure` recorrente é a fonte dos ticks (um por conta com pendentes).
//
// Ruling (Task 9): a chave do tick inclui o instante de execução. O jobId
// determinístico só por (campanha, conta) ficaria retido para sempre após o
// primeiro tick e a campanha parava; o instante mantém a dedupe por `runAt`
// e deixa o `ensure` reagendar com segurança.

import { z } from 'zod';

import type { TickResult } from '../../application/campaigns/process-campaign-tick.js';
import type { TickScheduler } from '../../ports/campaign-dispatch.js';
import type { JobQueue } from '../../ports/job-queue.js';

export const CAMPAIGN_TICK_QUEUE = 'campaigns.tick';
export const CAMPAIGN_ENSURE_QUEUE = 'campaigns.ensure';

const tickPayload = z.object({ campaignId: z.guid(), accountId: z.guid() });

export function createCampaignTickScheduler(deps: {
  jobs: JobQueue;
  now(): Date;
}): TickScheduler {
  return {
    async ensureTick({ campaignId, accountId, runAt }) {
      await deps.jobs.enqueue(
        CAMPAIGN_TICK_QUEUE,
        { campaignId, accountId },
        {
          idempotencyKey: `campaign:${campaignId}:account:${accountId}:tick:${runAt.getTime()}`,
          correlationId: `campaign:${campaignId}`,
          delayMs: Math.max(0, runAt.getTime() - deps.now().getTime()),
        },
      );
    },
  };
}

export async function registerCampaignTickWorker(deps: {
  jobs: JobQueue;
  runTick(input: { campaignId: string; accountId: string }): Promise<TickResult>;
  ensure(): Promise<{ scheduled: number; completed: number }>;
  ensureEveryMs?: number;
  logger?: (line: string) => void;
}): Promise<void> {
  await deps.jobs.register(CAMPAIGN_TICK_QUEUE, async (payload) => {
    const parsed = tickPayload.safeParse(payload);
    if (!parsed.success) throw new Error('campaigns.tick: payload inválido');
    const result = await deps.runTick(parsed.data);
    deps.logger?.(`campaign.tick outcome=${result.outcome} campaign=${parsed.data.campaignId}`);
  });

  await deps.jobs.registerRecurring(
    CAMPAIGN_ENSURE_QUEUE,
    async (payload) => {
      if (Object.keys(payload).length > 0) throw new Error('campaigns.ensure: payload tem de ser vazio');
      await deps.ensure();
    },
    { everyMs: deps.ensureEveryMs ?? 60_000 },
  );
}
