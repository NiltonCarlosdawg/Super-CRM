// Fase 1, Task 9: fundações HTTP — raw body preservado para assinatura de
// webhook (docs/04 §5) + health + OpenAPI autenticado.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildTestApp } from '../helpers/http.js';

test('raw body preservado para assinatura de webhook', async () => {
  const app = await buildTestApp();
  const seen: Buffer[] = [];
  app.post('/v1/probe-raw', async (request) => {
    seen.push(request.rawBody as Buffer);
    return {
      sha: createHash('sha256')
        .update(request.rawBody ?? Buffer.alloc(0))
        .digest('hex'),
    };
  });
  const payload = JSON.stringify({ hello: 'wa-akg' });
  const r = await app.inject({
    method: 'POST',
    url: '/v1/probe-raw',
    headers: { 'content-type': 'application/json' },
    payload,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(seen[0]?.toString('utf8'), payload, 'bytes originais, sem re-serializar');
  assert.equal(
    r.json().sha,
    createHash('sha256').update(Buffer.from(payload)).digest('hex'),
  );
});

test('health sempre acessível; /v1/openapi.json exige sessão', async () => {
  const app = await buildTestApp();
  const get = (url: string, cookies?: Record<string, string>) =>
    app.inject({ method: 'GET', url, cookies });

  assert.equal((await get('/health/live')).statusCode, 200);
  // sem provider/jobs configurados → não pode bloquear o teste
  assert.ok([200, 503].includes((await get('/health/ready')).statusCode));

  // OpenAPI: qualquer papel autenticado pode lê-lo; sem sessão → 401
  assert.equal((await get('/v1/openapi.json')).statusCode, 401);
  const spec = await get('/v1/openapi.json', { session: app.sessions.agent });
  assert.equal(spec.statusCode, 200);
  assert.ok(spec.json().openapi, 'documento OpenAPI presente');
});
