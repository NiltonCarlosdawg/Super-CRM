// Fase 4, Task 9: o job recorrente `ensure` garante um tick por conta com
// pendentes; campanhas running/scheduled sem pendentes ficam `completed`.

import type { CampaignRepository } from '../../ports/campaigns.js';
import type { CampaignDispatchStore, TickScheduler } from '../../ports/campaign-dispatch.js';
import type { TenantScope } from '../../ports/tenancy.js';

export interface EnsureDeps {
  scope: TenantScope;
  campaigns: CampaignRepository;
  dispatch: CampaignDispatchStore;
  scheduler: TickScheduler;
  now(): Date;
}

export async function ensureCampaignTicks(deps: EnsureDeps): Promise<{
  scheduled: number;
  completed: number;
}> {
  let scheduled = 0;
  let completed = 0;
  let cursor: string | null = null;

  do {
    const page = await deps.campaigns.list(deps.scope, { limit: 100, cursor });
    for (const campaign of page.items) {
      if (campaign.status !== 'running' && campaign.status !== 'scheduled') continue;

      let hasPending = false;
      for (const accountId of campaign.allowedAccountIds) {
        const pending = await deps.dispatch.pendingCountForAccount(
          deps.scope,
          campaign.id,
          accountId,
        );
        if (pending > 0) {
          await deps.scheduler.ensureTick({
            campaignId: campaign.id,
            accountId,
            runAt: deps.now(),
          });
          scheduled += 1;
          hasPending = true;
        }
      }

      if (!hasPending) {
        await deps.campaigns.compareAndSetStatus(
          deps.scope,
          campaign.id,
          ['running', 'scheduled'],
          { status: 'completed' },
        );
        completed += 1;
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);

  return { scheduled, completed };
}
