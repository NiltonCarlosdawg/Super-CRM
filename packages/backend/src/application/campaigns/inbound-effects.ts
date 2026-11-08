// Fase 4, Task 8: efeitos de uma mensagem de entrada nas campanhas.
// Opt-out primeiro (imediato e não conta como resposta); caso contrário,
// destinatários já enviados ao contacto passam a `replied`.

import { z } from 'zod';

import { detectOptOut } from '../../domain/campaigns/opt-out.js';
import type { CampaignRecipientStore } from '../../ports/campaign-recipients.js';
import type { ApplyOptOut } from './apply-opt-out.js';
import { CampaignError } from './create-campaign.js';

export interface InboundCampaignEffectsInput {
  tenantId: string;
  contactId: string;
  text: string;
  receivedAt: Date;
}

export type InboundCampaignEffects = (input: InboundCampaignEffectsInput) => Promise<{
  optedOut: boolean;
  repliesMarked: number;
}>;

export interface InboundCampaignEffectsDeps {
  /** Uma instância por tenant: o mesmo seam serve todos os tenants do processo. */
  applyOptOutFor: (tenantId: string) => ApplyOptOut;
  recipients: CampaignRecipientStore;
  keywords: readonly string[];
}

const inputSchema = z.object({
  tenantId: z.guid(),
  contactId: z.guid(),
  text: z.string(),
  receivedAt: z.date(),
});

export function makeInboundEffects(deps: InboundCampaignEffectsDeps): InboundCampaignEffects {
  return async (input) => {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new CampaignError('invalid_input', 400, 'evento de entrada inválido');
    }
    const body = parsed.data;

    if (detectOptOut(body.text, deps.keywords)) {
      const result = await deps.applyOptOutFor(body.tenantId)({
        contactId: body.contactId,
        at: body.receivedAt,
        source: 'inbound_message',
      });
      return { optedOut: result.optedOut, repliesMarked: 0 };
    }

    const repliesMarked = await deps.recipients.markRepliedByContact(
      { tenantId: body.tenantId },
      body.contactId,
      body.receivedAt,
    );
    return { optedOut: false, repliesMarked };
  };
}
