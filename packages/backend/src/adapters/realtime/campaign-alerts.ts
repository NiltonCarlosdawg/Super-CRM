// Fase 4, Task 10: alerta de pausa automática para o painel.
//
// Ruling (Task 10): o plano pedia um evento Socket.IO novo (`campaign.paused`),
// mas docs/01 §5/§9 fecham o contrato em 5 eventos e acrescentar um 6.º é uma
// decisão de spec, não de implementação. O alerta usa o evento `alert` já
// existente (fase `campaign.paused`); o audit da pausa fica em pause-campaign.

import type { NotifyEvent } from '../../ports/notify.js';
import type { CampaignAlertSink } from '../../ports/campaign-stats.js';

export function createCampaignAlertSink(deps: {
  notifySink: (e: NotifyEvent) => Promise<void>;
}): CampaignAlertSink {
  return {
    async campaignPaused(input) {
      await deps.notifySink({
        type: 'alert',
        phase: 'campaign.paused',
        tenantId: input.tenantId,
        campaignId: input.campaignId,
        accountId: input.accountId,
        reason: input.reason,
        auto: input.auto,
        at: input.at.toISOString(),
      });
    },
  };
}
