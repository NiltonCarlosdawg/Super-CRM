// Fakes em memória das portas de campanhas (Tasks 5–11): sem BD, relógio e ids
// controlados. Só implementam o que os casos de uso exercitam.

import type { Campaign, CampaignStatus, NewCampaign, PauseReason } from '../../../src/domain/campaigns/types.js';
import type {
  AccountPurpose,
  CampaignRepository,
  StatusPatch,
  WhatsAppAccountStub,
} from '../../../src/ports/campaigns.js';
import type { ContactAudience } from '../../../src/ports/campaign-audience.js';
import type { CampaignRecipientStore, NewRecipient } from '../../../src/ports/campaign-recipients.js';
import type { Audit } from '../../../src/ports/audit.js';
import type { TenantScope } from '../../../src/ports/tenancy.js';
import { createCampaign, type CreateCampaign } from '../../../src/application/campaigns/create-campaign.js';
import { startCampaign, type StartCampaign } from '../../../src/application/campaigns/start-campaign.js';

export const FAKE_TENANT = '00000000-0000-0000-0000-0000000000f0';
export const FAKE_U1 = '00000000-0000-0000-0000-0000000000f1';
export const A_SUP = '00000000-0000-0000-0000-0000000000a1';
export const A_CAMP = '00000000-0000-0000-0000-0000000000a2';

export interface FakeAuditCall {
  tenantId: string | null;
  actorId: string | null;
  action: string;
  entity: string;
  entityId: string;
  at: Date;
}

export interface FakeAudit extends Audit {
  calls: FakeAuditCall[];
}

export function makeAudit(): FakeAudit {
  const calls: FakeAuditCall[] = [];
  return {
    calls,
    async record(input) {
      calls.push({
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        at: input.at,
      });
    },
  };
}

export interface FakeCampaignRepository extends CampaignRepository {
  rows: Campaign[];
}

export function makeCampaignRepository(): FakeCampaignRepository {
  const rows: Campaign[] = [];
  const asFull = (c: NewCampaign, at: Date): Campaign => ({
    ...c,
    status: 'draft',
    scheduledAt: null,
    pauseReason: null,
    pausedAt: null,
    pausedBy: null,
    resumedBy: null,
    resumedAt: null,
    startIdempotencyKey: null,
    startRequestHash: null,
    createdAt: at,
    updatedAt: at,
  });

  return {
    rows,
    async insert(scope, c) {
      if (c.tenantId !== scope.tenantId) throw new Error('cross-tenant insert');
      const row = asFull(c, new Date());
      rows.push(row);
      return row;
    },
    async findById(scope, id) {
      return rows.find((r) => r.tenantId === scope.tenantId && r.id === id) ?? null;
    },
    async findByIdempotencyKey(scope, key) {
      return (
        rows.find((r) => r.tenantId === scope.tenantId && r.createIdempotencyKey === key) ?? null
      );
    },
    async list(scope, input) {
      const items = rows.filter((r) => r.tenantId === scope.tenantId).slice(0, input.limit);
      return { items, nextCursor: null };
    },
    async compareAndSetStatus(scope, id, expected, patch: StatusPatch) {
      const row = rows.find((r) => r.tenantId === scope.tenantId && r.id === id);
      if (row === undefined || !expected.includes(row.status)) return null;
      Object.assign(row, patch);
      return row;
    },
  };
}

export interface FakeAccountsOptions {
  accounts?: WhatsAppAccountStub[];
  accountsMissing?: string[];
}

export function makeAccountGate(opts: FakeAccountsOptions = {}) {
  const accounts: WhatsAppAccountStub[] = opts.accounts ?? [
    { id: A_CAMP, purpose: 'campaigns', status: 'connected', createdAt: new Date('2026-10-01T00:00:00Z') },
  ];
  const missing = new Set(opts.accountsMissing ?? []);
  return {
    async find(_scope: TenantScope, ids: readonly string[]) {
      return accounts.filter((a) => ids.includes(a.id) && !missing.has(a.id));
    },
  };
}

export function makeCreateDeps(opts: FakeAccountsOptions = {}): {
  create: CreateCampaign;
  audit: FakeAudit;
  campaigns: FakeCampaignRepository;
  accounts: ReturnType<typeof makeAccountGate>;
} {
  const audit = makeAudit();
  const campaigns = makeCampaignRepository();
  const accounts = makeAccountGate(opts);
  let ids = 0;
  const create = createCampaign({
    scope: { tenantId: FAKE_TENANT },
    accounts,
    campaigns,
    audit,
    now: () => new Date('2026-10-07T10:00:00Z'),
    newId: () => `00000000-0000-0000-0000-0000000000${String(++ids).padStart(2, '0')}`,
  });
  return { create, audit, campaigns, accounts };
}

export type { CampaignStatus, PauseReason };

export interface FakeRecipientStore extends CampaignRecipientStore {
  calls: string[];
  lastRows: NewRecipient[];
  rows: NewRecipient[];
}

export function makeRecipientStore(calls: string[] = []): FakeRecipientStore {
  const rows: NewRecipient[] = [];
  const store: FakeRecipientStore = {
    calls,
    lastRows: [],
    rows,
    async insertBatch(_scope, batch) {
      calls.push('insertBatch');
      store.lastRows = [...batch];
      let created = 0;
      for (const r of batch) {
        const dup = rows.some(
          (x) => x.campaignId === r.campaignId && x.contactId === r.contactId && x.step === r.step,
        );
        if (dup) continue;
        rows.push(r);
        created += 1;
      }
      return created;
    },
    async countByCampaign(_scope, campaignId) {
      return rows.filter((r) => r.campaignId === campaignId).length;
    },
    async markEnqueued(recipientId) {
      return rows.some((r) => r.id === recipientId);
    },
  };
  return store;
}

export interface StartDepsOptions {
  campaignId: string;
  allowedAccountIds: readonly string[];
  eligible?: readonly string[];
  purposeNow?: AccountPurpose;
  accounts?: WhatsAppAccountStub[];
}

export interface StartDeps {
  start: StartCampaign;
  audit: FakeAudit;
  campaigns: FakeCampaignRepository;
  recipients: FakeRecipientStore;
  audience: ContactAudience;
}

export function makeStartDeps(opts: StartDepsOptions): StartDeps {
  const audit = makeAudit();
  const calls: string[] = [];
  const recipients = makeRecipientStore(calls);
  const base = makeCampaignRepository();
  const at = new Date('2026-10-01T00:00:00Z');
  base.rows.push({
    id: opts.campaignId,
    tenantId: FAKE_TENANT,
    name: 'Campanha',
    status: 'draft',
    messageTemplate: 'Olá {{nome}}, temos novidades!',
    allowedAccountIds: [...opts.allowedAccountIds],
    dailyLimit: null,
    scheduledAt: null,
    pauseReason: null,
    pausedAt: null,
    pausedBy: null,
    resumedBy: null,
    resumedAt: null,
    createIdempotencyKey: 'create-key',
    createRequestHash: 'create-hash',
    startIdempotencyKey: null,
    startRequestHash: null,
    createdBy: FAKE_U1,
    createdAt: at,
    updatedAt: at,
  });

  const campaigns: FakeCampaignRepository = {
    ...base,
    async compareAndSetStatus(scope, id, expected, patch) {
      calls.push('compareAndSetStatus');
      return base.compareAndSetStatus(scope, id, expected, patch);
    },
  };

  const accounts =
    opts.accounts !== undefined
      ? makeAccountGate({ accounts: opts.accounts })
      : makeAccountGate({
          accounts: opts.allowedAccountIds.map((id) => ({
            id,
            purpose: opts.purposeNow ?? 'campaigns',
            status: 'connected',
            createdAt: at,
          })),
        });

  const audience: ContactAudience = {
    async eligibleContactIds() {
      return [...(opts.eligible ?? [])];
    },
  };

  let ids = 0;
  const start = startCampaign({
    scope: { tenantId: FAKE_TENANT },
    accounts,
    campaigns,
    audience,
    recipients,
    audit,
    newId: () => `00000000-0000-0000-0000-0000000000e${String(++ids).padStart(2, '0')}`,
  });

  return { start, audit, campaigns, recipients, audience };
}
