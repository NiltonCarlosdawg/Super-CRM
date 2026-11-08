// Fase 4, Task 5: criar campanha (rascunho) com validação de contas e
// idempotência da API. Nenhum envio: só persiste e audita.

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { validateTemplate } from '../../domain/campaigns/template.js';
import type { Campaign } from '../../domain/campaigns/types.js';
import type { AccountGate, CampaignRepository } from '../../ports/campaigns.js';
import type { Audit } from '../../ports/audit.js';
import type { TenantScope } from '../../ports/tenancy.js';

export interface CreateCampaignInput {
  idempotencyKey: string;
  actorId: string;
  name: string;
  messageTemplate: string;
  allowedAccountIds: readonly string[];
  dailyLimit: number | null;
}

export type CampaignErrorCode =
  | 'invalid_input'
  | 'invalid_template'
  | 'empty_accounts'
  | 'duplicate_account'
  | 'unknown_account'
  | 'unsupported_account_purpose'
  | 'idempotency_conflict';

export class CampaignError extends Error {
  readonly code: CampaignErrorCode;
  readonly status: number;

  constructor(code: CampaignErrorCode, status: number, message: string) {
    super(message);
    this.name = 'CampaignError';
    this.code = code;
    this.status = status;
  }
}

export interface CreateCampaignDeps {
  scope: TenantScope;
  accounts: AccountGate;
  campaigns: CampaignRepository;
  audit: Audit;
  now?: () => Date;
  newId?: () => string;
}

export type CreateCampaign = (input: CreateCampaignInput) => Promise<{ campaign: Campaign; replayed: boolean }>;

const uuid = z.guid();
const inputSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  actorId: uuid,
  name: z.string().min(1).max(120),
  messageTemplate: z.string().min(1).max(4096),
  allowedAccountIds: z.array(uuid).max(10),
  dailyLimit: z.number().int().min(1).nullable(),
});

const requestHash = (v: CreateCampaignInput): string =>
  createHash('sha256')
    .update(JSON.stringify({
      name: v.name,
      messageTemplate: v.messageTemplate,
      allowedAccountIds: [...v.allowedAccountIds].sort(),
      dailyLimit: v.dailyLimit,
    }))
    .digest('hex');

export function createCampaign(deps: CreateCampaignDeps): CreateCampaign {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  return async (input) => {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new CampaignError('invalid_input', 400, 'campanha inválida');
    }
    const body = parsed.data;

    try {
      validateTemplate(body.messageTemplate);
    } catch {
      throw new CampaignError('invalid_template', 400, 'modelo de mensagem inválido');
    }

    const ids = body.allowedAccountIds;
    if (new Set(ids).size !== ids.length) {
      throw new CampaignError('duplicate_account', 400, 'conta repetida');
    }
    if (ids.length === 0) {
      throw new CampaignError('empty_accounts', 400, 'sem contas');
    }

    const accounts = await deps.accounts.find(deps.scope, ids);
    const found = new Set(accounts.map((a) => a.id));
    if (ids.some((id) => !found.has(id))) {
      throw new CampaignError('unknown_account', 400, 'conta inexistente');
    }
    if (accounts.some((a) => a.purpose !== 'campaigns')) {
      throw new CampaignError('unsupported_account_purpose', 400, 'conta não serve para campanhas');
    }

    const hash = requestHash(body);
    const existing = await deps.campaigns.findByIdempotencyKey(deps.scope, body.idempotencyKey);
    if (existing !== null) {
      if (existing.createRequestHash === hash) return { campaign: existing, replayed: true };
      throw new CampaignError('idempotency_conflict', 409, 'Idempotency-Key reutilizada com outro corpo');
    }

    const at = now();
    const campaign = await deps.campaigns.insert(deps.scope, {
      id: newId(),
      tenantId: deps.scope.tenantId,
      name: body.name,
      messageTemplate: body.messageTemplate,
      allowedAccountIds: [...ids],
      dailyLimit: body.dailyLimit,
      createdBy: body.actorId,
      createIdempotencyKey: body.idempotencyKey,
      createRequestHash: hash,
    });

    await deps.audit.record({
      tenantId: deps.scope.tenantId,
      actorId: body.actorId,
      action: 'campaign.created',
      entity: 'campaign',
      entityId: campaign.id,
      detail: { name: campaign.name },
      at,
    });

    return { campaign, replayed: false };
  };
}
