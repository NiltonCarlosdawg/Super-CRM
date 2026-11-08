// Fase 4, Task 7: aplicar opt-out a um contacto — retira-o da segmentação e
// de todas as campanhas (pendentes passam a `opted_out`, já enviadas mantêm o
// estado mas ganham `opted_out_at`). Idempotente.

import { z } from 'zod';

import type { ContactAudience } from '../../ports/campaign-audience.js';
import type { CampaignRecipientStore } from '../../ports/campaign-recipients.js';
import type { Audit } from '../../ports/audit.js';
import type { TenantScope } from '../../ports/tenancy.js';
import { CampaignError } from './create-campaign.js';

export interface ApplyOptOutInput {
  contactId: string;
  at: Date;
  source: 'inbound_message' | 'manual';
}

export type ApplyOptOut = (input: ApplyOptOutInput) => Promise<{
  optedOut: boolean;
  recipientsUpdated: number;
}>;

export interface ApplyOptOutDeps {
  scope: TenantScope;
  audience: ContactAudience;
  recipients: CampaignRecipientStore;
  audit: Audit;
}

const inputSchema = z.object({
  contactId: z.guid(),
  at: z.date(),
  source: z.enum(['inbound_message', 'manual']),
});

export function makeApplyOptOut(deps: ApplyOptOutDeps): ApplyOptOut {
  return async (input) => {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new CampaignError('invalid_input', 400, 'pedido de opt-out inválido');
    }
    const body = parsed.data;

    const optedOut = await deps.audience.markOptedOut(deps.scope, body.contactId, body.at);
    if (!optedOut) return { optedOut: false, recipientsUpdated: 0 };

    const recipientsUpdated = await deps.recipients.markOptedOutByContact(
      deps.scope,
      body.contactId,
      body.at,
    );

    await deps.audit.record({
      tenantId: deps.scope.tenantId,
      actorId: null,
      action: 'contact.opted_out',
      entity: 'contact',
      entityId: body.contactId,
      detail: { source: body.source },
      at: body.at,
    });

    return { optedOut: true, recipientsUpdated };
  };
}
