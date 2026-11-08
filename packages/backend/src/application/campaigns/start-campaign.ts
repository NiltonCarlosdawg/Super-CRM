// Fase 4, Task 6: iniciar campanha. Materializa os destinatários elegíveis
// (consentimento + sem opt-out) e só depois transita draft → scheduled/running;
// a ordem garante que um crash a meio pode ser repetido sem perder destinatários.

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { Campaign } from '../../domain/campaigns/types.js';
import type { AccountGate, CampaignRepository } from '../../ports/campaigns.js';
import type { ContactAudience } from '../../ports/campaign-audience.js';
import type { CampaignRecipientStore } from '../../ports/campaign-recipients.js';
import type { Audit } from '../../ports/audit.js';
import type { TenantScope } from '../../ports/tenancy.js';
import { CampaignError } from './create-campaign.js';

export interface StartCampaignInput {
  campaignId: string;
  idempotencyKey: string;
  actorId: string;
  scheduledAt: Date | null; // null = começar já
  now: Date;
}

export interface StartCampaignDeps {
  scope: TenantScope;
  accounts: AccountGate;
  campaigns: CampaignRepository;
  audience: ContactAudience;
  recipients: CampaignRecipientStore;
  audit: Audit;
  newId?: () => string;
}

export type StartCampaign = (input: StartCampaignInput) => Promise<{
  campaign: Campaign;
  recipientsCreated: number;
  replayed: boolean;
}>;

const inputSchema = z.object({
  campaignId: z.guid(),
  idempotencyKey: z.string().min(1).max(200),
  actorId: z.guid(),
  scheduledAt: z.date().nullable(),
  now: z.date(),
});

const startHash = (scheduledAt: Date | null): string =>
  createHash('sha256')
    .update(JSON.stringify({ scheduledAt: scheduledAt?.toISOString() ?? null }))
    .digest('hex');

export function startCampaign(deps: StartCampaignDeps): StartCampaign {
  const newId = deps.newId ?? randomUUID;

  return async (input) => {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new CampaignError('invalid_input', 400, 'pedido de início inválido');
    }
    const body = parsed.data;
    const hash = startHash(body.scheduledAt);

    const current = await deps.campaigns.findById(deps.scope, body.campaignId);
    if (current === null) {
      throw new CampaignError('invalid_status', 409, 'campanha inexistente');
    }
    if (current.startIdempotencyKey === body.idempotencyKey) {
      if (current.startRequestHash === hash) {
        return { campaign: current, recipientsCreated: 0, replayed: true };
      }
      throw new CampaignError('idempotency_conflict', 409, 'Idempotency-Key reutilizada com outro corpo');
    }
    if (current.status !== 'draft') {
      throw new CampaignError('invalid_status', 409, 'só campanhas em rascunho podem iniciar');
    }

    // Re-valida as contas: o purpose pode ter mudado desde a criação.
    const ids = current.allowedAccountIds;
    const accounts = await deps.accounts.find(deps.scope, ids);
    const found = new Set(accounts.map((a) => a.id));
    if (ids.some((id) => !found.has(id))) {
      throw new CampaignError('unknown_account', 400, 'conta inexistente');
    }
    if (accounts.some((a) => a.purpose !== 'campaigns')) {
      throw new CampaignError('unsupported_account_purpose', 400, 'conta não serve para campanhas');
    }

    const eligible = await deps.audience.eligibleContactIds(deps.scope);
    const rows = eligible.map((contactId, i) => ({
      id: newId(),
      campaignId: current.id,
      contactId,
      accountId: ids[i % ids.length]!,
      step: 1,
    }));
    const created = await deps.recipients.insertBatch(deps.scope, rows);

    const status = body.scheduledAt !== null && body.scheduledAt > body.now ? 'scheduled' : 'running';
    const updated = await deps.campaigns.compareAndSetStatus(deps.scope, current.id, ['draft'], {
      status,
      scheduledAt: body.scheduledAt,
      startIdempotencyKey: body.idempotencyKey,
      startRequestHash: hash,
    });
    if (updated === null) {
      const after = await deps.campaigns.findById(deps.scope, current.id);
      if (after?.startIdempotencyKey === body.idempotencyKey && after.startRequestHash === hash) {
        return { campaign: after, recipientsCreated: 0, replayed: true };
      }
      throw new CampaignError('campaign_already_running', 409, 'campanha já iniciada');
    }

    await deps.audit.record({
      tenantId: deps.scope.tenantId,
      actorId: body.actorId,
      action: 'campaign.started',
      entity: 'campaign',
      entityId: updated.id,
      detail: { recipientsCreated: created, status },
      at: body.now,
    });

    return { campaign: updated, recipientsCreated: created, replayed: false };
  };
}
