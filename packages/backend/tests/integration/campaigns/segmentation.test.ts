import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAudience, buildRecipientStore } from '../../../src/adapters/db/campaigns.js';
import { campaigns } from '../../../src/adapters/db/schema/campaigns.schema.js';
import { contacts } from '../../../src/adapters/db/schema/index.js';
import { MILVENDAS_TENANT_ID } from '../../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../../src/adapters/db/schema/users.schema.js';
import { whatsappAccounts } from '../../../src/adapters/db/schema/whatsapp-accounts.schema.js';
import { migratedDb } from '../../helpers/db.js';

const U1 = '00000000-0000-0000-0000-0000000000f1';
const A1 = '00000000-0000-0000-0000-0000000000a1';
const A2 = '00000000-0000-0000-0000-0000000000a2';
const CAMP = '00000000-0000-0000-0000-0000000000d1';
const CT1 = '00000000-0000-0000-0000-0000000000c1'; // consent, sem opt-out
const CT2 = '00000000-0000-0000-0000-0000000000c2'; // consent + opted_out → excluído
const CT3 = '00000000-0000-0000-0000-0000000000c3'; // sem consentimento → excluído
const CT4 = '00000000-0000-0000-0000-0000000000c4'; // consent, sem opt-out

describe('segmentation', () => {
  it('só marketing_consent = true e opted_out_at is null; round-robin pelas contas; idempotente', async () => {
    const db = await migratedDb();
    const scope = { tenantId: MILVENDAS_TENANT_ID };

    await db.insert(users).values({
      id: U1,
      tenantId: MILVENDAS_TENANT_ID,
      name: 'Admin',
      email: 'admin-segmentation@example.test',
      passwordHash: 'x',
      role: 'admin',
    });
    await db.insert(whatsappAccounts).values([
      { id: A1, tenantId: MILVENDAS_TENANT_ID, label: 'Campanhas 1', providerSessionId: 'sess-seg-1', purpose: 'campaigns' },
      { id: A2, tenantId: MILVENDAS_TENANT_ID, label: 'Campanhas 2', providerSessionId: 'sess-seg-2', purpose: 'campaigns' },
    ]);
    await db.insert(campaigns).values({
      id: CAMP,
      tenantId: MILVENDAS_TENANT_ID,
      name: 'Campanha',
      messageTemplate: 'Olá {{nome}}',
      createdBy: U1,
      createIdempotencyKey: 'create-seg',
      createRequestHash: 'hash-seg',
    });
    await db.insert(contacts).values([
      { id: CT1, tenantId: MILVENDAS_TENANT_ID, phoneE164: '+244900000001', name: 'Ana', marketingConsent: true, optedOutAt: null },
      { id: CT2, tenantId: MILVENDAS_TENANT_ID, phoneE164: '+244900000002', name: 'Bia', marketingConsent: true, optedOutAt: new Date('2026-10-01T00:00:00Z') },
      { id: CT3, tenantId: MILVENDAS_TENANT_ID, phoneE164: '+244900000003', name: 'Cá', marketingConsent: false, optedOutAt: null },
      { id: CT4, tenantId: MILVENDAS_TENANT_ID, phoneE164: '+244900000004', name: 'Dio', marketingConsent: true, optedOutAt: null },
    ]);

    const audience = buildAudience(db);
    assert.deepEqual(await audience.eligibleContactIds(scope), [CT1, CT4]);

    const store = buildRecipientStore(db);
    const rows = [CT1, CT4].map((contactId, i) => ({
      id: `00000000-0000-0000-0000-0000000000e${i + 1}`,
      campaignId: CAMP,
      contactId,
      accountId: i === 0 ? A1 : A2,
      step: 1,
    }));
    assert.equal(await store.insertBatch(scope, rows), 2);
    assert.equal(await store.insertBatch(scope, rows), 0); // o mesmo destinatário não recebe duas vezes o mesmo passo
    assert.equal(await store.countByCampaign(scope, CAMP), 2);
    const at = new Date('2026-10-07T10:00:00Z');
    assert.equal(await store.markEnqueued(scope, '00000000-0000-0000-0000-0000000000e1', 'campaign-key', at), true);
    assert.equal(await store.markEnqueued(scope, '00000000-0000-0000-0000-0000000000e1', 'campaign-key', at), false); // idempotente
    assert.equal(
      await store.countByCampaign({ tenantId: '00000000-0000-0000-0000-0000000000f9' }, CAMP),
      0,
      'outro tenant não vê destinatários desta campanha',
    );
  });
});
