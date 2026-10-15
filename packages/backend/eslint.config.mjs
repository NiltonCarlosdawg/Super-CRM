import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['reference/**'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      'no-console': 'error',
      eqeqeq: 'error',
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      // O tsc (typecheck) cobre isto em .ts; no-undef gera falsos positivos com tipos globais.
      'no-undef': 'off',
    },
  },
  {
    files: ['tests/**', 'scripts/**'],
    rules: {
      'no-console': 'off',
    },
  },
  // WA-AKG só pelo adaptador (docs/04 §2): nenhuma importação de wa-akg fora
  // de src/adapters/wa-akg/. Verificado também por
  // tests/unit/lint-wa-akg-isolation.test.ts (API do ESLint sobre este config).
  {
    files: ['src/**'],
    // docs/04 §5: o WA-AKG é acessível SÓ do composition root (src/infra, a
    // única que injeta o adaptador como MessagingProvider) e do próprio
    // adaptador. domain/application são regidos pelo bloco seguinte (probe).
    ignores: ['src/infra/**', 'src/adapters/wa-akg/**', 'src/domain/**', 'src/application/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/wa-akg/**', '**/wa-akg'],
              message: 'WA-AKG só pelo adaptador src/adapters/wa-akg (docs/04 §2).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/domain/**', 'src/application/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'drizzle-orm',
                'drizzle-orm/*',
                'fastify',
                'bullmq',
                'pg-boss',
                'socket.io',
                '@huggingface/transformers',
                'pino',
                'pg',
                'ioredis',
              ],
              message: 'Camada domain/application só fala por ports (docs/02 §1).',
            },
            {
              group: ['**/wa-akg/**', '**/wa-akg'],
              message: 'WA-AKG só pelo adaptador src/adapters/wa-akg (docs/04 §2).',
            },
          ],
        },
      ],
    },
  },
  // dívida de reference/: PgDatabase<any,any,any>; alterar exige ADR (AGENTS.md §14)
  {
    files: [
      'src/modules/knowledge/knowledge.schema.ts',
      'src/modules/knowledge/handoff-triggers.seed.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
