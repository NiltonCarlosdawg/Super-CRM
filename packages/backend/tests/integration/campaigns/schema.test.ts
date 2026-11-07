import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { campaigns, campaignRecipients } from '../../../src/adapters/db/schema/campaigns.schema.js';
import { contacts } from '../../../src/adapters/db/schema/contacts.schema.js';
import { MILVENDAS_TENANT_ID } from '../../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../../src/adapters/db/schema/users.schema.js';
import { whatsappAccounts } from '../../../src/adapters/db/schema/whatsapp-accounts.schema.js';
import { migratedDb } from '../../helpers/db.js';

const U1 = '00000000-0000-0000-0000-0000000000f1';
const A1 = '00000000-0000-0000-0000-0000000000a1';
const CT1 = '00000000-0000-0000-0000-0000000000c1';
const C1 = '00000000-0000-0000-0000-0000000000d1';

/** O Drizzle embrulha o erro do Postgres; o nome do constraint/enum vive no cause. */
function rejectsWith(promise: Promise<unknown>, re: RegExp): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
    const text = `${error instanceof Error ? error.message : String(error)} ${cause instanceof Error ? cause.message : String(cause ?? '')}`;
    return re.test(text);
  });
}

describe('campaign schema', () => {
  it('aplica as migrações do zero e impõe unicidades, enums e FKs', async () => {
    const db = await migratedDb();
    await db.insert(users).values({
      id: U1,
      tenantId: MILVENDAS_TENANT_ID,
      name: 'Admin',
      email: 'admin-campaigns@example.test',
      passwordHash: 'x',
      role: 'admin',
    });
    await db.insert(whatsappAccounts).values({
      id: A1,
      tenantId: MILVENDAS_TENANT_ID,
      label: 'Campanhas',
      providerSessionId: 'sess-campaigns-1',
      purpose: 'campaigns',
    });
    await db.insert(contacts).values({
      id: CT1,
      tenantId: MILVENDAS_TENANT_ID,
      phoneE164: '+244900000001',
    });

    await db.insert(campaigns).values({
      id: C1,
      tenantId: MILVENDAS_TENANT_ID,
      name: 'Promo Outubro',
      messageTemplate: 'Oi {{nome}}',
      createdBy: U1,
      createIdempotencyKey: 'key-1',
    });

    // mesma Idempotency-Key de criação → violação de unicidade parcial
    await rejectsWith(
      db.insert(campaigns).values({
        id: '00000000-0000-0000-0000-0000000000d2',
        tenantId: MILVENDAS_TENANT_ID,
        name: 'Dup',
        messageTemplate: 'Oi',
        createdBy: U1,
        createIdempotencyKey: 'key-1',
      }),
      /create_idempotency_key/,
    );

    await db.insert(campaignRecipients).values({
      id: '00000000-0000-0000-0000-0000000000e1',
      tenantId: MILVENDAS_TENANT_ID,
      campaignId: C1,
      contactId: CT1,
      accountId: A1,
      step: 1,
    });
    // o mesmo destinatário não recebe duas vezes o mesmo passo
    await rejectsWith(
      db.insert(campaignRecipients).values({
        id: '00000000-0000-0000-0000-0000000000e2',
        tenantId: MILVENDAS_TENANT_ID,
        campaignId: C1,
        contactId: CT1,
        accountId: A1,
        step: 1,
      }),
      /campaign_recipients/,
    );

    // estado fora do enum
    await rejectsWith(
      db.execute(sql`
      insert into campaign_recipients (id, tenant_id, campaign_id, contact_id, account_id, step, status)
      values ('00000000-0000-0000-0000-0000000000e3', ${MILVENDAS_TENANT_ID}, ${C1}, ${CT1}, ${A1}, 1, 'batting')
    `),
      /recipient_status/,
    );

    // FK para contacto inexistente
    await rejectsWith(
      db.insert(campaignRecipients).values({
        id: '00000000-0000-0000-0000-0000000000e4',
        tenantId: MILVENDAS_TENANT_ID,
        campaignId: C1,
        contactId: '00000000-0000-0000-0000-000000000099',
        accountId: A1,
        step: 1,
      }),
      /campaign_recipients_contact_id/,
    );
  });
});
