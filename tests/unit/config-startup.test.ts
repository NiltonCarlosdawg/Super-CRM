import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function runMain(env: NodeJS.ProcessEnv) {
  return spawnSync('npx', ['--no-install', 'tsx', 'src/infra/main.ts'], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
}

test('arranque sem DATABASE_URL termina com erro, sem stack trace', () => {
  const result = runMain({ ...process.env, DATABASE_URL: '' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /config inválida/);
  assert.match(result.stderr, /DATABASE_URL/);
  assert.ok(!result.stderr.includes('at ConfigError'));
});

test('arranque com env válida escreve application.started e sai 0', () => {
  const result = runMain({
    ...process.env,
    NODE_ENV: 'test',
    PORT: '4010',
    DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/crm-test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    LOG_LEVEL: 'info',
  });

  assert.equal(result.status, 0);

  const firstLine = result.stdout.split('\n', 1)[0];
  assert.ok(firstLine !== undefined);

  const payload = JSON.parse(firstLine) as { msg?: unknown; correlationId?: unknown };
  assert.equal(payload.msg, 'application.started');
  assert.equal(typeof payload.correlationId, 'string');
  assert.ok((payload.correlationId as string).length > 0);
});
