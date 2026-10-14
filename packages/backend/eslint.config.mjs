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
