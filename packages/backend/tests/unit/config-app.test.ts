import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAuthConfig, loadMessagingConfig, loadFullConfig } from '../../src/infra/config-app.js';

test('loadAuthConfig: sem env devolve issues exatas', () => {
  assert.throws(() => loadAuthConfig({}), (e: { issues?: string[] }) =>
    JSON.stringify(e.issues) === JSON.stringify(['falta AUTH_SECRET', 'falta AUTH_TOTP_ISSUER']));
});
test('loadAuthConfig: AUTH_SECRET curto é rejeitado e o valor não aparece na mensagem', () => {
  try { loadAuthConfig({ AUTH_SECRET: 'segredo-curto', AUTH_TOTP_ISSUER: 'MilVendas' }); assert.fail('devia lançar'); }
  catch (e) { const m = e as Error; assert.match(m.message, /AUTH_SECRET/); assert.ok(!m.message.includes('segredo-curto')); }
});
test('loadMessagingConfig: defaults exatos e intervalo de resposta', () => {
  const env = { WA_AKG_BASE_URL: 'http://wa.local:3001', WA_AKG_API_KEY: 'k', WA_WEBHOOK_SECRET: 's'.repeat(32) };
  const c = loadMessagingConfig(env);
  assert.deepEqual(c.replyDelayMs, { min: 1000, max: 5000 });
  assert.equal(c.sendTimeoutMs, 15000);
  assert.equal(c.sendMaxAttempts, 5);
  assert.equal(c.outboxRetryDelayMs, 30000);
  assert.equal(c.outboxTickMs, 1000);
  assert.equal(c.claimTtlMs, 60000);
  assert.equal(c.failWindow, 20);
  assert.equal(c.failRatio, 0.30);
  assert.equal(c.cbThreshold, 5);
  assert.equal(c.cbCooldownMs, 30000);
  assert.equal(c.maxMessageChars, 4096);
  assert.throws(() => loadMessagingConfig({ ...env, WA_REPLY_DELAY_MS: '5000-1000' }),
    /WA_REPLY_DELAY_MS: min > max/);
  assert.throws(() => loadMessagingConfig({ ...env, WA_WEBHOOK_SECRET: 'curto' }), /WA_WEBHOOK_SECRET/);
});
test('loadFullConfig: compõe base + auth + messaging sem ler env duas vezes', () => {
  const c = loadFullConfig({ DATABASE_URL: 'postgres://u:p@h/db', REDIS_URL: 'redis://h:6379',
    AUTH_SECRET: 'x'.repeat(32), AUTH_TOTP_ISSUER: 'MilVendas',
    WA_AKG_BASE_URL: 'http://wa.local:3001', WA_AKG_API_KEY: 'k', WA_WEBHOOK_SECRET: 's'.repeat(32) });
  assert.equal(c.auth.sessionTtlHours, 72);
  assert.equal(c.messaging.waAkgBaseUrl, 'http://wa.local:3001');
});
