import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sql } from 'drizzle-orm';

import { buildAudience, buildRecipientStore } from '../../../src/adapters/db/campaigns.js';
import { campaigns } from '../../../src/adapters/db/schema/campaigns.schema.js';
import { contacts } from '../../../src/adapters/db/schema/index.js';
import { MILVENDAS_TENANT_ID } from '../../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../../src/adapters/db/schema/users.schema.js';
import { whatsappAccounts } from '../../../src/adapters/db/schema/whatsapp-accounts.schema.js';
import { makeApplyOptOut } from '../../../src/application/campaigns/apply-opt-out.js';
import type { Audit } from '../../../src/ports/audit.js';
import { migratedDb } from '../../helpers/db.js';

const U1 = '00000000-0000-0000-0000-0000000000f1';
const A1 = '00000000-0000-0000-0000-0000000000a1';
const CT1 = '00000000-0000-0000-0000-0000000000c1';
const CAMP1 = '00000000-0000-0000-0000-0000000000d1';
const CAMP2 = '00000000-0000-0000-0000-0000000000d2';
const AT = new Date('2026-10-07T10:00:00Z');

describe('applyOptOut', () => {
  it('marca o contacto de imediato e sai de TODAS as campanhas (pendentes → opted_out)', async () => {
    const db = await migratedDb();
    const scope = { tenantId: MILVENDAS_TENANT_ID };
    const audience = buildAudience(db);
    const recipients = buildRecipientStore(db);
    const audits: string[] = [];
    const audit: Audit = {
      async record(input) {
        audits.push(input.action);
      },
    };
    const apply = makeApplyOptOut({ scope, audience, recipients, audit });

    await db.insert(users).values({
      id: U1,
      tenantId: MILVENDAS_TENANT_ID,
      name: 'Admin',
      email: 'admin-optout@example.test',
      passwordHash: 'x',
      role: 'admin',
    });
    await db.insert(whatsappAccounts).values({
      id: A1,
      tenantId: MILVENDAS_TENANT_ID,
      label: 'Campanhas',
      providerSessionId: 'sess-optout',
      purpose: 'campaigns',
    });
    await db.insert(contacts).values({
      id: CT1,
      tenantId: MILVENDAS_TENANT_ID,
      phoneE164: '+244900000011',
      name: 'Ana',
      marketingConsent: true,
    });
    await db.insert(campaigns).values([
      {
        id: CAMP1,
        tenantId: MILVENDAS_TENANT_ID,
        name: 'Campanha 1',
        messageTemplate: 'Olá {{nome}}',
        createdBy: U1,
        createIdempotencyKey: 'create-opt-1',
        createRequestHash: 'hash-opt-1',
      },
      {
        id: CAMP2,
        tenantId: MILVENDAS_TENANT_ID,
        name: 'Campanha 2',
        messageTemplate: 'Olá {{nome}}',
        createdBy: U1,
        createIdempotencyKey: 'create-opt-2',
        createRequestHash: 'hash-opt-2',
      },
    ]);

    // r1: pendente na campanha 1; r2: já enviado na campanha 1; r3: pendente na campanha 2
    await recipients.insertBatch(scope, [
      { id: '00000000-0000-0000-0000-0000000000e1', campaignId: CAMP1, contactId: CT1, accountId: A1, step: 1 },
      { id: '00000000-0000-0000-0000-0000000000e2', campaignId: CAMP1, contactId: CT1, accountId: A1, step: 2 },
      { id: '00000000-0000-0000-0000-0000000000e3', campaignId: CAMP2, contactId: CT1, accountId: A1, step: 1 },
    ]);
    assert.equal(await recipients.markEnqueued(scope, '00000000-0000-0000-0000-0000000000e2', 'campaign-key-2', AT), true);

    const first = await apply({ contactId: CT1, at: AT, source: 'inbound_message' });
    assert.deepEqual(first, { optedOut: true, recipientsUpdated: 2 }); // só as pendentes mudam de estado
    const second = await apply({ contactId: CT1, at: AT, source: 'inbound_message' });
    assert.deepEqual(second, { optedOut: false, recipientsUpdated: 0 }); // idempotente
    assert.deepEqual(audits, ['contact.opted_out']);

    assert.ok(!(await audience.eligibleContactIds(scope)).includes(CT1)); // fora da segmentação para sempre
    const rows = await db.execute(
      // leitura directa para provar os dois efeitos: estado só muda em pending; opted_out_at em todas
      sql`select id, status, opted_out_at from campaign_recipients order by id`,
    );
    assert.deepEqual(
      (rows.rows as Array<{ status: string; opted_out_at: Date | null }>).map((r) => r.status),
      ['opted_out', 'sent', 'opted_out'],
    );
    assert.ok((rows.rows as Array<{ opted_out_at: Date | null }>).every((r) => r.opted_out_at !== null));
  });
});
