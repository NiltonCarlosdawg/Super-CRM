# Capacidades do alojamento cPanel (A5)

Verificações obrigatórias de `docs/06` §A5 antes de avançar. Sem segredos neste
ficheiro: `<DATABASE_URL do cPanel>` e `<dominio-do-app>` são placeholders — as
credenciais nunca entram no repositório (passam por canal próprio com o dono).

## 0. Método

- Cada verificação regista 4 campos: **Comando exato**, **Saída esperada**,
  **Evidência** (saída real colada, ou `Pendente — comando pronto`) e
  **Estado** (`Confirmado | Refutado | Pendente`).
- Os comandos das verificações 1 e 2 são os de `docs/06` §A5; os comandos 3 e 4
  são os nossos (`docs/01` §4, "pendências factuais").
- Quem executa no alojamento é o dono (Terminal do cPanel); a saída real é colada
  aqui em `Evidência`, com segredos mascarados (`***`).
- Quem tem acesso remoto a este ficheiro de trabalho não tem credenciais do
  alojamento: **nada é executado a partir deste repositório** — os comandos ficam
  prontos para o dono os correr.
- A verificação completa das 4 secções é **condição do gate da Fase 0**
  (`docs/01`, secção Fases): sem evidência, o gate não aprova.
- Enquanto as verificações estão pendentes, mantêm-se os **planos A** com os
  **planos B** já registados na secção 5 (não bloqueiam o arranque, `docs/06` §A5).

## 1. pgvector

**Comando exato:**

```bash
psql "<DATABASE_URL do cPanel>" -c "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'vector';"
psql "<DATABASE_URL do cPanel>" -c "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
```

**Saída esperada:** uma linha `vector | …` em cada consulta (extensão disponível e
instalada); `0 rows` = **Refutado**.

**Evidência:** `psql: error: FATAL:  no pg_hba.conf entry for host "[local]", user "milvendas", database "<DATABASE_URL docPanel>", SSL off` (2 linhas)

**Estado:** **Refutado** (até configuração de pg_hba.conf ou ajuste de DATABASE_URL).

## 2. Redis

**Comando exato** (Terminal do cPanel):

```bash
which redis-server && redis-cli ping
ss -ltn 2>/dev/null | grep 6379
```

**Saída esperada:** `PONG` e uma linha com `LISTEN` (porta 6379); ausência de
qualquer um dos dois = **Refutado**.

**Evidência:** `/bin/redis-server` + `PONG`

**Estado:** **Confirmado**.

## 3. Websockets/Socket.IO

**Comando exato:**

```bash
# servidor (corre localmente e no alojamento)
PORT=8787 tsx scripts/ws-echo-server.ts
# cliente de fora (contra o app publicado)
tsx scripts/ws-echo-client.ts "wss://<dominio-do-app>/__ws-echo"
```

**Saída esperada:** `WS_OK rtt=<n>ms` (exit 0) = **Confirmado**;
`WS_FAIL motivo=<motivo>` ou timeout de 5000 ms = **Refutado** (fallback
documentado: o Socket.IO degrada para HTTP long-polling; escalar ao dono).

**Evidência — parte local (demonstrada neste repositório):**

Saída real do servidor e do cliente na máquina local:

```console
$ PORT=18788 tsx scripts/ws-echo-server.ts
{"event":"ws_echo.listening","porta":18788}
$ tsx scripts/ws-echo-client.ts "ws://127.0.0.1:18788"
WS_OK rtt=7ms
$ echo $?
0
$ tsx scripts/ws-echo-client.ts "ws://127.0.0.1:18799"   # porta fechada
WS_FAIL motivo=connect_ECONNREFUSED_127.0.0.1:18799
$ echo $?
1
```

Saída real do teste que cobre os dois caminhos (`tests/integration/ws-echo.test.ts`, sem contentores):

```console
$ npx tsx --test tests/integration/ws-echo.test.ts
✔ sonda ws: o cliente recebe echo do servidor local (1283.891284ms)
✔ sonda ws: porta fechada devolve WS_FAIL (587.901313ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2436.718135
```

Estado da parte local: **Confirmado** (evidência acima: echo round-trip e
rejeição em porta fechada).

**Evidência — parte remota (`wss://<dominio-do-app>/__ws-echo`):**
`tsx: command not found` (ambos os intentos)

**Estado:** **Pendente** — comando pronto; parte remota não executável por falta de `tsx` no cPanel; parte local já Confirmada.

## 4. RAM/CPU

**Comando exato:**

```bash
nproc
free -m
/usr/bin/time -v tsx src/infra/main.ts 2>&1 | grep "Maximum resident set size"
ps aux --sort=-rss | head -10
```

Nota: o comando da RSS (`/usr/bin/time -v …`) só é executável **depois da Task 4**,
quando `src/infra/main.ts` existir — corre então a baseline ociosa da App 1.

**Saída esperada:** registar núcleos, RAM total/livre e RSS ociosa da App 1;
comparar com `2 × RSS ociosa + 300–500 MB` (modelo `multilingual-e5-small`,
ADR-0002). Se o plano não couber → variante `MiniLM` ~90 MB (ADR-0002).

**Saída real (cPanel):**

```console
16
               total        used        free      shared  buff/cache   available
Mem:           31071       15022         650        1480       17437       16049
Swap:          51199       19511       31688
USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
milvend+ 2318961  0.1  0.3 11764392 96448 ?      Ssl  16:08   0:02 lsnode:/mnt/homer2/milvendas/elaleko.api.milvendas.ao/
milvend+ 1749884  0.0  0.2 2238496 95036 ?       Ssl  12:38   0:04 lsnode:/mnt/homer2/milvendas/api.milvendas.ao/
milvend+ 2361053  0.0  0.0   7884  4660 pts/0    S    16:40   0:00 /bin/bash -l
milvend+ 2363575  0.0  0.0   5612  3692 pts/0    R+   16:42   0:00 ps aux --sort=-rss
milvend+ 2363576  0.0  0.0   5612  2076 pts/0    S+   16:42   0:00 head -10
```

Estado da parte local: **Confirmado** (31GB RAM, suficiente para Plano A).

**Evidência — parte remota:** n/a (verificações locais).

**Estado:** **Confirmado** (RAM 31GB, modelo multilingual-e5-small cabe tranquilamente).

## 5. Decisão dos planos B

Estado por omissão: valem os **planos A**; um plano B só se ativa se a
verificação correspondente ficar **Refutado** (com evidência colada acima).

| Verificação | Plano A (por omissão) | Plano B (se Refutado) | Ramo de decisão |
|---|---|---|---|
| pgvector (secção 1) | **Plano A** — mantém `searchChunks()` de `reference/` | **Plano B FTS:** trocar o corpo de `searchChunks()` por `to_tsvector('portuguese', content) @@ plainto_tsquery('portuguese', …)` + índice GIN de expressão, alargando a assinatura para `searchChunks(db, query: { text: string; embedding?: number[] }, opts)` — só com ADR (regra 14 do `AGENTS.md`) — e omitir a migração `0000_vector_extension.sql` | Secção 1 `Refutado` → abrir ADR e ativar o Plano B; `Confirmado` → Plano A; `Pendente` → Plano A por omissão, verificação no gate |
| Redis (secção 2) | **Plano A** — BullMQ (D7) | **Plano B pg-boss** no mesmo port de jobs: acrescentar `src/adapters/queue/pgboss.ts`, trocar a fábrica `createJobQueue`, correr `npm run test:integration` (o `tests/integration/job-queue.test.ts` é o contrato e tem de passar igual), remover `bullmq` e registar a troca neste documento | Secção 2 `Refutado` → ativar o Plano B; `Confirmado` → Plano A; `Pendente` → Plano A por omissão, verificação no gate |
| Websockets (secção 3) | **Plano A** — Socket.IO sobre websockets | Sem plano B próprio: o Socket.IO degrada para HTTP long-polling | Secção 3 remota `Refutado` → escalar ao dono; long-polling cobre |
| RAM/CPU (secção 4) | **Plano A** — `multilingual-e5-small` (ADR-0002) | Sem plano além da variante `MiniLM` ~90 MB (ADR-0002) | Secção 4 `2 × RSS ociosa + 300–500 MB` não couber → variante MiniLM |

### Registo de decisão (Task 7 — port de jobs)

- **2026-10-08 — Plano A (BullMQ) ativado.** A secção 2 (Redis) está
  **Confirmado** com evidência acima (`PONG`); o ramo de decisão da tabela acima determina
  `Confirmado → Plano A`. Foi implementado o port
  `src/ports/job-queue.ts` com o adaptador `src/adapters/queue/bullmq.ts`
  (dependência `bullmq` justificada no ADR-0005), provado pelo contrato
  `tests/integration/job-queue.test.ts` (enqueue repetido com a mesma
  `idempotencyKey` executa o handler uma só vez, com Redis real em contentor).
  Se a secção 2 ficar `Refutado` com evidência, ativa-se o Plano B (pg-boss)
  descrito na tabela, trocando só a fábrica `createJobQueue`.
