import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAudience, buildRecipientStore } from '../../../src/adapters/db/campaigns.js';
import { campaigns } from '../../../src/adapters/db/schema/campaigns.schema.js';
import { contacts } from '../../../src/adapters/db/schema/index.js';
import { MILVENDAS_TENANT_ID } from '../../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../../src/adapters/db/schema/users.schema.js';
import { whatsappAccounts } from '../../../src/adapters/db/schema/whatsapp-accounts.schema.js';
import { makeApplyOptOut } from '../../../src/application/campaigns/apply-opt-out.js';
import { makeInboundEffects } from '../../../src/application/campaigns/inbound-effects.js';
import type { Audit } from '../../../src/ports/audit.js';
import { migratedDb } from '../../helpers/db.js';

const U1 = '00000000-0000-0000-0000-0000000000f1';
const A1 = '00000000-0000-0000-0000-0000000000a1';
const CT1 = '00000000-0000-0000-0000-0000000000c1';
const CAMP1 = '00000000-0000-0000-0000-0000000000d1';
const AT = new Date('2026-10-07T10:00:00Z');
const audit: Audit = { async record() {} };

async function seed() {
  const db = await migratedDb();
  await db.insert(users).values({
    id: U1,
    tenantId: MILVENDAS_TENANT_ID,
    name: 'Admin',
    email: 'admin-inbound-effects@example.test',
    passwordHash: 'x',
    role: 'admin',
  });
  await db.insert(whatsappAccounts).values({
    id: A1,
    tenantId: MILVENDAS_TENANT_ID,
    label: 'Campanhas',
    providerSessionId: 'sess-inbound-effects',
    purpose: 'campaigns',
  });
  await db.insert(contacts).values({
    id: CT1,
    tenantId: MILVENDAS_TENANT_ID,
    phoneE164: '+244900000021',
    name: 'Ana',
    marketingConsent: true,
  });
  await db.insert(campaigns).values({
    id: CAMP1,
    tenantId: MILVENDAS_TENANT_ID,
    name: 'Campanha 1',
    messageTemplate: 'Olá {{nome}}',
    createdBy: U1,
    createIdempotencyKey: 'create-inbound',
    createRequestHash: 'hash-inbound',
  });
  const audience = buildAudience(db);
  const recipients = buildRecipientStore(db);
  const effects = makeInboundEffects({
    applyOptOutFor: (tenantId) =>
      makeApplyOptOut({ scope: { tenantId }, audience, recipients, audit }),
    recipients,
    keywords: ['sair'],
  });
  return { db, audience, recipients, effects, scope: { tenantId: MILVENDAS_TENANT_ID } };
}

describe('inbound campaign effects', () => {
  it('"SAIR" → opt-out imediato e não conta como resposta', async () => {
    const { db, audience, recipients, effects, scope } = await seed();
    await recipients.insertBatch(scope, [
      { id: '00000000-0000-0000-0000-0000000000e1', campaignId: CAMP1, contactId: CT1, accountId: A1, step: 1 },
    ]);
    await recipients.markEnqueued(scope, '00000000-0000-0000-0000-0000000000e1', 'k1', AT);

    assert.deepEqual(await effects({ tenantId: MILVENDAS_TENANT_ID, contactId: CT1, text: 'SAIR', receivedAt: AT }), {
      optedOut: true,
      repliesMarked: 0,
    });
    assert.ok(!(await audience.eligibleContactIds(scope)).includes(CT1));
    const [row] = await db.select({ optedOutAt: contacts.optedOutAt }).from(contacts);
    assert.ok(row?.optedOutAt instanceof Date);
  });

  it('resposta normal → destinatário enviados ficam replied', async () => {
    const { recipients, effects, scope } = await seed();
    await recipients.insertBatch(scope, [
      { id: '00000000-0000-0000-0000-0000000000e2', campaignId: CAMP1, contactId: CT1, accountId: A1, step: 1 },
    ]);
    await recipients.markEnqueued(scope, '00000000-0000-0000-0000-0000000000e2', 'k2', AT);

    assert.deepEqual(await effects({ tenantId: MILVENDAS_TENANT_ID, contactId: CT1, text: 'Muito obrigado!', receivedAt: AT }), {
      optedOut: false,
      repliesMarked: 1,
    });
    assert.deepEqual(await effects({ tenantId: MILVENDAS_TENANT_ID, contactId: CT1, text: 'Muito obrigado!', receivedAt: AT }), {
      optedOut: false,
      repliesMarked: 0,
    }); // idempotente
  });
});
