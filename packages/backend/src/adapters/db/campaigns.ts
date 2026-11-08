// Fase 4, Task 5: adaptador Drizzle das campanhas. Toda a query é scoped por
// tenant; as contas permitidas vivem na junção `campaign_accounts` (Onda 1).

import { and, asc, count, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';

import type { Campaign, CampaignStatus, NewCampaign } from '../../domain/campaigns/types.js';
import type {
  AccountGate,
  CampaignRepository,
  StatusPatch,
  WhatsAppAccountStub,
} from '../../ports/campaigns.js';
import type { ContactAudience } from '../../ports/campaign-audience.js';
import type { CampaignRecipientStore, NewRecipient } from '../../ports/campaign-recipients.js';
import type { TenantScope } from '../../ports/tenancy.js';
import type { DbClient } from './index.js';
import { campaignAccounts, campaignRecipients, campaigns } from './schema/campaigns.schema.js';
import { contacts } from './schema/contacts.schema.js';
import { whatsappAccounts } from './schema/whatsapp-accounts.schema.js';

type CampaignRow = typeof campaigns.$inferSelect;

const toCampaign = (row: CampaignRow, allowedAccountIds: string[]): Campaign => ({
  id: row.id,
  tenantId: row.tenantId,
  name: row.name,
  status: row.status,
  messageTemplate: row.messageTemplate,
  allowedAccountIds,
  dailyLimit: row.dailyLimit,
  scheduledAt: row.scheduledAt,
  pauseReason: row.pauseReason,
  pausedAt: row.pausedAt,
  pausedBy: row.pausedBy,
  resumedBy: row.resumedBy,
  resumedAt: row.resumedAt,
  createIdempotencyKey: row.createIdempotencyKey,
  createRequestHash: row.createRequestHash,
  startIdempotencyKey: row.startIdempotencyKey,
  startRequestHash: row.startRequestHash,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Cursor opaco `createdAt(ms):id`. */
const parseCursor = (cursor: string | null): { at: Date; id: string } | null => {
  if (cursor === null) return null;
  const [ms, id] = cursor.split(':');
  const at = Number(ms);
  if (!Number.isFinite(at) || id === undefined || id === '') return null;
  return { at: new Date(at), id };
};

export function createCampaignRepositories(deps: { db: DbClient }): {
  accounts: AccountGate;
  campaigns: CampaignRepository;
} {
  const db = deps.db;

  const accountIds = async (tenantId: string, campaignIds: string[]): Promise<Map<string, string[]>> => {
    const out = new Map<string, string[]>();
    if (campaignIds.length === 0) return out;
    const rows = await db
      .select({ campaignId: campaignAccounts.campaignId, accountId: campaignAccounts.accountId })
      .from(campaignAccounts)
      .where(and(eq(campaignAccounts.tenantId, tenantId), inArray(campaignAccounts.campaignId, campaignIds)));
    for (const r of rows) {
      const list = out.get(r.campaignId) ?? [];
      list.push(r.accountId);
      out.set(r.campaignId, list);
    }
    return out;
  };

  const findOne = async (scope: TenantScope, where: ReturnType<typeof eq>): Promise<Campaign | null> => {
    const [row] = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.tenantId, scope.tenantId), where))
      .limit(1);
    if (row === undefined) return null;
    const allowed = (await accountIds(scope.tenantId, [row.id])).get(row.id) ?? [];
    return toCampaign(row, allowed);
  };

  return {
    accounts: {
      async find(scope, ids): Promise<readonly WhatsAppAccountStub[]> {
        if (ids.length === 0) return [];
        const rows = await db
          .select({
            id: whatsappAccounts.id,
            purpose: whatsappAccounts.purpose,
            status: whatsappAccounts.status,
            createdAt: whatsappAccounts.createdAt,
          })
          .from(whatsappAccounts)
          .where(and(eq(whatsappAccounts.tenantId, scope.tenantId), inArray(whatsappAccounts.id, [...ids])));
        return rows;
      },
    },

    campaigns: {
      async insert(scope, c: NewCampaign): Promise<Campaign> {
        return db.transaction(async (tx) => {
          const [row] = await tx
            .insert(campaigns)
            .values({
              id: c.id,
              tenantId: scope.tenantId,
              name: c.name,
              messageTemplate: c.messageTemplate,
              dailyLimit: c.dailyLimit,
              createdBy: c.createdBy,
              createIdempotencyKey: c.createIdempotencyKey,
              createRequestHash: c.createRequestHash,
            })
            .returning();
          if (row === undefined) throw new Error('campaign insert failed');
          if (c.allowedAccountIds.length > 0) {
            await tx.insert(campaignAccounts).values(
              c.allowedAccountIds.map((accountId) => ({
                tenantId: scope.tenantId,
                campaignId: c.id,
                accountId,
              })),
            );
          }
          return toCampaign(row, [...c.allowedAccountIds]);
        });
      },

      findById(scope, id) {
        return findOne(scope, eq(campaigns.id, id));
      },

      findByIdempotencyKey(scope, key) {
        return findOne(scope, eq(campaigns.createIdempotencyKey, key));
      },

      async list(scope, input) {
        const cursor = parseCursor(input.cursor);
        const where =
          cursor === null
            ? eq(campaigns.tenantId, scope.tenantId)
            : and(
                eq(campaigns.tenantId, scope.tenantId),
                or(
                  lt(campaigns.createdAt, cursor.at),
                  and(eq(campaigns.createdAt, cursor.at), lt(campaigns.id, cursor.id)),
                ),
              );
        const rows = await db
          .select()
          .from(campaigns)
          .where(where)
          .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
          .limit(input.limit + 1);
        const page = rows.slice(0, input.limit);
        const accounts = await accountIds(scope.tenantId, page.map((r) => r.id));
        const last = page.at(-1);
        return {
          items: page.map((r) => toCampaign(r, accounts.get(r.id) ?? [])),
          nextCursor: rows.length > input.limit && last !== undefined ? `${last.createdAt.getTime()}:${last.id}` : null,
        };
      },

      async compareAndSetStatus(scope, id, expected: readonly CampaignStatus[], patch: StatusPatch) {
        return db.transaction(async (tx) => {
          const [current] = await tx
            .select({ status: campaigns.status })
            .from(campaigns)
            .where(and(eq(campaigns.tenantId, scope.tenantId), eq(campaigns.id, id)))
            .for('update');
          if (current === undefined || !expected.includes(current.status)) return null;
          const [row] = await tx
            .update(campaigns)
            .set({
              status: patch.status,
              pauseReason: patch.pauseReason,
              pausedAt: patch.pausedAt,
              pausedBy: patch.pausedBy,
              resumedBy: patch.resumedBy,
              resumedAt: patch.resumedAt,
              scheduledAt: patch.scheduledAt,
              startIdempotencyKey: patch.startIdempotencyKey,
              startRequestHash: patch.startRequestHash,
            })
            .where(and(eq(campaigns.tenantId, scope.tenantId), eq(campaigns.id, id)))
            .returning();
          if (row === undefined) return null;
          const allowed = (await accountIds(scope.tenantId, [row.id])).get(row.id) ?? [];
          return toCampaign(row, allowed);
        });
      },
    },
  };
}

// Fase 4, Task 6: audiência elegível e destinatários materializados.

export function buildAudience(db: DbClient): ContactAudience {
  return {
    async eligibleContactIds(scope: TenantScope): Promise<readonly string[]> {
      const rows = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, scope.tenantId),
            eq(contacts.marketingConsent, true),
            isNull(contacts.optedOutAt),
          ),
        )
        .orderBy(asc(contacts.id));
      return rows.map((r) => r.id);
    },

    async markOptedOut(scope, contactId, at): Promise<boolean> {
      const updated = await db
        .update(contacts)
        .set({ optedOutAt: at })
        .where(
          and(
            eq(contacts.tenantId, scope.tenantId),
            eq(contacts.id, contactId),
            isNull(contacts.optedOutAt),
          ),
        )
        .returning({ id: contacts.id });
      return updated.length > 0;
    },
  };
}

export function buildRecipientStore(db: DbClient): CampaignRecipientStore {
  return {
    async insertBatch(scope: TenantScope, rows: readonly NewRecipient[]): Promise<number> {
      if (rows.length === 0) return 0;
      const inserted = await db
        .insert(campaignRecipients)
        .values(
          rows.map((r) => ({
            id: r.id,
            tenantId: scope.tenantId,
            campaignId: r.campaignId,
            contactId: r.contactId,
            accountId: r.accountId,
            step: r.step,
          })),
        )
        .onConflictDoNothing({
          target: [campaignRecipients.campaignId, campaignRecipients.contactId, campaignRecipients.step],
        })
        .returning({ id: campaignRecipients.id });
      return inserted.length;
    },

    async countByCampaign(scope: TenantScope, campaignId: string): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(campaignRecipients)
        .where(
          and(
            eq(campaignRecipients.tenantId, scope.tenantId),
            eq(campaignRecipients.campaignId, campaignId),
          ),
        );
      return row?.n ?? 0;
    },

    async markEnqueued(scope, recipientId, outboxKey, at): Promise<boolean> {
      const updated = await db
        .update(campaignRecipients)
        .set({ status: 'sent', outboxKey, enqueuedAt: at })
        .where(
          and(
            eq(campaignRecipients.tenantId, scope.tenantId),
            eq(campaignRecipients.id, recipientId),
            eq(campaignRecipients.status, 'pending'),
          ),
        )
        .returning({ id: campaignRecipients.id });
      return updated.length > 0;
    },

    async markOptedOutByContact(scope, contactId, at): Promise<number> {
      return db.transaction(async (tx) => {
        const pending = await tx
          .update(campaignRecipients)
          .set({ status: 'opted_out', optedOutAt: at })
          .where(
            and(
              eq(campaignRecipients.tenantId, scope.tenantId),
              eq(campaignRecipients.contactId, contactId),
              eq(campaignRecipients.status, 'pending'),
              isNull(campaignRecipients.optedOutAt),
            ),
          )
          .returning({ id: campaignRecipients.id });
        // Já enviadas/falhadas mantêm o estado; só ganham a marca de opt-out.
        await tx
          .update(campaignRecipients)
          .set({ optedOutAt: at })
          .where(
            and(
              eq(campaignRecipients.tenantId, scope.tenantId),
              eq(campaignRecipients.contactId, contactId),
              isNull(campaignRecipients.optedOutAt),
            ),
          )
          .returning({ id: campaignRecipients.id });
        return pending.length;
      });
    },

    async markRepliedByContact(scope, contactId, at): Promise<number> {
      const updated = await db
        .update(campaignRecipients)
        .set({ status: 'replied', repliedAt: at })
        .where(
          and(
            eq(campaignRecipients.tenantId, scope.tenantId),
            eq(campaignRecipients.contactId, contactId),
            eq(campaignRecipients.status, 'sent'),
            isNull(campaignRecipients.repliedAt),
          ),
        )
        .returning({ id: campaignRecipients.id });
      return updated.length;
    },
  };
}
