# Desenho — Deploy automático do CRM no cPanel (frontend + backend + migrations)

- **Data:** 2026-11-05 · **Estado:** aprovado pelo dono a 2026-11-05 — construir.
- **Decisões do dono (2026-11-05):** SSH será ativado no cPanel **[dono]**; segredos do servidor em ficheiro `.env` na raiz da app Node **[dono]**; **primeiro deploy automático desde já**, sem passo manual supervisionado — migrations correm desde o primeiro deploy **[dono]** (nota do agente: G8/G9 continuam a ser verificação obrigatória antes do primeiro deploy, porque sem pgvector a migration `0000` falha e a cadeia toda para).
- **Origem:** brainstorming com o dono (2026-11-05). Decisões do dono marcadas **[dono]**; chamadas minhas marcadas **[call]**.
- **Decisão de arquitetura:** `docs/adr/0016-deploy-automatico-cpanel-github-actions.md` (Estado: proposto).
- **Repo:** `NiltonCarlosdawg/Super-CRM` · branch `main` · worktree `deploy-cpanel-auto`.

## 1. Intenção e porquê

Hoje um `push` para `main` corre a CI e depois **não faz nada** — o job `deploy` é um
placeholder (`ci.yml:81-87`). O dono quer que um `push` actualize o frontend e o backend
publicados, **incluindo as migrations da base de dados** **[dono]**.

Sem isto, cada versão do CRM sai manualmente para o cPanel: copy-paste de `dist/`,
`npm ci` à mão, migrations à mão. É exactamente o tipo de tarefa que se esquece a meio.

## 2. Objetivos

- `push` para `main` → **frontend** publicado em `supcrm.milvendas.ao` **[dono]**.
- `push` para `main` → **backend** publicado em `api.supercrm.milvendas.ao` (nome escolhido por mim **[call]**; o dono deixou a escolha a meu cargo **[dono]**).
- `push` para `main` → **`npm run db:migrate`** corre no servidor antes do backend reiniciar **[dono]**.
- Deploy **só** depois de a CI (lint, typecheck, testes, secret scan) passar.
- Nada de segredos no repositório; nada da configuração do servidor versionada por engano.
- O frontend continua a funcionar **sem mudar uma linha do código do frontend** (os seus
  `/v1/...` são relativos e o Socket.IO é same-origin por desenho).

## 3. Não-objetivos e anti-objetivos

- **Não** criar staging, blue-green nem rollback automático nesta versão.
- **Não** adicionar CI de frontend completo (lint/typecheck/test) — o `ci.yml` hoje só tem
  job de backend. Está fora do pedido; fica registado como melhoria possível **[call]**.
- **Não** mexer no WA-AKG, no schema, no orquestrador nem em nenhum módulo de negócio.
- **Não** expor o backend por porta pública (só 80/443 estão abertas — verificado).
- **Não** pôr `DATABASE_URL`, `AUTH_SECRET`, `WA_AKG_API_KEY` nem `AI_API_KEY` no repo.
- **Não** automatizar o **primeiro** deploy: a primeira vez corre com supervisão humana
  (é produção; `docs/03` §10 exige plano de operação).
- Anti-objetivos (falham a entrega): o deploy correr num cron ou num PR; o `.env` do servidor
  ser apagado pelo rsync; o frontend publicar sem `/v1` funcionar; uma migration a falhar
  deixar a app nova a correr contra base velha.

## 4. Evidência verificada (2026-11-05)

Factos com fonte — nada abaixo é suposição.

| Facto | Evidência |
|---|---|
| Repo `NiltonCarlosdawg/Super-CRM`, **público**, default branch `main`, último push 2026-11-04 | `gh repo view … --json defaultBranchRef,pushedAt,visibility` |
| `gh` autenticado como `NiltonCarlosdawg`, scopes `gist, read:org, repo, workflow` | `gh auth status` |
| Só existe o workflow `CI`; **nenhuma deploy key** | `gh api …/actions/workflows` → `CI` · `gh api …/keys` → `[]` |
| Segredo único no GitHub: `AI_API_KEY` | `gh secret list` |
| Job `deploy` é placeholder | `.github/workflows/ci.yml:81-87` |
| Condição actual do deploy testa só `github.ref` (correria também no cron diário) | `.github/workflows/ci.yml:9-10` (`schedule: 17 3 * * *`) e `:84` |
| Frontend usa URLs **relativos** `/v1/...` (113 refs) e `io({withCredentials:true})` sem URL | `packages/frontend/src/lib/*` · `packages/frontend/src/lib/socket.tsx:76-79` |
| Vite só faz proxy em **dev** (`/v1`, `/socket.io` → `localhost:3001`) | `packages/frontend/vite.config.ts:11-20` |
| Backend escuta em `127.0.0.1` na porta de `PORT` | `packages/backend/src/infra/main.ts:417` |
| Backend **não tem script `start`**; `tsx` está em `devDependencies`; `tsconfig` tem `noEmit: true` | `packages/backend/package.json:8-19,47` · `tsconfig.json:12` |
| Já há precedente de `--env-file-if-exists=.env` no repo | `packages/backend/package.json:17-18` |
| `/health/live` e `/health/ready` são públicos | `packages/backend/src/adapters/http/app.ts:166,177` |
| Sem `import.meta` em `packages/backend/src` | `grep -rn "import\.meta" packages/backend/src` → vazio |
| Migrations Drizzle `0000`–`0016` em `packages/backend/drizzle/` | `ls packages/backend/drizzle/*.sql` |
| **cPanel:** conta `milvendas`, domínio `milvendas.ao`, IP `135.181.34.42`, home `/mnt/homer2/milvendas` | painel cPanel (secção "Informações gerais") |
| **cPanel** tem *Setup Node.js App*, *Application Manager*, *Acesso SSH*, *Git Version Control*, *Terminal*, *Manage API Tokens* | painel cPanel (secção Software/Segurança) |
| Já existem 2 apps Passenger: `…/api.milvendas.ao/` e `…/elaleko.api.milvendas.ao/` | `ps aux` colado em `docs/cpanel-capacidades.md:138-139` |
| `https://api.milvendas.ao/` → **200**; `http://` → **301**; `https://elaleko.api.milvendas.ao/` → **200** | `curl -sS -o /dev/null -w 'HTTP %{http_code}'` |
| Certos **Let's Encrypt** automáticos (`NotAfter: Jan 18 2027`) | `openssl s_client -connect api.milvendas.ao:443` |
| Portas **80 e 443 abertas**; 3000, 3001, 8080, 8443 **fechadas** | `bash -c 'cat </dev/null >/dev/tcp/135.181.34.42/P'` |
| `supcrm.milvendas.ao` e `api.supercrm.milvendas.ao` **ainda não existem** (sem registo A) | `dig +short <host> A` → vazio |
| Redis **Confirmado** (`PONG`); RAM 31 GB / 16 cores; quota da conta 1 GB | `docs/cpanel-capacidades.md:52-54,130-149` · painel cPanel |
| **pgvector Refutado** (erro `pg_hba.conf`) | `docs/cpanel-capacidades.md:36-38` |

## 5. Topologia alvo

```
push → main ─► GitHub Actions (ci.yml)
                 ├─ backend:  npm ci, lint, typecheck, test, test:contract, eval:baseline
                 ├─ secret-scan (gitleaks)
                 └─ deploy  [só se os dois acima passarem]
                      ├─ build do frontend no runner (vite build)
                      ├─ rsync packages/frontend/dist  → docroot de supcrm.milvendas.ao
                      ├─ rsync packages/backend/*      → raiz da app Node de api.supercrm.milvendas.ao
                      ├─ SSH: npm ci (no servidor)
                      ├─ SSH: npm run db:migrate       ← ANTES do restart
                      └─ SSH: restart da app Node

supcrm.milvendas.ao      → Apache: estático (dist/) + reverse proxy de /v1 e /socket.io
api.supercrm.milvendas.ao→ Passenger: packages/backend (Node ≥ 24, escuta 127.0.0.1:PORT)
```

**Porque é que o frontend precisa de proxy:** o frontend chama `/v1/...` e liga o
Socket.IO à **mesma origem** (`socket.tsx:76-79`). Se publicássemos só HTML estático, as
113 chamadas à API iriam para o servidor estático e davam 404. Alternativa seria
`VITE_API_BASE_URL` + CORS + cookies `SameSite=None` — mexe em segurança e em `docs/03` §4,
por isso **não** é a escolha **[call]**.

## 6. O fluxo de deploy (passo a passo)

1. `push` para `main`.
2. CI do backend + secret-scan. Se falharem → **não há deploy**.
3. Runner: `npm ci && npm run build` em `packages/frontend` → `packages/frontend/dist/`.
4. Runner: autentica SSH com chave dedicada (`ssh-agent` + `ssh-keyscan` — **sem actions de
   terceiros**, só `actions/checkout` e `actions/setup-node`, os já usados em `ci.yml`).
5. `rsync` do `dist/` para o docroot do frontend, e de `packages/backend/` para a raiz da
   app Node. **`--exclude='.env'`** e **`--exclude='node_modules/'`** são obrigatórios.
6. SSH: `npm ci` na raiz da app Node (inclui dev deps — `tsx` é devDep **[call]**).
7. SSH: `npm run db:migrate`.
8. SSH: restart da app Node.
9. Verificação: `curl https://supcrm.milvendas.ao/` → 200;
   `curl https://api.supercrm.milvendas.ao/health/live` → `{"status":"ok"}`.

Passos 6–8 são um único `ssh` com `set -e`, para não deixar a base migrada e a app parada
entre duas ligações.

## 7. Gate 0 — verificar ANTES de escrever qualquer configuração

Nada disto é verificável sem acesso ao servidor. **Sem estas respostas, não se escreve
`.htaccess` nem se escolhe o mecanismo de arranque.** O dono tem de iniciar sessão no
cPanel outra vez (a sessão expirou a 2026-11-05) ou activar SSH **[dono]**.

| # | O que determinar | Como | Porquê |
|---|---|---|---|
| G1 | SSH está activo? (`Acesso SSH`) | painel cPanel | Sem SSH não há deploy automático (opção 1 do ADR) |
| G2 | Node disponível é **≥ 24**? | `node -v` no Terminal | `packages/backend/package.json:5-7` exige `>=24` |
| G3 | Docroot real de `supcrm.milvendas.ao` após criar o subdomínio | painel Domínios | O rsync precisa do caminho exacto |
| G4 | Como o Passenger arranca a app existente (`api.milvendas.ao`): startup file? `npm start`? env vars? | Application Manager / `~/api.milvendas.ao/` | Decide o script `start` que vamos escrever |
| G5 | Endereço local **estável** do backend (porta fixa? socket?) | config da app + `ss -ltn` | O `.htaccess` do frontend tem de proxyar para ele |
| G6 | `mod_proxy`, `mod_proxy_http`, `mod_proxy_wstunnel`, `mod_rewrite` activos? | `httpd -M` ou teste real | Sem eles o reverse proxy não funciona |
| G7 | `AllowOverride` permite `RewriteRule [P]` no docroot? | config do vhost / teste | `ProxyPass` **não** é permitido em `.htaccess`; `RewriteRule [P]` sim, *se* estiver permitido |
| G8 | `pgvector` existe mesmo? (`pg_available_extensions`) | `psql` no servidor | `0000_vector_extension.sql` **falha** sem ela → **migrations automáticas nunca correriam** |
| G9 | Base de produção do CRM já tem migrations aplicadas? | `psql` → tabela `__drizzle_migrations` | Sem isto, o primeiro `db:migrate` aplica **tudo de uma vez** em produção |
| G10 | `argon2` e `@napi-rs/canvas` compilam no host? | `npm ci` manual na app | São módulos nativos (`docs/adr/0006`); se falharem, não há backend |

**G8 e G9 são bloqueadores das migrations automáticas** — ver §9.

## 8. Decisões em aberto (só o dono decide)

1. **SSH ou sessão do cPanel?** O deploy precisa de SSH (G1). Activar em cPanel → *Acesso
   SSH* é passo do dono **[dono]**. Sem SSH, a opção é API token do cPanel (ADR opção 2,
   mais frágil) — ou desistir do automático.
2. **Onde é que ficam os segredos do servidor?** Recomendo `.env` na raiz da app Node
   (fora do repo, permissões 600), carregado por `tsx --env-file-if-exists=.env` — igual
   ao padrão já usado em `eval` (`package.json:17-18`). Alternativa: variáveis de ambiente
   na UI do Application Manager (não versionável, 45+ campos) **[call]**.
3. **Primeiro deploy:** manual e supervisionado, depois automatizar **[call]**. Automatizar
   à primeira sem ter G8/G9 resolvido arrisca partir a base de produção.
4. **Migrations automáticas a partir de quando?** Recomendo: só depois de G8 e G9 estarem
   verificados e de uma aplicação limpa numa base vazia (regra 11 + definição de pronto do
   `AGENTS.md`) **[call]**.

## 9. Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| **`pgvector` indisponível** → `0000_vector_extension.sql` falha | **Toda a cadeia de migrations para** | G8 primeiro. Se confirmar indisponível, ativa o Plano B FTS de `docs/cpanel-capacidades.md:158` — exige **ADR** (regra 14) e está **fora do âmbito desta entrega** |
| Migration falha a meio | Base parcialmente migrada com app antiga a correr | Correr migrations **antes** do restart; primeiro em base vazia (G9); ter backup da base antes do primeiro deploy |
| `.env` do servidor apagado pelo rsync | App não arranca, segredos perdidos | `--exclude='.env'` obrigatório + teste |
| Porta do backend muda a cada restart | `/v1` do frontend deixa de funcionar em silêncio | G5: só usar alvo **estável**; verificar com `curl` no fim do deploy |
| `mod_proxy`/`[P]` indisponíveis | Frontend publica mas a API não responde | G6/G7 **antes** de escrever `.htaccess`; teste real antes do primeiro deploy |
| `npm ci` falha em módulos nativos (`argon2`, `@napi-rs/canvas`) | Backend não arranca | G10; falha visível no log do job, deploy aborta antes do restart |
| Chave de deploy vazada | Acesso à conta cPanel | Chave dedicada só para este repo, sem senha, rodrável; nunca em logs |
| Deploy corre em cron/PR | Publica sem querer | Condição `github.event_name == 'push' && github.ref == 'refs/heads/main'` (corrige `ci.yml:84`) |
| Sem rollback automático | Versão má fica no ar | CI como gate; documentar regressão manual; staging fica para depois |
| Build do frontend não faz typecheck (`vite build` sem `tsc`) | Tipo errado pode chegar a produção | Risco aceite e registado; adicionar job de frontend CI é melhoria separada **[call]** |

## 10. Ficheiros a criar/modificar

| Ficheiro | Acção |
|---|---|
| `docs/adr/0016-deploy-automatico-cpanel-github-actions.md` | **Criado** (Estado: proposto) |
| `docs/superpowers/specs/2026-11-05-deploy-automatico-cpanel-design.md` | **Este documento** |
| `.github/workflows/ci.yml:81-87` | Substituir o placeholder pelo job real de deploy |
| `.github/scripts/deploy.sh` | **Criar** — passos SSH/rsync, `set -e`, executável também à mão para recuperação **[call]** |
| `packages/backend/package.json` | Adicionar `"start"` (padrão `tsx --env-file-if-exists=.env …`, alinhado com `eval`) **[call, sujeito a G4]** |
| `packages/frontend/public/.htaccess` | **Criar** se G6/G7 confirmarem suporte a `RewriteRule [P]` **[call, sujeito a G5-G7]** |
| CPanel (não versionado) | Criar subdomínios, app Node, activar SSH, `.env` de produção |
| GitHub (não versionado) | Secret `SSH_PRIVATE_KEY` (+ host/utilizador) e `DATABASE_URL` se necessário |

## 11. Critérios de aceitação (com prova)

1. `push` para `main` com CI verde → job `deploy` **executa**; em PR e no cron **não**
   executa. Prova: registo das execuções no GitHub Actions.
2. `https://supcrm.milvendas.ao/` devolve 200 e serve a UI. Prova: `curl` + screenshot.
3. `https://supcrm.milvendas.ao/v1/health/live` devolve `{"status":"ok"}` — prova de que o
   proxy funciona **na mesma origem** (é este o requisito do frontend).
4. `https://api.supercrm.milvendas.ao/health/live` devolve `{"status":"ok"}`.
5. Socket.IO liga a partir do frontend publicado (5 eventos do painel). Prova: browser com
   a sessão aberta, sem erros de consola.
6. `npm run db:migrate` corre no servidor e é **idempotente** (segunda execução sem mudanças).
   Prova: output real do comando.
7. Nenhum segredo no repo: `gitleaks` verde + `grep` por `DATABASE_URL=` com valor real.
8. `.env` do servidor **sobrevive** a um deploy. Prova: `ls -l` antes/depois.
9. Lint, typecheck e testes do backend passam (saída colada no relatório).

## 12. O que fica por fazer (fora desta entrega)

- CI de frontend completo (lint/typecheck/test) — o `ci.yml` não tem job de frontend.
- Staging, rollback automático, notificação de deploy falhado.
- Plano B FTS se G8 confirmar sem `pgvector` (exige ADR próprio).
- Backups/teste de restauro da base antes de produção (`docs/03` §10).
