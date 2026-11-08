// Fase 4, Task 10: retoma SÓ por ação humana. Sem actorId não há retoma —
// nenhum job nem a IA podem tirar uma campanha de `paused` (docs/04 §7).

import type { Campaign } from '../../domain/campaigns/types.js';
import type { CampaignRepository } from '../../ports/campaigns.js';
import type { Audit } from '../../ports/audit.js';
import type { TenantScope } from '../../ports/tenancy.js';
import { CampaignError } from './create-campaign.js';

export interface ResumeCampaignDeps {
  scope: TenantScope;
  campaigns: CampaignRepository;
  audit: Audit;
}

export type ResumeCampaign = (input: {
  campaignId: string;
  actorId: string;
  now: Date;
}) => Promise<{ campaign: Campaign }>;

export function makeResumeCampaign(deps: ResumeCampaignDeps): ResumeCampaign {
  return async (input) => {
    if (typeof input.actorId !== 'string' || input.actorId.trim() === '') {
      throw new CampaignError('human_required', 400, 'a retoma exige um utilizador humano');
    }
    const campaign = await deps.campaigns.findById(deps.scope, input.campaignId);
    if (campaign === null || campaign.status !== 'paused') {
      throw new CampaignError('invalid_status', 409, 'só campanhas em pausa podem ser retomadas');
    }
    const status =
      campaign.scheduledAt !== null && campaign.scheduledAt > input.now ? 'scheduled' : 'running';
    const resumed = await deps.campaigns.compareAndSetStatus(deps.scope, campaign.id, ['paused'], {
      status,
      pauseReason: null,
      resumedBy: input.actorId,
      resumedAt: input.now,
    });
    if (resumed === null) {
      throw new CampaignError('invalid_status', 409, 'campanha já não estava em pausa');
    }
    await deps.audit.record({
      tenantId: deps.scope.tenantId,
      actorId: input.actorId,
      action: 'campaign.resumed',
      entity: 'campaign',
      entityId: resumed.id,
      detail: { status },
      at: input.now,
    });
    return { campaign: resumed };
  };
}
