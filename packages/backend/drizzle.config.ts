import { defineConfig } from 'drizzle-kit';

// `generate` é offline (nunca liga à BD). `migrate`/`push` são proibidos nesta fase
// (docs/02 §5): aplicar a partir de zero é a primeira tarefa da Fase 1.
export default defineConfig({
  dialect: 'postgresql',
  // enums.ts não termina em `.schema.ts`; sem o 2.º glob o drizzle-kit não emite
  // CREATE TYPE para os enums definidos lá (as tabelas referenciavam tipos inexistentes).
  schema: ['./src/**/*.schema.ts', './src/adapters/db/schema/enums.ts'],
  out: './drizzle',
  strict: true,
  dbCredentials: {
    // `generate` é offline: nunca usa o URL. O `?? ''` só satisfaz o typecheck
    // strict (DATABASE_URL é validado no arranque da aplicação, docs/02 §4).
    url: process.env.DATABASE_URL ?? '',
  },
});
