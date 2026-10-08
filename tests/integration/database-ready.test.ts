import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';

const DEFAULT_TEST_DATABASE_URL = 'postgres://crm_test:crm_test@127.0.0.1:5433/crm_test';

test('database ready: Postgres 16 reachable with the vector extension', async () => {
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
  });
  try {
    const version = await pool.query<{ current_setting: string }>(
      "SELECT current_setting('server_version')",
    );
    const serverVersion = version.rows[0]?.current_setting ?? '';
    assert.match(serverVersion, /^16\./, `unexpected server version: ${serverVersion}`);

    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    const extension = await pool.query(
      "SELECT default_version FROM pg_available_extensions WHERE name = 'vector'",
    );
    assert.equal(extension.rowCount, 1, 'pgvector extension must be available');
  } finally {
    await pool.end();
  }
});
