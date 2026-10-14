import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError, loadConfig } from '../../src/infra/config.js';

const validEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://u:p@h/db',
  REDIS_URL: 'redis://h:6379',
};

function configErrorOf(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('esperado ConfigError, mas loadConfig devolveu config válida');
}

test('env vazia lança ConfigError com falta de DATABASE_URL e REDIS_URL', () => {
  const error = configErrorOf({});
  assert.deepEqual([...error.issues], ['falta DATABASE_URL', 'falta REDIS_URL']);
  assert.ok(Object.isFrozen(error.issues));
});

test('env válida devolve os valores por omissão', () => {
  assert.deepEqual(loadConfig({ ...validEnv }), {
    nodeEnv: 'development',
    port: 3000,
    databaseUrl: 'postgres://u:p@h/db',
    redisUrl: 'redis://h:6379',
    logLevel: 'info',
  });
});

test('LOG_LEVEL fora do enum é valor não permitido', () => {
  const error = configErrorOf({ ...validEnv, LOG_LEVEL: 'chatty' });
  assert.deepEqual([...error.issues], ['LOG_LEVEL: valor não permitido']);
});

test('PORT fora de 1-65535 é erro de intervalo', () => {
  const error = configErrorOf({ ...validEnv, PORT: '70000' });
  assert.deepEqual([...error.issues], ['PORT: fora do intervalo 1-65535']);
});

test('DATABASE_URL sem prefixo postgres é erro de formato postgres', () => {
  const error = configErrorOf({ ...validEnv, DATABASE_URL: 'mysql://x' });
  assert.deepEqual([...error.issues], ['DATABASE_URL: formato postgres:// ou postgresql:// esperado']);
});

test('REDIS_URL sem prefixo redis é erro de formato redis', () => {
  const error = configErrorOf({ ...validEnv, REDIS_URL: 'http://x' });
  assert.deepEqual([...error.issues], ['REDIS_URL: formato redis:// esperado']);
});

test('NODE_ENV fora do enum é valor não permitido', () => {
  const error = configErrorOf({ ...validEnv, NODE_ENV: 'staging' });
  assert.deepEqual([...error.issues], ['NODE_ENV: valor não permitido']);
});

test('a mensagem de erro nunca ecoa os valores recebidos', () => {
  const error = configErrorOf({ ...validEnv, LOG_LEVEL: 'chatty' });
  assert.ok(!error.message.includes('postgres://u:p@h/db'));
  assert.ok(!error.issues.some((issue) => issue.includes('postgres://u:p@h/db')));
  assert.ok(!error.issues.some((issue) => issue.includes('redis://h:6379')));
});

test('os problemas saem na ordem NODE_ENV, PORT, DATABASE_URL, REDIS_URL, LOG_LEVEL', () => {
  const error = configErrorOf({
    NODE_ENV: 'staging',
    PORT: '70000',
    DATABASE_URL: 'mysql://x',
    REDIS_URL: 'http://x',
    LOG_LEVEL: 'chatty',
  });
  assert.deepEqual([...error.issues], [
    'NODE_ENV: valor não permitido',
    'PORT: fora do intervalo 1-65535',
    'DATABASE_URL: formato postgres:// ou postgresql:// esperado',
    'REDIS_URL: formato redis:// esperado',
    'LOG_LEVEL: valor não permitido',
  ]);
});
