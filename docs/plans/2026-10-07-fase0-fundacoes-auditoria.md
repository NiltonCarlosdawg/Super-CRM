# Fase 0 — Fundações e auditoria Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sentar as fundações do repositório (toolchain, CI, config validada, logging estruturado, contentores de teste), integrar `reference/` em `src/` a passar os seus testes, executar e registar as verificações do cPanel com evidência (A5), entregar a auditoria só-leitura do WA-AKG e a proposta de schema base em Drizzle — prontas para o gate humano.
**Architecture:** Estrutura hexagonal de `docs/02` §1 desde a primeira tarefa, com regras de camadas impostas pelo linter. Os ficheiros de `reference/` são movidos para `src/` e `tests/` apenas com ajuste de imports. `searchChunks()` (plano A pgvector) e o port de jobs (plano A BullMQ) existem já nesta fase, com os planos B (FTS e pg-boss) documentados em `docs/cpanel-capacidades.md` e acionados só se a evidência os refutar. A auditoria ao WA-AKG corre num clone leitura-só fora do repositório; o schema é gerado mas **não aplicado** (aplicação é Fase 1).
**Tech Stack:** Node ≥ 24 LTS + TypeScript (`strict`, `noUncheckedIndexedAccess`) + `tsx` + `node:test`; ESLint flat + `typescript-eslint`; `zod`; `pino`; Drizzle ORM + `drizzle-kit`; `pg`; `bullmq` (ou `pg-boss` no plano B); Docker Compose só para testes (produção é sem Docker, A5); `ws` (sonda de websockets A5); GitHub Actions; imagens `pgvector/pgvector:pg16` e `redis:7.4-alpine`.
**Spec:** docs/01-contexto-e-plano.md §8 (Fase 0) + docs/06-decisoes-fechadas-a1-a11.md

## Global Constraints

- TypeScript `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` e `verbatimModuleSyntax` em `tsconfig.json`; typecheck obrigatório em CI.
- Sem `any`: se inevitável, comentário `// any: motivo` na própria linha (heurística de referência: aviso `no-explicit-any` só nos 2 ficheiros de `reference/` que usam `PgDatabase<any, any, any>`, registado no ADR-0005).
- IDs `uuid` (`uuid('id').defaultRandom()`); nunca IDs sequenciais expostos.
- Datas sempre `timestamp with time zone` (`timestamptz`) UTC; conversão de fuso só na apresentação.
- Dinheiro em `numeric(14, 2)` no Postgres e `string` em TypeScript; nunca `number` com vírgula flutuante.
- Telefones E.164 (`+244…`) numa única função de normalização/mascaramento testada; logs só com `maskPhoneE164`.
- Sem segredos em código, commits, logs, fixtures, prompts ou `.env.example` (`.env` no `.gitignore`, que já o contém).
- Só dados sintéticos: as 20 conversas reais de WhatsApp estão proibidas em testes, prompts, exemplos e avaliação.
- Commits convencionais e pequenos, em inglês (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `ci:`); nunca com testes a falhar; sem `push --force`.
- Texto do plano e dos docs em português; código, identificadores e commits em inglês.
- Testes de integração só com Postgres e Redis **reais em contentores** (`docker-compose.test.yml`); nunca simular a base de dados.
- Idempotência em jobs e futuros envios/webhooks: chave (`idempotency_key`) ou `jobId` determinístico; contrato provado por teste.
- WA-AKG **só leitura**: nenhum ficheiro do clone é alterado (`git status --porcelain` vazio ao fim da auditoria); nenhum segredo do fork é copiado para os nossos docs (mascarar `***` nas evidências).
- `reference/` é movido para `src/`/`tests/` só com ajuste de imports (incluindo extensão `.js` exigida por `NodeNext` e o comentário de comando do teste) — nenhuma mudança de comportamento.
- Sem `drizzle-kit push` e sem aplicar migrações nesta fase; `CREATE EXTENSION IF NOT EXISTS vector;` fica como migração SQL personalizada número `0000`, antes de qualquer tabela.
- Nenhum endpoint, payload ou campo do WA-AKG é assumido: tudo o que a auditoria afirma tem evidência `ficheiro:linha` ou comando + saída.

## Review Focus

- Idempotência de jobs (`docs/02` §6) não é coberta pelos 17 testes do orquestrador — fixa `tests/integration/job-queue.test.ts` (tarefa dona: Task 7, enqueue repetido com o mesmo `idempotencyKey` executa uma vez).
- Mascaramento de telefones em logs (`docs/02` §10) não existe em nenhum teste — fixa `tests/unit/logger.test.ts` (tarefa dona: Task 4, `maskPhoneE164('+244912345612') === '+244 9** *** *12'`).
- Baseline do `evaluate()` de `docs/05` §8 (precisão 100/100, recall 75% em `human_requested`) não é exercitado pelos testes do orquestrador — fixa `tests/unit/eval-baseline.test.ts` (tarefa dona: Task 8).
- Cobertura do schema contra o esboço de `docs/01` §6 (14 tabelas base) mais as 2 acrescentadas por decisão (`sessions` por A2, "sessões server-side em PostgreSQL"; `campaign_accounts` por "contas permitidas" em `docs/01` §6) = 16 — fixa `tests/unit/schema-coverage.test.ts` (tarefa dona: Task 9).
- Fronteiras hexagonais (`docs/02` §1: `domain`/`application` sem Drizzle, Fastify, BullMQ, pino) — fixa o override `no-restricted-imports` verificado por `npm run lint` (tarefa dona: Task 1); e funções de `reference/` que dependem de base (`searchChunks()`, `seedHandoffTriggers()`) — fixam-nas `tests/integration/search-chunks.test.ts` + `tests/integration/seed-triggers.test.ts` (tarefa dona: **Fase 1**, após aplicar as migrações; em Fase 0 a existência da extensão `vector` fica fixa por `tests/integration/database-ready.test.ts`, Task 5).

### Task 1: Toolchain, estrutura de pastas e regras de camadas

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `docs/adr/0005-toolchain-fundacao.md`, `tests/unit/smoke.test.ts`, `.gitkeep` em `src/domain`, `src/application`, `src/ports`, `src/adapters/wa-akg`, `src/adapters/ai`, `src/adapters/db`, `src/adapters/queue`, `src/adapters/http`, `src/adapters/realtime`, `src/infra`, `src/modules/knowledge`, `tests/unit`, `tests/integration`, `tests/contract`, `tests/eval`
- Modify: (nenhum — `.gitignore` já cobre `.env`, `.env.*`, `!.env.example`, `node_modules/`, `*.log`; confirmar)
- Test: `tests/unit/smoke.test.ts`

**Interfaces:**
- Consumes: nada (primeira tarefa).
- Produces: comandos `npm run lint`, `npm run typecheck`, `npm test`; árvore de pastas exata de `docs/02` §1; ADR-0005 com a justificação de cada dependência nova (regra 5 do `AGENTS.md`).

**Steps:**

- [ ] Criar `package.json` (versões fixadas; o lockfile é commitado):

```json
{
  "name": "milvendas-crm",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "tsx watch src/infra/main.ts",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "tsx --test \"tests/unit/**/*.test.ts\""
  }
}
```

- [ ] Instalar dependências (cada uma justificada no ADR-0005): runtime `drizzle-orm`, `pg`, `zod`, `pino`; dev `typescript`, `tsx`, `eslint`, `typescript-eslint`, `@eslint/js`, `@types/node`, `@types/pg`, `drizzle-kit`. Comando: `npm install <pkg>@<versão>` por pacote; saída esperada: `added N packages` e `package-lock.json` atualizado. (`bullmq` só na Task 7, `ws` na Task 2.)
- [ ] Criar `tsconfig.json` exato:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts", "drizzle.config.ts"]
}
```

- [ ] Criar `eslint.config.mjs` com: `tseslint.configs.recommended`; regra `'no-console': 'error'` (desligada em `tests/**` e `scripts/**`); `'no-undef': 'off'` para `**/*.ts` (o `tsc` cobre isso); `eqeqeq`; e o override de `no-restricted-imports` para `src/domain/**` e `src/application/**` bloqueando os padrões `drizzle-orm`, `drizzle-orm/*`, `fastify`, `bullmq`, `pg-boss`, `socket.io`, `@huggingface/transformers`, `pino`, `pg`, `ioredis` com a mensagem `Camada domain/application só fala por ports (docs/02 §1).`. Por fim, override com `'@typescript-eslint/no-explicit-any': 'warn'` só para `src/modules/knowledge/knowledge.schema.ts` e `src/modules/knowledge/handoff-triggers.seed.ts`, com comentário `// dívida de reference/: PgDatabase<any,any,any>; alterar exige ADR (AGENTS.md §14)`.
- [ ] Criar a estrutura de pastas da Task 1 (`.gitkeep` em cada diretório da lista de Files) e verificar: `find src tests -type d | sort` devolve os 15 diretórios.
- [ ] Escrever o teste `tests/unit/smoke.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

test('o runner de testes arranca', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] Correr `npm test` → saída esperada: `pass 1`, `fail 0`.
- [ ] Testar a regra de camadas (prova negativa): criar ficheiro temporário `src/domain/_violation.ts` com `import { sql } from 'drizzle-orm'; export const x = sql;`, correr `npm run lint` → **tem de falhar** com a mensagem `Camada domain/application só fala por ports`; apagar o ficheiro; correr `npm run lint` → `0 problems` e `npm run typecheck` → sem erros.
- [ ] Escrever `docs/adr/0005-toolchain-fundacao.md` (contexto, opções, decisão, consequências) cobrindo: Node ≥ 24 LTS (A1) com CI em 24; `node:test` + `tsx` porque `reference/orchestrator.test.ts` já os usa (zero framework de testes novo); ESLint flat não type-aware (rápido, sem projeto); `zod` (validação de fronteiras, `docs/02` §3); `pino` (JSON estruturado + redaction, `docs/02` §10); `ws` (sonda A5 da Task 2); Docker Compose só em testes (A5: produção sem Docker); `bullmq` com plano B `pg-boss` (D7/A5); `npm audit` + `gitleaks` em CI (`docs/02` §12, `docs/03` §2).
- [ ] Commit: `chore: scaffold node toolchain with typescript, eslint and tests`.

### Task 2: Verificações do cPanel com evidência (A5) e sondas de websockets

**Files:**
- Create: `docs/cpanel-capacidades.md`, `scripts/ws-echo-server.ts`, `scripts/ws-echo-client.ts`, `tests/integration/ws-echo.test.ts`
- Modify: (nenhum — o script `test:integration` é adicionado na Task 5, que cria o ficheiro `scripts/integration-test.sh`)
- Test: `tests/integration/ws-echo.test.ts`

**Interfaces:**
- Consumes: `docs/06` §A5 (as 4 verificações com os comandos mínimos já indicados); `docs/01` §4 ("pendências factuais"); acesso ao alojamento do dono (se existir).
- Produces: `docs/cpanel-capacidades.md` com a secção `## 0. Método`, 4 secções (`## 1. pgvector`, `## 2. Redis`, `## 3. Websockets/Socket.IO`, `## 4. RAM/CPU`), cada uma com `Comando exato`, `Saída esperada`, `Evidência (saída real ou Pendente — comando pronto)`, `Estado: Confirmado | Refutado | Pendente`, e uma `## 5. Decisão dos planos B` em tabela; `scripts/ws-echo-server.ts` com interface `criarServidorEcho(porta: number): Promise<{ porta: number; fechar(): Promise<void> }>`, que a cada mensagem WS responde `echo:<mensagem>` e imprime uma linha JSON `{"event":"ws_echo.listening","porta":<n>}`; `scripts/ws-echo-client.ts` com invocação `tsx scripts/ws-echo-client.ts <url-ws>`, que envia `ping-<ISO>`, espera `echo:` até 5000 ms e termina com `WS_OK rtt=<n>ms` (exit 0) ou `WS_FAIL motivo=<motivo>` (exit 1).

**Steps:**

- [ ] Escrever `docs/cpanel-capacidades.md` com os comandos exatos de cada verificação (nada de inventar: os comandos 1–2 vêm da `docs/06` §A5; os 3–4 são os nossos):
  1. pgvector: `psql "<DATABASE_URL do cPanel>" -c "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'vector';"` e `psql "<DATABASE_URL do cPanel>" -c "SELECT extversion FROM pg_extension WHERE extname = 'vector';"` — saída esperada: uma linha `vector | …`; `0 rows` = **Refutado**.
  2. Redis: `which redis-server && redis-cli ping` no Terminal do cPanel, e `ss -ltn 2>/dev/null | grep 6379` — saída esperada: `PONG` e linha `LISTEN`; ausência = **Refutado**.
  3. Websockets: servidor `PORT=8787 tsx scripts/ws-echo-server.ts` (corre localmente e no alojamento) + cliente de fora: `tsx scripts/ws-echo-client.ts "wss://<dominio-do-app>/__ws-echo"` — `WS_OK` = Confirmado; `WS_FAIL`/timeout = Refutado (fallback documentado: Socket.IO degrada para HTTP long-polling; escalar ao dono).
  4. RAM/CPU: `nproc`; `free -m`; `/usr/bin/time -v tsx src/infra/main.ts 2>&1 | grep "Maximum resident set size"` (baseline ociosa da App 1 — executar este comando depois da Task 4, quando `src/infra/main.ts` existir); `ps aux --sort=-rss | head -10` — regista valores e compara com `2 × RSS ociosa + 300–500 MB` (modelo `multilingual-e5-small`, ADR-0002); se não chegar → variante `MiniLM` ~90 MB (ADR-0002).
- [ ] Escrever a tabela `## 5. Decisão dos planos B` com estado por omissão e ramo de decisão: pgvector **Plano A** (mantém `searchChunks()` de `reference/`); se Refutado → Plano B FTS: trocar o corpo de `searchChunks()` por `to_tsvector('portuguese', content) @@ plainto_tsquery('portuguese', …)` + índice GIN de expressão, alargando a assinatura para `searchChunks(db, query: { text: string; embedding?: number[] }, opts)` — só com ADR (regra 14 do `AGENTS.md`), e omitir a migração `0000_vector_extension.sql`. Redis **Plano A** (BullMQ, D7); se Refutado → Plano B pg-boss no mesmo port de jobs: acrescentar `src/adapters/queue/pgboss.ts`, trocar a fábrica `createJobQueue`, correr `npm run test:integration` (o `tests/integration/job-queue.test.ts` é o contrato e tem de passar igual), remover `bullmq` e registar a troca neste documento. Websockets sem plano B próprio (long-polling do Socket.IO). RAM sem plano além da variante MiniLM.
- [ ] Escrever `scripts/ws-echo-server.ts` (`ws` como devDependency, instalar: `npm install -D ws @types/ws`) e `scripts/ws-echo-client.ts` conforme as assinaturas acima; rejeitar mensagens que não respeitem o formato e ligação fechada sem erro não tratado.
- [ ] Escrever o teste falhado `tests/integration/ws-echo.test.ts` com **dois** `test(...)`: (1) `sonda ws: o cliente recebe echo do servidor local` — largar o servidor em processo filho na porta `18787`, esperar pela linha `ws_echo.listening` (máx. 5000 ms, polling 50 ms), correr o cliente como processo filho com `ws://127.0.0.1:18787`, afirmar `exitCode === 0` e `stdout` a casar com `/^WS_OK rtt=\d+ms/`; (2) `sonda ws: porta fechada devolve WS_FAIL` — correr o cliente contra `ws://127.0.0.1:18799` e afirmar `exitCode === 1` e `/^WS_FAIL/`; terminar os filhos em `finally`. **Nota:** este ficheiro está em `tests/integration/` mas não precisa de contentores — corre no script da Task 5.
- [ ] Correr `npx tsx --test tests/integration/ws-echo.test.ts` → ver os dois testes **falharem** (servidor/cliente ainda não existem; saída: erro de módulo ou timeout à espera de `ws_echo.listening`).
- [ ] Implementar os dois scripts e o teste → correr de novo → `pass ≥ 2`, `fail 0`.
- [ ] Tentar executar as verificações 1–2–4 se o dono fornecer acesso (credenciais nunca no repositório: usar canal próprio; saída real colada em `Evidência`). Se não houver acesso: marcar `Estado: Pendente — pedido enviado ao dono em <data> com estes comandos` e **continuar** (os planos B por omissão estão registados; a verificação completa é condição do gate).
- [ ] Commit: `chore: add cpanel capability checks with websocket probe`.

### Task 3: Configuração validada no arranque

**Files:**
- Create: `src/infra/config.ts`, `src/infra/main.ts`, `.env.example`, `tests/unit/config.test.ts`, `tests/unit/config-startup.test.ts`
- Modify: `package.json` (nenhum script novo — `dev` já existe)
- Test: `tests/unit/config.test.ts`, `tests/unit/config-startup.test.ts`

**Interfaces:**
- Consumes: `process.env` (ou objeto `NodeJS.ProcessEnv` injectado).
- Produces:

```ts
// src/infra/config.ts
export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];
}

/** Lê as env vars UMA vez. Lança ConfigError sem ecoar valores. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig;
```

```ts
// src/infra/main.ts — sem servidor HTTP nesta fase (Fastify chega na Fase 1)
// fluxo: loadConfig(process.env) → createLogger (Task 4) → log 'application.started'
//        com correlationId do arranque (crypto.randomUUID()) → sair 0 (sem handles)
// ConfigError → process.stderr.write(`config inválida (N problemas):\n- …`) e process.exit(1)
```

Regras exatas de validação: `NODE_ENV` opcional (default `development`, enum); `PORT` opcional (default `3000`, inteiro 1–65535); `DATABASE_URL` obrigatório com prefixo `postgres://` ou `postgresql://`; `REDIS_URL` obrigatório com prefixo `redis://` ou `rediss://`; `LOG_LEVEL` opcional (default `info`, enum). Formato dos problemas, por esta ordem: `falta <VAR>`, `<VAR>: valor não permitido`, `<VAR>: fora do intervalo 1-65535`, `<VAR>: formato postgres:// ou postgresql:// esperado` (ou `… formato redis:// esperado`). Nunca incluir o valor recebido.

**Steps:**

- [ ] Escrever `tests/unit/config.test.ts` com os casos exatos: `loadConfig({})` lança `ConfigError` com `issues` igual a `['falta DATABASE_URL', 'falta REDIS_URL']`; `loadConfig({ DATABASE_URL: 'postgres://u:p@h/db', REDIS_URL: 'redis://h:6379' })` devolve `{ nodeEnv: 'development', port: 3000, databaseUrl: 'postgres://u:p@h/db', redisUrl: 'redis://h:6379', logLevel: 'info' }`; `LOG_LEVEL: 'chatty'` → `['LOG_LEVEL: valor não permitido']`; `PORT: '70000'` → `['PORT: fora do intervalo 1-65535']`; `DATABASE_URL: 'mysql://x'` → formato postgres; `REDIS_URL: 'http://x'` → formato redis; `NODE_ENV: 'staging'` → valor não permitido; e que a mensagem de erro **não** contém a string `postgres://u:p@h/db` (proteção de segredos).
- [ ] Correr `npm test` → ver falhar (`Cannot find module './src/infra/config.js'` ou `ConfigError` inexistente).
- [ ] Implementar `src/infra/config.ts` com `zod` (`safeParse` + mapeamento manual dos `issues` na ordem das variáveis `NODE_ENV, PORT, DATABASE_URL, REDIS_URL, LOG_LEVEL`; `ConfigError.issues = []` congelado).
- [ ] Correr `npm test` → `pass`, `fail 0`.
- [ ] Escrever `.env.example` **sem valores reais**:

```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://crm:change-me@127.0.0.1:5432/crm
REDIS_URL=redis://127.0.0.1:6379
LOG_LEVEL=info
```

- [ ] Escrever `src/infra/main.ts` conforme a interface acima. `loadConfig` é chamado exatamente uma vez.
- [ ] Escrever `tests/unit/config-startup.test.ts` com `spawnSync('npx', ['--no-install', 'tsx', 'src/infra/main.ts'], { env: { ...process.env, DATABASE_URL: '' } })`: caso sem `DATABASE_URL` → `status !== 0` e `stderr` contém `config inválida` e `DATABASE_URL` e não contém `at ConfigError`; caso com env válida (`DATABASE_URL`, `REDIS_URL` dummy + restantes) → `status === 0` e a primeira linha de `stdout` é JSON com `msg === 'application.started'` e `correlationId` string não vazia.
- [ ] Correr `npm test` → todos passam (`pass ≥ 9`, `fail 0`).
- [ ] Commit: `feat: validate environment config at startup`.

### Task 4: Logging estruturado JSON com correlationId

**Files:**
- Create: `src/infra/logger.ts`, `tests/unit/logger.test.ts`
- Modify: `src/infra/main.ts` (usar o logger em vez de escrever direto no stderr/stdout)
- Test: `tests/unit/logger.test.ts`

**Interfaces:**
- Consumes: `pino` (instalado na Task 1); `AppConfig['logLevel']`.
- Produces:

```ts
// src/infra/logger.ts
import type { Logger } from 'pino';
export type { Logger };

export interface CreateLoggerOptions {
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Para testes: stream em memória. Em produção, omitir (stdout). */
  stream?: NodeJS.WritableStream;
}

/** Logger JSON. Nível em string (`"level":"info"`). Nunca registar telefones completos. */
export function createLogger(options: CreateLoggerOptions): Logger;

/** Cria logger filho com `correlationId` no payload de cada linha. */
export function withCorrelationId(parent: Logger, correlationId: string): Logger;

/**
 * Mascara um telefone E.164: mantém o código do país, o 1.º dígito local e os 2 últimos.
 * `+244912345612` → `+244 9** *** *12` (grupos de 3 do dígito local, separados por espaço).
 * Local com < 4 dígito → `+<país> ***`. Formato inválido → `***`.
 */
export function maskPhoneE164(e164: string): string;
```

**Steps:**

- [ ] Escrever `tests/unit/logger.test.ts` com: `createLogger({ level: 'info', stream })` + `withCorrelationId(log, 'corr-123').info({ event: 'teste' }, 'mensagem')` → `JSON.parse` da primeira linha tem `level === 'info'`, `msg === 'mensagem'`, `correlationId === 'corr-123'`, `event === 'teste'`, `time` numérico; casos de mascaramento exatos: `maskPhoneE164('+244912345612') === '+244 9** *** *12'`, `maskPhoneE164('+244912345678') === '+244 9** *** *78'`, `maskPhoneE164('+244912') === '+244 ***'`, `maskPhoneE164('9123456') === '***'`, `maskPhoneE164('+35191234567890') === '+351 9** *** *** 89'` (regra geral aplicada a qualquer código do país: grupos de 3 dos dígitos locais, mantendo o 1.º e os 2 últimos).
- [ ] Correr `npm test` → ver falhar (`Cannot find module './src/infra/logger.js'`).
- [ ] Implementar `src/infra/logger.ts`: `pino({ level, formatters: { level: (label) => ({ level: label }) } }, stream)`; `withCorrelationId` = `parent.child({ correlationId })`; `maskPhoneE164` com `/^\+[1-9]\d{6,14}$/` para validar, extrair código do país e local, aplicar a regra acima (local.length < 4 → `***` local; inválido → `***`).
- [ ] Correr `npm test` → `pass`, `fail 0`.
- [ ] Em `src/infra/main.ts`: substituir escritas diretas por `withCorrelationId(createLogger({ level: config.logLevel }), randomUUID())`; erro de config continua no `stderr` **antes** de existir logger (mensagem limpa, sem stack).
- [ ] `npm run typecheck` e `npm run lint` → sem erros (nota: o `main.ts` não importa nada de `domain`/`application`).
- [ ] Commit: `feat: add structured json logging with correlation id`.

### Task 5: Ambiente de testes com contentores (Postgres+pgvector e Redis)

**Files:**
- Create: `docker-compose.test.yml`, `scripts/integration-test.sh`, `tests/integration/database-ready.test.ts`, `tests/integration/redis-ready.test.ts`
- Modify: `package.json` (scripts `test:integration`, `test:containers:up`, `test:containers:down`)
- Test: `tests/integration/database-ready.test.ts`, `tests/integration/redis-ready.test.ts`

**Interfaces:**
- Consumes: Docker local (allowance de `docs/01` §8 e A5: contentores só em teste); portas livres `5433` e `6380` (o Postgres do sistema já usa `5432`).
- Produces: `TEST_DATABASE_URL` (default `postgres://crm_test:crm_test@127.0.0.1:5433/crm_test`) e `TEST_REDIS_URL` (default `redis://127.0.0.1:6380`) lidos pelos testes de integração; script que sobe, testa e derruba os contentores.

**Steps:**

- [ ] Pré-requisito: correr `docker --version` e `docker compose version`. **Se `docker` não existir: pára e pede ao utilizador para instalar o Docker Engine (Ubuntu 24.04, docs oficiais) — regista no relatório como pendência; as tarefas seguintes avançam mas `test:integration` fica bloqueado até haver Docker.**
- [ ] Criar `docker-compose.test.yml` exato:

```yaml
name: crm-test
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: crm_test
      POSTGRES_PASSWORD: crm_test
      POSTGRES_DB: crm_test
    ports:
      - "5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U crm_test -d crm_test"]
      interval: 2s
      timeout: 3s
      retries: 30
  redis:
    image: redis:7.4-alpine
    ports:
      - "6380:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 30
```

(Credenciais efémeras do contentor de teste, públicas por definição — não são segredos; registado no ficheiro.)

- [ ] Criar `scripts/integration-test.sh` exato:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f docker-compose.test.yml up -d --wait
if [[ "${KEEP_CONTAINERS:-0}" != "1" ]]; then
  trap 'docker compose -f docker-compose.test.yml down -v' EXIT
fi
tsx --test "tests/integration/**/*.test.ts"
```

- [ ] Acrescentar os 3 scripts ao `package.json`:

```json
"test:integration": "bash scripts/integration-test.sh",
"test:containers:up": "docker compose -f docker-compose.test.yml up -d --wait",
"test:containers:down": "docker compose -f docker-compose.test.yml down -v"
```

- [ ] Escrever os testes falhados: `database-ready.test.ts` — `new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? default })`, `SELECT current_setting('server_version')` casa com `/^16\./`, depois `CREATE EXTENSION IF NOT EXISTS vector` sem erro e `SELECT default_version FROM pg_available_extensions WHERE name = 'vector'` tem `rowCount === 1`; `redis-ready.test.ts` — `new Redis({ url: … , lazyConnect: true })`, `ping() === 'PONG'`, `disconnect()`. Ambos com `try/finally` a fechar o cliente. (`pg` e `ioredis`: `ioredis` é devDependency nova — acrescentar ao ADR-0005.)
- [ ] Correr `npm run test:integration` → ver falhar porque os contentores/ficheiros não existem (saída: `docker compose …` inexistente ou `Cannot find module`).
- [ ] Correr `npm run test:integration` de novo após implementar → saída esperada: `up -d --wait` conclui com saúde `healthy`, `pass 4` (2 do ws-echo da Task 2 + 2 novos), `fail 0`, contentores removidos no fim.
- [ ] Commit: `chore: add postgres and redis containers for integration tests`.

### Task 6: Integração dos ficheiros de `reference/` em `src/` e `tests/`

**Files:**
- Create: `reference/README.md`
- Modify (apenas imports/comentário de comando): `src/ports/ai-provider.ts` (era `reference/ai-provider.ts`, sem imports), `src/application/orchestrator.ts` (era `reference/orchestrator.ts`), `src/domain/keyword-safety-net.ts` (era `reference/keyword-safety-net.ts`), `src/modules/knowledge/knowledge.schema.ts` (era `reference/knowledge.schema.ts`, sem imports), `src/modules/knowledge/handoff-triggers.seed.ts` (era `reference/handoff-triggers.seed.ts`), `tests/unit/orchestrator.test.ts` (era `reference/orchestrator.test.ts`), `tests/eval/handoff-scenarios.ts` (era `reference/handoff-scenarios.ts`, sem imports) — todos por `git mv`
- Test: `tests/unit/orchestrator.test.ts` (os 17 testes)

**Interfaces:**
- Consumes: árvore criada na Task 1.
- Produces: `handleInbound(p: Ports, provider: AIProvider, msg: InboundMessage, cfg?: Partial<OrchestratorConfig>): Promise<Outcome>` em `src/application/orchestrator.ts`; `keywordSafetyNet(turns: readonly Turn[]): TriggerCode[]` em `src/domain/`; tipos `AIProvider`/`Ports` em `src/ports/ai-provider.ts`; schema + `searchChunks()` em `src/modules/knowledge/`; mapa antigo→novo em `reference/README.md`.

**Steps:**

- [ ] `git mv` os 7 ficheiros para os caminhos acima (comandos exatos):

```bash
mkdir -p src/ports src/application src/domain src/modules/knowledge tests/unit tests/eval
git mv reference/ai-provider.ts src/ports/ai-provider.ts
git mv reference/orchestrator.ts src/application/orchestrator.ts
git mv reference/keyword-safety-net.ts src/domain/keyword-safety-net.ts
git mv reference/knowledge.schema.ts src/modules/knowledge/knowledge.schema.ts
git mv reference/handoff-triggers.seed.ts src/modules/knowledge/handoff-triggers.seed.ts
git mv reference/orchestrator.test.ts tests/unit/orchestrator.test.ts
git mv reference/handoff-scenarios.ts tests/eval/handoff-scenarios.ts
```

- [ ] Ajustar **só** os imports (extensão `.js` exigida por `NodeNext`):
  - `src/application/orchestrator.ts`: `'./keyword-safety-net'` → `'../domain/keyword-safety-net.js'`; `'./ai-provider'` → `'../ports/ai-provider.js'`
  - `src/domain/keyword-safety-net.ts`: `'./ai-provider'` → `'../ports/ai-provider.js'`
  - `src/modules/knowledge/handoff-triggers.seed.ts`: `'./knowledge.schema'` → `'./knowledge.schema.js'`
  - `tests/unit/orchestrator.test.ts`: `'./ai-provider'` → `'../../src/ports/ai-provider.js'`; `'./handoff-triggers.seed'` → `'../../src/modules/knowledge/handoff-triggers.seed.js'`; `'./orchestrator'` → `'../../src/application/orchestrator.js'` e atualizar só o comentário da linha 1 para `// Correr com: npm test`
  - `knowledge.schema.ts`, `ai-provider.ts`, `handoff-scenarios.ts`: sem imports relativos — não mudam.
- [ ] Escrever `reference/README.md` com a tabela antigo→novo e a nota `Ficheiros movidos na Fase 0 com ajuste de imports (AGENTS.md §14); reference/ fica como histórico do mapa.`
- [ ] Correr `npm run typecheck` → sem erros.
- [ ] Correr `npm test` → saída esperada: `tests 17`, `pass 17`, `fail 0` (prova da integração sem mudança de comportamento).
- [ ] `npm run lint` → sem erros (a regra de camadas de `domain`/`application` não acusa: orquestrador só importa `../domain/` e `../ports/`).
- [ ] Commit: `refactor: move reference sources into src with import-only changes`.

### Task 7: Port de jobs e adaptador (plano A: BullMQ)

**Files:**
- Create: `src/ports/job-queue.ts`, `src/adapters/queue/bullmq.ts`, `src/adapters/queue/index.ts`, `tests/integration/job-queue.test.ts`
- Modify: `package.json` (deps `bullmq`); `docs/cpanel-capacidades.md` (registo da decisão da secção 5)
- Test: `tests/integration/job-queue.test.ts`

**Interfaces:**
- Consumes: `REDIS_URL` (config/env de teste: `TEST_REDIS_URL`); Redis real da Task 5.
- Produces:

```ts
// src/ports/job-queue.ts
export interface EnqueueOptions {
  /** Chave determinística: re-enviar a mesma chave NÃO repete o efeito. */
  idempotencyKey: string;
  correlationId: string;
  delayMs?: number;
}

export interface JobContext {
  correlationId: string;
  jobId: string;
  attempt: number;
}

export interface JobQueue {
  /** O payload leva IDs, nunca dados de conversa (docs/02 §6). O handler valida o payload. */
  enqueue(name: string, payload: Record<string, unknown>, opts: EnqueueOptions): Promise<void>;
  register(
    name: string,
    handler: (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
}

// src/adapters/queue/index.ts
export function createJobQueue(opts: { redisUrl: string }): JobQueue; // por agora devolve o adaptador BullMQ
```

**Steps:**

- [ ] Se `docs/cpanel-capacidades.md` §2 (Redis) tiver `Estado: Refutado`, saltar para o ramo B descrito no final desta tarefa.
- [ ] Escrever o teste falhado `tests/integration/job-queue.test.ts` (contrato; não depende do driver):

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobQueue } from '../../src/adapters/queue/index.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6380';

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timeout à espera de condição');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('enqueue idempotente: mesma idempotencyKey executa o handler uma só vez', async () => {
  const queue = createJobQueue({ redisUrl: TEST_REDIS_URL });
  const correlations: string[] = [];
  let runs = 0;
  await queue.register('test.noop', async (_payload, ctx) => {
    runs += 1;
    correlations.push(ctx.correlationId);
  });
  const payload = { leadId: '00000000-0000-4000-8000-000000000001' };
  await queue.enqueue('test.noop', payload, { idempotencyKey: 'k-1', correlationId: 'corr-1' });
  await queue.enqueue('test.noop', payload, { idempotencyKey: 'k-1', correlationId: 'corr-2' });
  await waitFor(() => runs >= 1);
  await new Promise((r) => setTimeout(r, 300)); // janela para um 2.º execução indesejada
  assert.equal(runs, 1);
  assert.deepEqual(correlations, ['corr-1']);
  await queue.close();
});
```

- [ ] Correr `npm run test:integration` → ver falhar (`bullmq`/adaptador inexistente).
- [ ] Implementar `src/ports/job-queue.ts`, `src/adapters/queue/bullmq.ts` (`new Queue(name, { connection })` por nome de fila, `jobId: opts.idempotencyKey`, retenção de jobs concluídos para que a mesma chave não reentre, `delay: opts.delayMs`; `Worker` por `register` com `concurrency: 1`, `ctx.attempt = job.attemptsMade`, e propagação de `opts.correlationId` no `data`), `src/adapters/queue/index.ts`. `npm install bullmq` e registar no ADR-0005.
- [ ] `npm run typecheck`, `npm run lint`, `npm run test:integration` → `pass`, `fail 0`.
- [ ] **Ramo B (só se Redis Refutado):** `npm install pg-boss`; implementar `src/adapters/queue/pgboss.ts` sobre `TEST_DATABASE_URL`/`DATABASE_URL`, com deduplicação exatamente-uma-execução (confirmar na doc da versão instalada `singletonKey` ou tabela nossa de `idempotency_keys` — o teste acima é o contrato e tem de passar sem alterações); `createJobQueue({ redisUrl })` passa a aceitar `{ databaseUrl: string }`; apagar `src/adapters/queue/bullmq.ts` e a dep `bullmq`; registar a troca em `docs/cpanel-capacidades.md` §5.
- [ ] Commit: `feat: add job queue port with bullmq adapter` (ramo B: `feat: add job queue port with pg-boss adapter (no redis on host)`).

### Task 8: Harness `evaluate()` executável e testes da rede de segurança

**Files:**
- Create: `tests/eval/run.ts`, `tests/unit/keyword-safety-net.test.ts`, `tests/unit/eval-baseline.test.ts`
- Modify: `package.json` (script `eval`)
- Test: `tests/unit/keyword-safety-net.test.ts`, `tests/unit/eval-baseline.test.ts`

**Interfaces:**
- Consumes: `tests/eval/handoff-scenarios.ts` (`scenarios`, `evaluate`, `TRIGGER_CODES`, `TriggerCode`), `src/domain/keyword-safety-net.ts` (`keywordSafetyNet`, `SAFETY_NET_COVERS`).
- Produces: comando `npm run eval` → relatório por gatilho coberto em stdout e exit 0; testes que fixam o baseline de `docs/05` §8.

**Steps:**

- [ ] Escrever `tests/unit/keyword-safety-net.test.ts` (função pura de `reference/`): `'quero falar com um atendente'` → `['human_requested']`; `'QUERO FALAR COM UM HUMANO!!!'` → `['human_requested']` (normalização de acentos/caixa); `'como é que eu pago?'` → `['purchase_intent']`; `'aceito a proposta, pode avançar'` → contém `purchase_intent`; `'Têm cobertura em Cacuaco?'` → `[]`; turnos `[customer('falar com uma pessoa'), ai('ok')]` → usa o texto do cliente; turno só de IA (`[{ from: 'ai', text: 'atendente' }]`) → `[]` (só o último turno de cliente conta).
- [ ] Escrever `tests/unit/eval-baseline.test.ts` com valores exatos de `docs/05` §8:

```ts
const result = await evaluate(
  scenarios,
  (s) => keywordSafetyNet(s.turns).filter((c): c is TriggerCode => (TRIGGER_CODES as readonly string[]).includes(c)),
  SAFETY_NET_COVERS,
);
assert.equal(scenarios.length, 72);
assert.equal(result.ambiguous.length, 4);
assert.equal(result.metrics.purchase_intent.precision, 1);
assert.equal(result.metrics.purchase_intent.recall, 1);
assert.equal(result.metrics.human_requested.precision, 1);
assert.equal(result.metrics.human_requested.recall, 0.75);
assert.deepEqual(result.misses, []); // falsos positivos: precisão 100% nos cenários pontuados
```

(O filtro sobre `TRIGGER_CODES` resolve a incompatibilidade entre `TriggerCode = string` de `ai-provider` e a união de 16 de `handoff-scenarios` sem casts.)

- [ ] Correr `npm test` → os dois ficheiros novos são testes do código que já existe (reference/), por isso **têm de passar**: `pass ≥ 25`, `fail 0`. Se `eval-baseline` falhar num número, é divergência com `docs/05` §8: **não alterar a spec nem enfraquecer o teste** — registar no relatório e perguntar ao dono; se `keyword-safety-net` falhar, conferir a expectativa contra `src/domain/keyword-safety-net.ts` e corrigir o teste só se a leitura do código o justificar.
- [ ] Acrescentar primeiro o script `"eval": "tsx tests/eval/run.ts"` ao `package.json` e correr `npm run eval` → **tem de falhar** (`Cannot find module tests/eval/run.ts`).
- [ ] Escrever `tests/eval/run.ts`: importa `scenarios`/`evaluate`/`TRIGGER_CODES`, classifica com a rede de segurança (filtro idêntico ao teste), imprime cabeçalho `=== Avaliação — rede de segurança por palavras-chave ===`, tabela `gatilho | tp | fp | fn | precisão | recall` para os `SAFETY_NET_COVERS`, lista `falhas:` (ids de `misses`) e `cenários ambíguos (fora da pontuação): pi-06, pi-07, pn-04, lb-06`; termina com exit 0. `no-console` está desligado em `tests/**`.
- [ ] Correr `npm run eval` → relatório completo impresso, exit 0; e `npm test` → `fail 0`.
- [ ] Commit: `feat: add evaluate harness and safety net baseline tests`.

### Task 9: Schema base em Drizzle com migrações geradas (não aplicadas)

**Files:**
- Create: `drizzle.config.ts`, `src/adapters/db/schema/index.ts`, `src/adapters/db/schema/enums.ts`, `src/adapters/db/schema/users.schema.ts`, `sessions.schema.ts`, `whatsapp-accounts.schema.ts`, `contacts.schema.ts`, `leads.schema.ts`, `conversations.schema.ts`, `messages.schema.ts`, `inbound-events.schema.ts`, `outbox.schema.ts`, `campaigns.schema.ts`, `followups.schema.ts`, `audit.schema.ts` (caminhos completos: `src/adapters/db/schema/<nome>`), `drizzle/0000_<nome-do-kit>.sql` (migração personalizada com `CREATE EXTENSION IF NOT EXISTS vector;`), `drizzle/0001_*.sql` + `drizzle/meta/_journal.json` (gerados), `docs/schema-base.md`, `tests/unit/schema-coverage.test.ts`
- Modify: (nenhum de `reference/`; `vector(1536)` mantém-se — a mudança para 384 é Fase 2, autorizada por ADR-0002)
- Test: `tests/unit/schema-coverage.test.ts`

**Interfaces:**
- Consumes: esboço de `docs/01` §6; `aiModeEnum` de `src/modules/knowledge/knowledge.schema.ts` (fonte única do enum, comentário do próprio ficheiro: "A usar na tabela de conversas da base"); A2 (`sessions`); regras de `docs/02` §5.
- Produces: 16 tabelas base exportadas de `src/adapters/db/schema/index.ts` (nome de tabela SQL entre parênteses): `users` (users), `sessions` (sessions), `whatsappAccounts` (whatsapp_accounts), `contacts` (contacts), `leads` (leads), `conversations` (conversations), `messages` (messages), `inboundEvents` (inbound_events), `outboxMessages` (outbox_messages), `campaigns` (campaigns), `campaignRecipients` (campaign_recipients), `campaignAccounts` (campaign_accounts), `followupSequences` (followup_sequences), `followupSteps` (followup_steps), `followupRuns` (followup_runs), `auditLog` (audit_log) — mais os 12 do módulo de conhecimento já existentes. Colunas-chave (restantes detalhes e perguntas vão para `docs/schema-base.md`): `whatsapp_accounts` (`phone_e164` único, `provider` `wa-akg`, `provider_session_id` único, `status`, `purpose`, `daily_send_cap`), `contacts` (`phone_e164` único, `marketing_consent`, `consent_at`, `consent_source`, `opted_out_at`), `conversations` (`ai_mode` com `aiModeEnum` default `ai_suggest` por D13, `miss_streak`, `last_message_at`), `messages` (`UNIQUE (account_id, provider_message_id)`, estados `queued|sent|delivered|read|failed`), `inbound_events` (`provider_event_id` único, `payload`, `received_at`, `processed_at`, índice parcial `WHERE processed_at IS NULL`), `outbox_messages` (`idempotency_key` único, `scheduled_at`, `attempts`, `last_error`, estados incl. `unknown_delivery`, `priority`), `audit_log` (ator, ação, entidade, ip, detalhes). Todos: `uuid` PK, `timestamptz`, `numeric` para dinheiro, FKs e índices por filtro frequente.

**Steps:**

- [ ] Escrever `drizzle.config.ts`: `dialect: 'postgresql'`, `schema: './src/**/*.schema.ts'`, `out: './drizzle'`, `strict: true`, `dbCredentials: { url: process.env.DATABASE_URL }` (`generate` é offline; `migrate` é só na Fase 1).
- [ ] Escrever `tests/unit/schema-coverage.test.ts` falhado: para cada par `[export, tabelaSQL]` da lista de Interfaces, `assert.ok(schema[export])` e `assert.equal(getTableConfig(schema[export]).name, tabelaSQL)`; e o mesmo para os 12 exports do módulo de conhecimento (`businessLines` … `answerTraces`).
- [ ] Correr `npm test` → ver falhar (`Cannot find module './src/adapters/db/schema/index.js'`).
- [ ] Implementar os 12 ficheiros de tabela + `enums.ts` + `index.ts` (`export * from './users.schema.js'` etc.), seguindo o padrão de `reference/knowledge.schema.ts` (`pk()`, `ts()`, `createdAt()`, `updatedAt()`, índices declarados no 2.º argumento). Enums novos em `enums.ts` (único sítio dos enums da base): `user_role`, `whatsapp_account_status`, `whatsapp_purpose`, `message_direction`, `message_sender`, `message_kind`, `message_status`, `outbox_status`, `campaign_status`, `campaign_recipient_status`; `conversations.ai_mode` importa `aiModeEnum` de `../../../modules/knowledge/knowledge.schema.js`. Vocabulários não definidos nos docs (`leads.stage`, estado de `leads`, estados de `followup_runs`) ficam como `text NOT NULL`, **sem inventar valores**, e entram nas perguntas do gate.
- [ ] Correr `npm test` → `pass`, `fail 0`.
- [ ] Gerar migrações **nesta ordem**: `npm run db:generate -- --custom --name=vector_extension` → criar/editar `drizzle/0000_vector_extension.sql` com uma linha `CREATE EXTENSION IF NOT EXISTS vector;`; depois `npm run db:generate` → `drizzle/0001_*.sql` com as tabelas. Confirmar que o `0000` contém a extensão e é aplicado antes (`drizzle/meta/_journal.json`).
- [ ] Correr `npm run db:generate` outra vez → saída esperada: `No schema changes …` (idempotente).
- [ ] **Não** correr `db:migrate` nem `push` (aplicação é Fase 1; o teste CI de aplicação desde zero também).
- [ ] Escrever `docs/schema-base.md`: âmbito e ficheiros; inventário tabela → colunas-chave → constraints → índices (cursor pagination em `messages`, `conversations`, `handoffs`); decisões de design (`line` modelado como FK `line_id` → `business_lines`; `sessions` por A2; junção `campaign_accounts` (deriva de "contas permitidas" em `docs/01` §6);`outbox` transacional com ligação a `messages` com estado `queued`; `daily_send_cap` como limite por conta sob a config global); **perguntas para o gate** (vocabulários de `leads.stage`/estado; estados de `followup_runs`; colunas de limites em `campaigns`; necessidade de `unknown_delivery` em `outbox_status`; `vector(1536)` mantido até à Fase 2 por ADR-0002); nota `migrações geradas e revistas nesta fase; aplicar a partir de zero é a primeira tarefa da Fase 1`.
- [ ] Commit: `feat: propose base schema with generated migrations (not applied)`.

### Task 10: Obter o fork/clone do WA-AKG com evidência

**Files:**
- Create: clone em `/home/niltoncosta/Documentos/Projetos/Milvendas/WA-AKG` (fora do repositório — nunca commitado), `docs/wa-akg-audit.md`
- Modify: (nenhum ficheiro do WA-AKG)
- Test: verificação de imutabilidade: `git -C ../WA-AKG status --porcelain` vazio

**Interfaces:**
- Consumes: `docs/04` §3 ("repositório de origem", só leitura); GitHub CLI autenticado (verificado: `gh` com sessão ativa); remoto `origin` do CRM já existe.
- Produces: secção `## 0. Origem e método` de `docs/wa-akg-audit.md`:

```markdown
## 0. Origem e método
- Repositório upstream: https://github.com/mrifqidaffaaditya/WA-AKG (MIT)
- Fork nosso: <URL>  |  ou: PENDENTE — pedido ao dono em <data> (motivo)
- Commit auditado: <SHA completo>  (branch: main)
- Data da auditoria: <data>
- Comandos de referência: git clone --no-tags <url> ../WA-AKG ; git -C ../WA-AKG rev-parse HEAD
- Método: análise estática (leitura + grep); execução do código do fork SÓ com `npm ci --ignore-scripts` e para as perguntas G20/G17, em clone descartável
- Imutabilidade: `git -C ../WA-AKG status --porcelain` vazio após a auditoria
- Nenhum segredo encontrado é transcribo sem mascaramento (`***`)
```

**Steps:**

- [ ] Verificar se já existe fork nosso: `gh repo list NiltonCarlosdawg --limit 100 | grep -i akg` → saída atual: sem fork (hipótese confirmada: é preciso criar/obter).
- [ ] Criar o fork: `gh repo fork mrifqidaffaaditya/WA-AKG --clone=false` → registar a URL do fork. **Se falhar (permissões/org a decidir pelo dono): marcar `PENDENTE — pedido ao dono` e clonar o upstream na mesma** (a auditoria não depende do fork; o fork é para depois, na Fase 1, com `docs/04` §9).
- [ ] Clonar sem executar nada: `git clone --no-tags <url-do-fork-ou-upstream> /home/niltoncosta/Documentos/Projetos/Milvendas/WA-AKG` e `git -C ../WA-AKG rev-parse HEAD` → registar SHA como **commit base do upstream** (`docs/04` §9.4).
- [ ] Escrever a secção `## 0. Origem e método` em `docs/wa-akg-audit.md` com a saída real dos comandos.
- [ ] Confirmar que o clone está fora do repositório: `git -C /home/niltoncosta/Documentos/Projetos/Milvendas/CRM status --porcelain` não mostra `WA-AKG/`.
- [ ] Commit: `docs: start wa-akg read-only audit with provenance evidence`.

### Task 11: Auditoria WA-AKG — A. API e B. Webhooks (perguntas 1–8)

**Files:**
- Create: (secções em `docs/wa-akg-audit.md`)
- Modify: `docs/wa-akg-audit.md`
- Test: revisão das evidências (cada resposta tem `ficheiro:linha` ou comando + saída)

**Interfaces:**
- Consumes: clone da Task 10; `docs/04` §3 A e B (perguntas 1–8 literalmente).
- Produces: em `docs/wa-akg-audit.md` as secções `## A. API` e `## B. Webhooks`, cada pergunta com:

```markdown
### A1 — Autenticação da API e rate limiting
- **Resposta:** <facto>
- **Evidência:** `<caminho-ficheiro>:<linha>` (comando: `<grep/leitura usado>`)
- **Estado:** Confirmado | Refutado | Não verificável
```

**Steps:**

- [ ] Descobrir a estrutura **sem a assumir**: `find ../WA-AKG -maxdepth 2 -not -path '*/node_modules*' -not -path '*/.git*' | sort` e `grep -rln "router\.\|app.use\|export async function" ../WA-AKG --include='*.ts' --include='*.js' | grep -v node_modules | head -50` → anotar onde vivem rotas e auth.
- [ ] Responder **A1** (auth da API: cabeçalho/API key/JWT; rate limiting) com evidência: `grep -rniE "api[-_]?key|authorization|bearer|rate.?limit" ../WA-AKG --include='*.ts' --include='*.js' --exclude-dir=node_modules | head -60` e leitura dos ficheiros assinalados (mascarar valores reais com `***`).
- [ ] Responder **A2** com a tabela completa de endpoints (método, caminho, função, corpo, resposta), extraída da estrutura real descoberta (ex.: ficheiros de rota do Next.js ou registo do framework encontrado), marcando os 9 de uso previsto: criar sessão, obter QR, estado, logout, enviar texto, enviar mídia, marcar como lido, indicador de escrita, listar sessões (`docs/04` §3 A2). **Não assumir nenhum caminho: só os listados pelo código.**
- [ ] Responder **A3** (chave de idempotência no envio; resposta com ID da mensagem; comportamento em timeout): `grep -rniE "idempoten|retry|timeout" <dir-das-rotas-de-envio>` + leitura do handler de envio até à chamada Baileys.
- [ ] Responder **A4** (limites de tamanho/tipos de mídia; entrega da mídia recebida: URL ou base64; TTL dos URLs): `grep -rniE "maxSize|fileSize|mime|downloadMedia|expires" ../WA-AKG --exclude-dir=node_modules | head -60` + leitura.
- [ ] Responder **B5** (eventos disponíveis e payloads reais): enumerar os pontos de emissão (`grep -rniE "emit\(|webhook" …`) e colar um payload de exemplo **do código** (fixtures/testes do próprio repo, se existirem; senão o objeto montado no código, indicando linhas).
- [ ] Responder **B6** (assinatura HMAC/segredo; configuração; por sessão ou global): `grep -rniE "hmac|createHmac|signature|x-secret|webhook.*secret" ../WA-AKG --exclude-dir=node_modules`.
- [ ] Responder **B7** (semântica de entrega, retries, timeout, ordem, duplicados): leitura do código de dispatch do webhook.
- [ ] Responder **B8** (desligamentos, QR novo, banimentos — que eventos emitem): `grep -rniE "logout|disconnected|qr|banned|connection.update" ../WA-AKG --exclude-dir=node_modules | head -60`.
- [ ] Verificar imutabilidade: `git -C ../WA-AKG status --porcelain` → vazio.
- [ ] Commit: `docs: audit wa-akg api and webhooks`.

### Task 12: Auditoria WA-AKG — C. Sessões, D. Dados, E. Funcionalidades a desligar (perguntas 9–16)

**Files:**
- Create: (secções em `docs/wa-akg-audit.md`)
- Modify: `docs/wa-akg-audit.md`
- Test: revisão das evidências (formato igual à Task 11)

**Interfaces:**
- Consumes: clone da Task 10; `docs/04` §3 C, D e E (perguntas 9–16 literalmente).
- Produces: secções `## C. Sessões`, `## D. Dados`, `## E. Funcionalidades a desligar` com o mesmo template de evidência.

**Steps:**

- [ ] **C9**: onde/guardam credenciais de sessão (ficheiros ou base); cifradas?; quem as lê: `grep -rniE "authState|useMultiFileAuthState|creds\.json|encrypt|cipher" ../WA-AKG --exclude-dir=node_modules` + leitura dos ficheiros assinalados e dos caminhos de gravação.
- [ ] **C10**: reconexão automática (quando, o que emite, o que falha) e expiração do QR: `grep -rniE "reconnect|retry|qr.*expire|keep.?alive" ../WA-AKG --exclude-dir=node_modules` + leitura do ciclo de vida da conexão.
- [ ] **C11**: limite de sessões simultâneas e memória por sessão: `grep -rniE "maxSessions|MAX_SESSION|sessions\.size|limit" ../WA-AKG --exclude-dir=node_modules | head -40`; se não existir limite no código → `Refutado` com essa evidência.
- [ ] **C12**: mensagens recebidas com sessão offline e reconciliação de lacunas: leitura do handler de `messages.upsert`/offline e de qualquer buffer; sem mecanismo → `Não verificável`/`Refutado` com evidência (é lacuna candidata a bloqueante para `docs/04` §8).
- [ ] **D13**: schema Prisma — que dados de mensagens/contactos guarda; é possível desligar o armazenamento ou limitar retenção: `find ../WA-AKG -name 'schema.prisma' -not -path '*/node_modules/*'` → ler os modelos; `grep -rniE "retention|deleteOld|prune" ../WA-AKG --exclude-dir=node_modules`.
- [ ] **D14**: migrações e versão de BD exigida: `find ../WA-AKG -path '*migrations*' -name '*.sql' | head` e `grep -n "provider\|url" <schema.prisma>`.
- [ ] **E15**: auto-reply, broadcast, agendador, dashboard — como desligam por configuração; defaults ativos: `grep -rniE "AUTO_REPLY|BROADCAST|SCHEDULE|ENABLE_DASHBOARD|feature.*flag" ../WA-AKG --include='*.ts' --include='*.js' --include='*.env*' --exclude-dir=node_modules | head -60` + leitura dos `.env.example`/config.
- [ ] **E16**: utilizadores/credenciais por defeito (seeds, `SUPERADMIN` inicial, palavras-passe/chaves por defeito): `grep -rniE "SUPERADMIN|default.*password|seed|changeme|admin123" ../WA-AKG --exclude-dir=node_modules | head -60` (mascarar valores).
- [ ] Verificar imutabilidade e commit: `docs: audit wa-akg sessions data and features`.

### Task 13: Auditoria WA-AKG — F. Segurança, G. Qualidade e operação + conclusão (perguntas 17–22)

**Files:**
- Create: (secções em `docs/wa-akg-audit.md`)
- Modify: `docs/wa-akg-audit.md`
- Test: conclusão com lacunas bloqueantes e proposta por lacuna

**Interfaces:**
- Consumes: clone da Task 10; `docs/04` §3 F e G (perguntas 17–22) + `docs/04` §9 (candidatos a patch) + `docs/01` §10.2 (higiene do repo a verificar).
- Produces: secções `## F. Segurança`, `## G. Qualidade e operação` no mesmo template + `## Conclusão — lacunas bloqueantes` com tabela `Lacuna | Evidência | Proposta (configurar | contornar no adaptador | patch mínimo candidato)` e a nota `Patch: exige ADR e aprovação humana (docs/04 §9); nenhum está pré-aprovado.`

**Steps:**

- [ ] **F17**: `cd ../WA-AKG && npm audit --omit=dev --json > /tmp/wa-akg-audit-npm.json; jq '.metadata.vulnerabilities' /tmp/wa-akg-audit-npm.json` (instalar dependências só se necessário e **sempre** `npm ci --ignore-scripts`; registar contagem de vulnerabilidades por severidade); `grep -n '"postinstall"\|"preinstall"' package.json`; `grep -n 'baileys\|"next"' package.json`; conteúdo e motivo de `patches/`: `find ../WA-AKG -maxdepth 2 -name 'patches' -type d` + `git -C ../WA-AKG log --oneline -- patches | head -20` + leitura dos diffs.
- [ ] **F18**: validação de entrada, uploads, SSRF dos webhooks (URLs configuráveis), CORS, headers, segredos em logs: `grep -rniE "cors|origin|helmet|zod|joi|upload|multipart" ../WA-AKG --exclude-dir=node_modules | head -60`; `grep -rniE "console\.(log|error).*token|console\.log.*(creds|session)" ../WA-AKG --exclude-dir=node_modules | head -40` (mascarar).
- [ ] **F19**: segredos em código ou no histórico: `grep -rniE "(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][^'\"]{8,}" ../WA-AKG --exclude-dir=node_modules --exclude-dir=.git | head -40` e `git -C ../WA-AKG log --all -p | grep -inE "(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][^'\"]{8,}" | head -40` — qualquer valor encontrado entra **mascarado** (`***`) na evidência.
- [ ] **G20**: testes e CI: `grep -n '"test' package.json`; correr (clone descartável, `npm ci --ignore-scripts`): `npm test` (ou o script de teste descoberto) e colar a saída; `find ../WA-AKG -maxdepth 2 -path '*workflows*' -o -name '.gitlab-ci.yml' | head`; ficheiros soltos da raiz: `git -C ../WA-AKG ls-files | grep -E '^(eslint-errors\.txt|ts_errors\.log|lint_output\.txt|tmp-missing-APIs\.txt|API_REFACTOR_TASK\.txt|test-.*\.js)$'` → "lixo ou trabalho em curso" com leitura curta de `tmp-missing-APIs.txt` (APIs em falta?).
- [ ] **G21**: como corre (Docker/PM2), healthcheck, logs, requisitos de recursos, upgrade: `grep -rniE "pm2|healthcheck|/health|LOG_LEVEL" ../WA-AKG/package.json ../WA-AKG/docker* ../WA-AKG/README* 2>/dev/null | head -40` + secção de arranque do README.
- [ ] **G22**: versão exata do Next.js e motivo da inconsistência no README: `grep -n '"next"' package.json`, `grep -in "next" README.md | head -10`, `git -C ../WA-AKG log -S'"next":' --oneline -- package.json | head -10`.
- [ ] Escrever `## Conclusão — lacunas bloqueantes` listando pelo menos os candidatos de `docs/04` §3 (sem assinatura de webhooks, sem idempotência no envio, sem forma de desligar o armazenamento de mensagens, dashboard/Swagger públicos, credenciais por defeito, armazenamento de credenciais sem cifra) **apenas com estado e evidência** — cada um com proposta: configurar / contornar no adaptador / patch mínimo candidato (não pré-aprovado).
- [ ] Verificar imutabilidade: `git -C ../WA-AKG status --porcelain` → vazio; commit: `docs: audit wa-akg security and operations with conclusions`.

### Task 14: CI (lint, typecheck, testes, eval, audit, secret scan)

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` (nenhum script novo; `npm audit` corre como passo do CI)
- Test: execução real do workflow

**Interfaces:**
- Consumes: comandos das Tasks 1–9 (`lint`, `typecheck`, `test`, `eval`, `test:integration`); repositório GitHub `NiltonCarlosdawg/Super-CRM`, ramo `main`.
- Produces: pipeline com 2 jobs — `checks` (`npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run eval`, `npm audit --audit-level=high`, `gitleaks`) e `integration` (`npm ci`, `npm run test:integration` com sobe/teste/derruba próprios).

**Steps:**

- [ ] Criar `.github/workflows/ci.yml` exato:

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run eval
      - run: npm audit --audit-level=high
      - uses: gitleaks/gitleaks-action@v2
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run test:integration
```

- [ ] Reproduzir localmente tudo o que o CI corre, nesta ordem, e colar a saída no relatório: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run eval`, `npm run test:integration`, `npm audit --audit-level=high` — todos com exit 0. Se `npm audit` falhar por advisory sem correção: **não baixar o limiar**; registar no relatório e perguntar ao dono.
- [ ] Fixar os `uses:` ao SHA (`gh api repos/actions/checkout/commits/v4 --jq .sha`, idem `setup-node` e `gitleaks-action`) e re-commitar (docs/03 §9: nada de tags soltas).
- [ ] Validar remotamente: commit + `git push` (sem `--force`), `gh run watch` até verde → registar a URL do run como evidência de que lint/typecheck/testes passam em CI.
- [ ] Commit: `ci: add pipeline with lint typecheck tests and secret scan`.

### Task 15: Comandos reais no `AGENTS.md`, verificação final e relatório

**Files:**
- Create: (nenhum)
- Modify: `AGENTS.md` (só o bloco `## Comandos`)
- Test: cada comando listado é executado com exit 0

**Interfaces:**
- Consumes: scripts reais das Tasks 1–9 e 14.
- Produces: bloco `## Comandos` do `AGENTS.md` exatamente:

````
```
install:           npm ci
dev:               npm run dev
lint:              npm run lint
typecheck:         npm run typecheck
test:              npm test
test:integration:  npm run test:integration   # precisa Docker; contentores sobem e descem no próprio script
db:generate:       npm run db:generate
db:migrate:        npm run db:migrate          # só com DATABASE_URL de desenvolvimento; aplicação é Fase 1
eval:              npm run eval                # avalia o classificador contra tests/eval/handoff-scenarios.ts
```
````

**Steps:**

- [ ] Substituir o bloco `## Comandos` do `AGENTS.md` (que está com `(a definir)`) pelo bloco acima, incluindo o comentário do `eval` com o caminho novo (`tests/eval/handoff-scenarios.ts`, movido na Task 6).
- [ ] Correr e registar a saída de cada um, por ordem: `npm ci` → `added N packages`; `npm run lint` → `0 problems`; `npm run typecheck` → sem erros; `npm test` → `pass ≥ 26`, `fail 0` (17 do orquestrador + logger + config + safety-net + baseline + cobertura + smoke); `npm run test:integration` → `pass ≥ 5`, `fail 0`; `npm run eval` → relatório; `npm run db:generate` → `No schema changes`; `npm run dev` → linha `application.started` e saída 0.
- [ ] `npm run db:migrate`: **não executar** nesta fase — confirmar apenas que o script existe (`grep -n '"db:migrate"' package.json`) e registar no relatório que a primeira execução é a tarefa 1 da Fase 1 (migrações nunca aplicadas até ao gate de schema).
- [ ] Verificação final da estrutura: `find src tests -type d | sort` corresponde a `docs/02` §1; `git status --porcelain` vazio; `git log --oneline` com commits convencionais e nenhum teste a falhar.
- [ ] Escrever o relatório da fase (mensagem do PR final) com: o que mudou, output real dos comandos do passo 2, o que ficou por fazer (Docker local pendente se aplicável, evidências A5 `Pendente`, fork `PENDENTE` se aplicável), riscos novos e decisões que precisam de humano (perguntas do `docs/schema-base.md`, lacunas bloqueantes da auditoria).
- [ ] Commit: `docs: fill agent commands and run final verification`.

## Gate de fim de fase

Aprovação humana obrigatória antes de começar a Fase 1 (`docs/01` §8, Fase 0):

- [ ] **Auditoria do WA-AKG aprovada:** `docs/wa-akg-audit.md` com resposta + evidência (`ficheiro:linha` ou comando+saída) + estado nas 22 perguntas, e `## Conclusão — lacunas bloqueantes` com proposta por lacuna.
- [ ] **Schema base aprovado:** `src/adapters/db/schema/`, `docs/schema-base.md` (incluindo as perguntas do gate) e migrações geradas em `drizzle/` **ainda não aplicadas** — a aplicação a partir de zero é a primeira tarefa da Fase 1.
- [ ] **Verificações do cPanel com evidência** (`docs/06` §A5 — é também gate, "antes de avançar"): as 4 verificações de `docs/cpanel-capacidades.md` com estado `Confirmado`/`Refutado` e a escolha dos planos B registada (pgvector→FTS; Redis→pg-boss; websockets→long-polling; RAM→MiniLM).

Sem gate adicional nesta fase. A Fase 1 consome exatamente estes contratos: schema base aprovado (entidades de `docs/01` §6), auditoria aprovada (base para o adaptador `MessagingProvider` de `docs/04` §5) e o port de jobs escolhido. O primeiro envio real de WhatsApp continua protegido pelo gate da Fase 1.
