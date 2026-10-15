// Fase 1, Task 16: rotas admin das contas WhatsApp — RBAC (admin), CSRF,
// validação zod, qr do provider e logout (docs/01 §3, docs/04 §6).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import test from 'node:test';
import { auditLog } from '../../src/adapters/db/schema/audit.schema.js';
import { buildTestApp } from '../helpers/http.js';

test('rotas admin: RBAC, validação, criação, qr e logout', async () => {
  const app = await buildTestApp();
  const url = '/v1/whatsapp-accounts';
  const post = (path: string, payload: unknown, session = app.sessions.admin, csrf = app.csrf.admin) =>
    app.inject({
      method: 'POST',
      url: path,
      cookies: { session, csrf },
      headers: { 'x-csrf-token': csrf },
      payload,
    });
  const asAdmin = (path: string) =>
    app.inject({ method: 'GET', url: path, cookies: { session: app.sessions.admin } });

  // sem sessão → 401; agent/editor → 403 (só admin)
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  assert.equal((await post(url, { label: 'A', purpose: 'sales' }, app.sessions.agent, app.csrf.agent)).statusCode, 403);
  assert.equal((await post(url, { label: 'A', purpose: 'sales' }, app.sessions.editor, app.csrf.editor)).statusCode, 403);

  // validação zod: 400 com o campo no detail
  const noPurpose = await post(url, { label: 'Vendas' });
  assert.equal(noPurpose.statusCode, 400);
  assert.match(noPurpose.json().detail as string, /purpose/);
  const emptyLabel = await post(url, { label: '', purpose: 'sales' });
  assert.equal(emptyLabel.statusCode, 400);
  assert.match(emptyLabel.json().detail as string, /label/);

  // criação ok → 201 connecting, ainda sem telefone
  const created = await post(url, { label: 'Vendas', purpose: 'sales' });
  assert.equal(created.statusCode, 201);
  const acc = created.json().account as { id: string; status: string; phoneE164: string | null };
  assert.equal(acc.status, 'connecting');
  assert.equal(acc.phoneE164, null);

  // GET :id devolve o qr do provider falso enquanto está connecting
  const got = await asAdmin(`${url}/${acc.id}`);
  assert.equal(got.statusCode, 200);
  assert.equal(got.json().qr, 'QR-FAKE');
  const list = await asAdmin(url);
  assert.equal(list.statusCode, 200);
  assert.ok((list.json().accounts as unknown[]).length >= 1);

  // logout: disconnected + audit account.logout + telefone limpo
  await app.db.execute(sql`UPDATE whatsapp_accounts SET phone_e164 = '+244923555000' WHERE id = ${acc.id}`);
  const out = await post(`${url}/${acc.id}/logout`, {});
  assert.equal(out.statusCode, 200);
  assert.equal(out.json().account.status, 'disconnected');
  assert.equal(out.json().account.phoneE164, null);
  assert.equal(
    (await app.db.select().from(auditLog).where(eq(auditLog.action, 'account.logout'))).length,
    1,
  );
  assert.ok(app.notifyLog.some((n) => n.type === 'account' && n.status === 'disconnected'), 'transição notificada');

  // conta inexistente → 404
  assert.equal((await post(`${url}/${randomUUID()}/logout`, {})).statusCode, 404);

  await app.close();
});
