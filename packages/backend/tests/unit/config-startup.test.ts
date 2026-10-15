import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

test('arranque com env válida escuta HTTP e faz graceful shutdown no SIGTERM', async () => {
  // Fase 1 Task 9: o main.ts deixa de sair — escuta HTTP. O contrato passa a
  // ser: escreve application.started, responde a SIGTERM com exit 0.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/infra/main.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '4010',
      DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/crm-test',
      REDIS_URL: 'redis://127.0.0.1:6399', // porta sem servidor: só reconnect + log warn
      LOG_LEVEL: 'info',
      // Fase 1 Task 4: loader completo (auth + messaging) — estender, nunca enfraquecer
      AUTH_SECRET: 'x'.repeat(32),
      AUTH_TOTP_ISSUER: 'MilVendas',
      WA_AKG_BASE_URL: 'http://wa.local:3001',
      WA_AKG_API_KEY: 'chave-teste',
      WA_WEBHOOK_SECRET: 's'.repeat(32),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout sem application.started; stderr=${stderr}`)), 45_000);
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
      if (stdout.includes('application.started')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`processo saiu cedo: code=${code} stderr=${stderr}`));
    });
  });
  await started;

  const exitCode = await new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? -1));
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 20_000).unref();
  });
  assert.equal(exitCode, 0, `stderr=${stderr}`);

  // pode haver warns antes (ex.: redis ainda a ligar) — procurar a linha do started
  const startedLine = stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { msg?: unknown; correlationId?: unknown })
    .find((payload) => payload.msg === 'application.started');
  assert.ok(startedLine, `stdout=${stdout}`);
  assert.equal(typeof startedLine.correlationId, 'string');
  assert.ok((startedLine.correlationId as string).length > 0);
});
