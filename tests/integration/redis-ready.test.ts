import assert from 'node:assert/strict';
import test from 'node:test';
import { Redis } from 'ioredis';

test('redis ready: ping answers PONG on TEST_REDIS_URL', async () => {
  // ioredis has no `{ url }` option (brief bug fixed by ruling 9); the URL is a
  // positional constructor argument, the documented API.
  const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6380', { lazyConnect: true });
  try {
    assert.equal(await redis.ping(), 'PONG');
  } finally {
    redis.disconnect();
  }
});
