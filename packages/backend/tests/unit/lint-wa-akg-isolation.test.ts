// Isolamento WA-AKG (docs/04 §2): fora de src/adapters/wa-akg/, ninguém
// importa wa-akg e ninguém chama .sendText/.sendMedia diretamente — tudo
// passa pela outbox + fila. Verificação dupla: API do ESLint (regra real do
// eslint.config.mjs) + varredura estática do código.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ESLint } from 'eslint';

const PKG_ROOT = path.resolve(import.meta.dirname, '../..');

test('ESLint: importar wa-akg fora do adaptador é erro', async () => {
  const eslint = new ESLint({ cwd: PKG_ROOT });
  const probe = "import { something } from '../adapters/wa-akg/index.js';\nexport const x = something;\n";
  const [result] = await eslint.lintText(probe, {
    filePath: path.join(PKG_ROOT, 'src/application/__probe.ts'),
  });
  assert.ok(
    result?.messages.some((m) => m.message.includes('WA-AKG')),
    `esperava erro WA-AKG, obtive: ${JSON.stringify(result?.messages)}`,
  );
});

test('ESLint: projeto inteiro sem erros (a regra nova não quebra nada)', async () => {
  const eslint = new ESLint({ cwd: PKG_ROOT });
  const results = await eslint.lintFiles(['src/**/*.ts', 'tests/**/*.ts']);
  const errorCount = results.reduce((n, r) => n + r.errorCount, 0);
  const details = results
    .filter((r) => r.errorCount > 0)
    .map((r) => `${r.filePath}: ${r.messages.map((m) => `${m.line}:${m.message}`).join('; ')}`)
    .join('\n');
  assert.equal(errorCount, 0, `erros de lint:\n${details}`);
});

test('estático: .sendText/.sendMedia só no adaptador wa-akg e no worker da outbox', () => {
  const srcDir = path.join(PKG_ROOT, 'src');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (full.includes(`${path.sep}wa-akg${path.sep}`)) continue; // adaptador: permitido
      if (full.includes('outbox-worker')) continue; // worker da outbox: permitido
      const text = readFileSync(full, 'utf8');
      if (/\.send(Text|Media)\(/.test(text)) offenders.push(path.relative(srcDir, full));
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, []);
});
