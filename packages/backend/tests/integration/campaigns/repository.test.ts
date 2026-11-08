import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createCampaignRepositories } from '../../../src/adapters/db/campaigns.js';
import { contacts } from '../../../src/adapters/db/schema/contacts.schema.js';
import { MILVENDAS_TENANT_ID } from '../../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../../src/adapters/db/schema/users.schema.js';
import { whatsappAccounts } from '../../../src/adapters/db/schema/whatsapp-accounts.schema.js';
import { migratedDb } from '../../helpers/db.js';

const U1 = '00000000-0000-0000-0000-0000000000f1';
const A1 = '00000000-0000-0000-0000-0000000000a1';

describe('campaign repository', () => {
  it('insere com contas, pagina por cursor, faz CAS e esconde outro tenant', async () => {
    const db = await migratedDb();
    await db.insert(users).values({
      id: U1,
      tenantId: MILVENDAS_TENANT_ID,
      name: 'Admin',
      email: 'admin-campaigns-repo@example.test',
      passwordHash: 'x',
      role: 'admin',
    });
    await db.insert(whatsappAccounts).values({
      id: A1,
      tenantId: MILVENDAS_TENANT_ID,
      label: 'Campanhas',
      providerSessionId: 'sess-campaigns-repo',
      purpose: 'campaigns',
    });
    // fixture de contacto: garante que a FK de destinatários continua válida
    await db.insert(contacts).values({ tenantId: MILVENDAS_TENANT_ID, phoneE164: '+244900000002' });

    const { campaigns } = createCampaignRepositories({ db });
    const scope = { tenantId: MILVENDAS_TENANT_ID };
    const base = {
      tenantId: MILVENDAS_TENANT_ID,
      messageTemplate: 'Olá {{nome}}',
      allowedAccountIds: [A1],
      dailyLimit: null,
      createdBy: U1,
    };

    const c1 = await campaigns.insert(scope, {
      ...base,
      id: randomUUID(),
      name: 'Campanha A',
      createIdempotencyKey: 'k-a',
      createRequestHash: 'h-a',
    });
    assert.deepEqual(c1.allowedAccountIds, [A1]);

    const other = await campaigns.insert(
      { tenantId: '00000000-0000-0000-0000-0000000000f9' },
      { ...base, tenantId: '00000000-0000-0000-0000-0000000000f9', id: randomUUID(), name: 'Outro tenant', createIdempotencyKey: 'k-b', createRequestHash: 'h-b' },
    ).catch(() => null);
    assert.equal(other, null, 'inserir com tenant inexistente falha (FK), nunca escreve noutro tenant');

    await campaigns.insert(scope, {
      ...base,
      id: randomUUID(),
      name: 'Campanha B',
      createIdempotencyKey: 'k-c',
      createRequestHash: 'h-c',
    });

    assert.equal((await campaigns.findById(scope, c1.id))?.name, 'Campanha A');
    assert.equal((await campaigns.findByIdempotencyKey(scope, 'k-a'))?.id, c1.id);
    assert.equal(
      await campaigns.findById({ tenantId: '00000000-0000-0000-0000-0000000000f9' }, c1.id),
      null,
      'cross-tenant devolve null',
    );

    const page1 = await campaigns.list(scope, { limit: 1, cursor: null });
    assert.equal(page1.items.length, 1);
    assert.ok(page1.nextCursor !== null);
    const page2 = await campaigns.list(scope, { limit: 1, cursor: page1.nextCursor });
    assert.equal(page2.items.length, 1);
    assert.notEqual(page2.items[0]!.id, page1.items[0]!.id);

    const running = await campaigns.compareAndSetStatus(scope, c1.id, ['draft'], { status: 'running' });
    assert.equal(running?.status, 'running');
    assert.equal(await campaigns.compareAndSetStatus(scope, c1.id, ['draft'], { status: 'cancelled' }), null);
  });
});
