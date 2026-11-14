# Deploy automático no cPanel (GitHub Actions → SSH) — Implementation Plan

> **Emenda 2026-11-07 (dono):** (a) migrations automáticas **ADIADAS** — sem pgvector no servidor a migration `0000` falha; deploy publica só código, `db:migrate` sai do `deploy.sh` e o guardião proíbe-o; (b) o servidor **não tem rsync** — transporte é `tar` sobre ssh; (c) `engines` desce para `>=22` após prova da suite sob Node 22. Evidência do Gate 0 na spec §7.1.

> **Emenda 2026-11-11 (implementação):** (d) o campo *Application startup file* do cPanel é um **ficheiro** (`node <ficheiro>`, `PassengerStartupFile`) — `npm start` não é aceite; o arranque é `packages/backend/start.mjs` (carrega `.env` se existir, registra o tsx e importa `main.ts`), testado localmente (`/health/live` → 200); (e) o `ssh` não-interativo não tem `node`/`npm` no PATH — `deploy.sh` exporta `/opt/alt/alt-nodejs22/root/usr/bin`; (f) proxy WebSocket exige alvo `ws://` (com `http://` o LiteSpeed trava) e o fallback SPA é `RewriteRule` (`FallbackResource` devolve 404) — ver spec §7.1; (g) a cage LVE mata processos a **~950MB RSS** (medido: probe exit 137 a 953716KB) e o `npm ci` completo morre a ~5s — a receita de produção é `npm ci --omit=dev --no-audit --no-fund --prefer-offline` com `sync` periódico, `NODE_OPTIONS=--max-old-space-size=400` e `ONNXRUNTIME_NODE_INSTALL=skip` (pico medido 872MB, exit 0, 13min); `tsx` e `ioredis` passaram a `dependencies` porque o arranque os importa — ADR-0016 §Emenda.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** um `push` para `main` publica o frontend em `supcrm.milvendas.ao`, o backend em `api.supercrm.milvendas.ao` e corre `npm run db:migrate` no servidor antes de reiniciar a app.

**Architecture:** GitHub Actions (job `deploy` em `ci.yml`) constrói o frontend no runner, autentica por SSH com chave dedicada e corre `.github/scripts/deploy.sh`: rsync do `dist/` para o docroot do frontend, rsync do backend para a raiz da app Node, e um único `ssh` com `set -e` que faz `npm ci` → `db:migrate` → restart. O frontend é servido estático pelo Apache com `.htaccess` que faz reverse proxy de `/v1` e `/socket.io` para o backend em `127.0.0.1` (obrigatório: o frontend usa URLs relativos e Socket.IO same-origin).

**Tech Stack:** GitHub Actions (`actions/checkout@v4`, `actions/setup-node@v4`), `ssh-agent`/`ssh`/`rsync` nativos do runner, Bash, Apache `mod_rewrite` (`[P]`), Passenger, Drizzle Kit.

**Spec:** `docs/superpowers/specs/2026-11-05-deploy-automatico-cpanel-design.md` · **ADR:** `docs/adr/0016-deploy-automatico-cpanel-github-actions.md` (aceite 2026-11-05).

## Global Constraints

- Deploy **só** em `github.event_name == 'push' && github.ref == 'refs/heads/main'` — nunca em `pull_request`, `schedule` (cron `17 3 * * *`) nem `workflow_dispatch`.
- **Nenhum segredo no repo nem em logs.** rsync leva sempre `--exclude='.env'` e `--exclude='node_modules/'`.
- Ações de terceiros proibidas além de `actions/checkout@v4` e `actions/setup-node@v4` (usa `ssh-agent`/`ssh-keyscan`/`rsync` nativos).
- Ordem no servidor é fixa: `npm ci` → `npm run db:migrate` → restart, tudo num único `ssh` com `set -euo pipefail`.
- Node `>=24` (runner e servidor — `package.json` engines).
- **Zero alterações** a módulos de negócio (WA-AKG, schema, orquestrador) e **zero alterações** ao código do frontend (nada de `VITE_API_BASE_URL`).
- Host, utilizador, caminhos e comando de restart vêm de **repo variables** (`vars.*`), preenchidas após o Gate 0 — nunca hardcoded no repo.
- Sem staging, sem rollback automático (aceite pelo dono).
- Commits pequenos e convencionais (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).

## Review Focus

Os cinco pontos que a spec implica mas que nenhum teste de unidade cobre — cada um com o passo que o prende:

1. **Deploy disparar no cron diário ou em PR** (a condição antiga em `ci.yml:84` só testava `github.ref`) → Task 4, passo que falha se o `if:` exato não estiver no ficheiro.
2. **`.env` do servidor apagado pelo rsync** (segredos perdidos, app não arranca) → Task 3, teste que falha se faltar `--exclude='.env'`.
3. **Migrations a correr depois do restart** (app nova contra base velha) → Task 3, teste que verifica a ordem `db:migrate` antes do restart no script.
4. **Reverse proxy morto** — frontend 200 mas `/v1` 404 em silêncio → Task 5 (`.htaccess`) e Task 7 (curl `https://supcrm.milvendas.ao/v1/health/live` após deploy).
5. **`pgvector` indisponível** — migration `0000_vector_extension.sql` falha e para toda a cadeia → Task 1 (G8), que é bloqueador do primeiro push.

---

### Task 1: Gate 0 — verificar capacidades do servidor (bloqueador)

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-deploy-automatico-cpanel-design.md` (secção 7, tabela G1–G10)

**Interfaces:**
- Produz os valores exatos que as Tasks 3–7 consumem: `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_FRONTEND_DOCROOT`, `DEPLOY_BACKEND_ROOT`, `DEPLOY_RESTART_CMD`, porta estável do backend, e os estados de G8/G9.

Sem SSH e sem o cPanel aberto, nada disto é verificável. O dono ativou o SSH (decisão 2026-11-05) e vai iniciar sessão no cPanel.

- [ ] **Step 1:** Confirmar G1 — SSH ativo (cPanel → Segurança → Acesso SSH) e ligar `ssh -o BatchMode=yes $USER@$HOST 'node -v'` com a chave gerada na Task 6.
- [ ] **Step 2:** Correr no servidor os comandos da tabela G2–G10 da spec e colar a evidência real em cada linha da tabela. Valores críticos:
  - G2: `node -v` tem de ser `>=24`.
  - G8: `psql "$DATABASE_URL" -c "SELECT name FROM pg_available_extensions WHERE name='vector'"` — se vazio, **PARAR** e informar o dono (Plano B FTS exige ADR próprio, fora do âmbito).
  - G9: `psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations"` (ou tabela equivalente) — dizer se a base de produção já tem migrations aplicadas.
  - G4: como o Passenger arranca `api.milvendas.ao` (Application Manager: startup file, env vars) → daí sai `DEPLOY_RESTART_CMD` (ex.: `touch <root>/tmp/restart.txt` — **não inventar**: confirmar no servidor).
  - G5: porta local estável (`ss -ltn`) → valor de `PORT` no `.env` de produção.
  - G6/G7: `httpd -M | grep -E 'proxy|rewrite'` e se `AllowOverride` no docroot permite `RewriteRule [P]`.
  - G10: `npm ci` manual na app existente compila `argon2` e `@napi-rs/canvas`.
- [ ] **Step 3:** Preencher a tabela G1–G10 da spec com `Confirmado | Refutado` + evidência e commitar.

```bash
git add docs/superpowers/specs/2026-11-05-deploy-automatico-cpanel-design.md
git commit -m "docs: gate 0 evidence for cpanel deploy"
```

**SAIDA OBRIGATÓRIA antes das Tasks 5–7:** valores de `DEPLOY_*`, G6/G7 (`mod_rewrite`/`[P]`), G8 e G9. G8 Refutado bloqueia o primeiro push.

---

### Task 2: Script `start` de produção do backend

**Files:**
- Modify: `packages/backend/package.json:8-19` (bloco `scripts`)

**Interfaces:**
- Produz: script npm `start` — o Passenger/`DEPLOY_RESTART_CMD` da Task 1 vai executá-lo.

`tsx` é `devDependency` e o `npm ci` do servidor instala dev deps, por isso `tsx` está lá. Padrão já existente no repo: `tsx --env-file-if-exists=.env` (scripts `eval`, `package.json:17-18`).

- [ ] **Step 1:** Adicionar ao bloco `scripts` de `packages/backend/package.json`:

```json
"start": "tsx --env-file-if-exists=.env src/infra/main.ts"
```

- [ ] **Step 2:** Verificar que arranca (com o `.env` de desenvolvimento local):

```bash
cd packages/backend && timeout 10 npm run start
```

Esperado: processo sobe e log de arranque do Fastify (mata ao fim de 10 s); falha só de ligação a DB/Redis locais é aceitável se o processo chegar a `app.listen`.

- [ ] **Step 3:** `npm run typecheck` no backend continua verde (nenhuma mudança de código).

- [ ] **Step 4:** Commitar.

```bash
git add packages/backend/package.json
git commit -m "feat(backend): add production start script"
```

---

### Task 3: `.github/scripts/deploy.sh` + teste guardião

**Files:**
- Create: `.github/scripts/deploy.sh`
- Test: `.github/scripts/deploy.test.sh`

**Interfaces:**
- Consome (env, definidas no workflow a partir de `vars.*`): `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_FRONTEND_DOCROOT`, `DEPLOY_BACKEND_ROOT`, `DEPLOY_RESTART_CMD`.
- Produz: script executável, corrido pela Task 4 como `bash .github/scripts/deploy.sh`, também utilizável à mão para recuperação.

Comportamento exato de `deploy.sh` (Bash, `set -euo pipefail`, falha se alguma `DEPLOY_*` em falta):

1. Validar que as 5 variáveis `DEPLOY_*` estão definidas (senão exit 1 com mensagem clara).
2. `rsync -az packages/frontend/dist/ "$USER@$HOST:$DOCROOT/" --exclude='.env'`
3. `rsync -az packages/backend/ "$USER@$HOST:$BACKEND_ROOT/" --exclude='.env' --exclude='node_modules/' --exclude='reports/'`
4. Um único `ssh "$USER@$HOST"` com heredoc e `set -euo pipefail`: `cd $BACKEND_ROOT && npm ci && npm run db:migrate && eval "$DEPLOY_RESTART_CMD"`.

- [ ] **Step 1: Escrever o teste guardião primeiro** — `.github/scripts/deploy.test.sh`, `bash` puro com `grep -q` e saída `deploy-guard: OK`. Nesta Task cobre **só** `deploy.sh`; os guardiões do workflow entram na Task 4:

```bash
#!/usr/bin/env bash
# Guardiões do deploy: invariantes da spec §6/§9 que um refactor pode partir.
set -euo pipefail
cd "$(dirname "$0")/../.."

s=.github/scripts/deploy.sh

grep -q 'set -euo pipefail' $s
grep -qF -- "--exclude='.env'" $s                 # risco: .env do servidor apagado
grep -qF -- "--exclude='node_modules/'" $s
# ordem: migrate ANTES do restart, no mesmo ssh
m=$(grep -n 'db:migrate' $s | head -1 | cut -d: -f1)
r=$(grep -n 'DEPLOY_RESTART_CMD' $s | head -1 | cut -d: -f1)
test -n "$m" && test -n "$r" && test "$m" -lt "$r"

echo "deploy-guard: OK"
```

- [ ] **Step 2:** Correr e ver falhar (o script ainda não existe):

```bash
bash .github/scripts/deploy.test.sh
```

Esperado: FAIL (grep não encontra `deploy.sh`).

- [ ] **Step 3: Escrever `.github/scripts/deploy.sh`** com o comportamento acima (`chmod +x`). Shortcut documentado no script: sem `--delete` no rsync do frontend — ficheiros removidos do build ficam órfãos no docroot (inócuos); a acrescentar `--delete` quando o docroot for só nosso confirmado (G3).

- [ ] **Step 4:** `bash -n .github/scripts/deploy.sh` (sintaxe) e correr o teste:

```bash
bash -n .github/scripts/deploy.sh && bash .github/scripts/deploy.test.sh
```

Esperado: `deploy-guard: OK`.

- [ ] **Step 5:** Commitar.

```bash
git add .github/scripts/deploy.sh .github/scripts/deploy.test.sh
git commit -m "ci: add cpanel deploy script with guard tests"
```

---

### Task 4: Job `deploy` real no `ci.yml`

**Files:**
- Modify: `.github/workflows/ci.yml:81-87` (substituir o placeholder)

**Interfaces:**
- Consome: `deploy.sh` da Task 3; `vars.DEPLOY_SSH_HOST`, `vars.DEPLOY_SSH_USER`, `vars.DEPLOY_FRONTEND_DOCROOT`, `vars.DEPLOY_BACKEND_ROOT`, `vars.DEPLOY_RESTART_CMD` (Task 1/6); secret `SSH_PRIVATE_KEY` (Task 6).

- [ ] **Step 1:** Acrescentar ao fim de `.github/scripts/deploy.test.sh` (antes do `echo`) os guardiões do workflow, e correr para ver falhar — o placeholder ainda lá está:

```bash
w=.github/workflows/ci.yml
grep -qF "if: github.event_name == 'push' && github.ref == 'refs/heads/main'" $w
! grep -q 'Deploy não configurado' $w            # placeholder removido
```

```bash
bash .github/scripts/deploy.test.sh
```

Esperado: FAIL (condição exata ausente).

- [ ] **Step 2:** Substituir as linhas 81-87 de `ci.yml` por:

```yaml
  deploy:
    needs: [backend, secret-scan]
    runs-on: ubuntu-latest
    # Só push para main: nunca PR, nem o cron diário (schedule), nem dispatch manual.
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    env:
      DEPLOY_SSH_HOST: ${{ vars.DEPLOY_SSH_HOST }}
      DEPLOY_SSH_USER: ${{ vars.DEPLOY_SSH_USER }}
      DEPLOY_FRONTEND_DOCROOT: ${{ vars.DEPLOY_FRONTEND_DOCROOT }}
      DEPLOY_BACKEND_ROOT: ${{ vars.DEPLOY_BACKEND_ROOT }}
      DEPLOY_RESTART_CMD: ${{ vars.DEPLOY_RESTART_CMD }}
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
          cache-dependency-path: packages/frontend/package-lock.json
      - name: Build frontend
        working-directory: packages/frontend
        run: |
          npm ci
          npm run build
      - name: Setup SSH
        run: |
          mkdir -p ~/.ssh
          ssh-keyscan "$DEPLOY_SSH_HOST" >> ~/.ssh/known_hosts
          eval "$(ssh-agent -s)"
          echo "$SSH_PRIVATE_KEY" | ssh-add -
        env:
          SSH_PRIVATE_KEY: ${{ secrets.SSH_PRIVATE_KEY }}
      - name: Deploy to cPanel
        run: bash .github/scripts/deploy.sh
      - name: Verify
        run: |
          curl -fsS --retry 10 --retry-delay 5 --retry-connrefused "https://supcrm.milvendas.ao/" > /dev/null
          curl -fsS --retry 10 --retry-delay 5 "https://supcrm.milvendas.ao/v1/health/live" | grep -q '"status":"ok"'
          curl -fsS --retry 10 --retry-delay 5 "https://api.supercrm.milvendas.ao/health/live" | grep -q '"status":"ok"'
```

Nota: o `working-directory` por omissão do job `backend` é `packages/backend`; o job `deploy` **não** herda esse default (não declarar `defaults`).

- [ ] **Step 3:** Validar o YAML e o teste guardião:

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" && bash .github/scripts/deploy.test.sh
```

Esperado: sem erro de YAML + `deploy-guard: OK`.

- [ ] **Step 4:** Commitar.

```bash
git add .github/workflows/ci.yml
git commit -m "ci: enable automatic cpanel deploy on push to main"
```

---

### Task 5: `.htaccess` do frontend (reverse proxy) — condicional a G6/G7

**Files:**
- Create: `packages/frontend/public/.htaccess` (o Vite copia `public/` para `dist/`)

**Interfaces:**
- Consome: G5 (porta estável do backend) e G6/G7 (suporte a `RewriteRule [P]`) da Task 1.

Só executar se G6/G7 forem `Confirmado`. Se `Refutado`, parar e propor alternativa ao dono (não inventar mecanismo).

- [ ] **Step 1:** Criar `packages/frontend/public/.htaccess` (a porta `$PORT` é a do G5):

```apache
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteCond %{HTTP:Upgrade} =websocket [NC]
  RewriteRule ^/(v1|socket\.io)(.*)$ http://127.0.0.1:$PORT/$1$2 [P,L]
  RewriteRule ^/(v1|socket\.io)(.*)$ http://127.0.0.1:$PORT/$1$2 [P,L]
</IfModule>
```

(Substituir `$PORT` pelo valor real do G5; a primeira regra cobre o upgrade websocket do Socket.IO, a segunda o resto.)

- [ ] **Step 2:** Teste local do build copiar o ficheiro:

```bash
cd packages/frontend && npm run build && test -f dist/.htaccess && echo OK
```

Esperado: `OK`.

- [ ] **Step 3:** Commitar.

```bash
git add packages/frontend/public/.htaccess
git commit -m "feat(frontend): apache reverse proxy for /v1 and socket.io"
```

---

### Task 6: Infraestrutura manual (cPanel + GitHub) — com o dono

**Files:** nenhum no repo (tudo fora do versionado).

**Interfaces:**
- Produz: `vars.*` e `secret.SSH_PRIVATE_KEY` consumidos pela Task 4.

- [ ] **Step 1 (dono, cPanel):** criar os subdomínios `supcrm` e `api.supercrm` (Domínios), registar os docroots exatos (G3).
- [ ] **Step 2 (dono, cPanel):** *Setup Node.js App* para `api.supercrm.milvendas.ao` com a app Node (`DEPLOY_BACKEND_ROOT`), Node **22.23.4**, modo Production, *Application startup file* **`start.mjs`** (emenda 2026-11-11(d): o campo é um ficheiro, `node <ficheiro>` — `npm start` não é aceite), `PORT=3002` (G5).
- [ ] **Step 3 (dono, cPanel):** criar o `.env` de produção na raiz da app (perm 600) com todos os campos de `packages/backend/.env.example` — valores por canal próprio, **nunca** no repo/log.
- [ ] **Step 4:** Gerar chave dedicada só para este repo (sem passphrase) e entregar a pública ao cPanel (*Acesso SSH*), o privado ao GitHub:

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/supercrm_deploy -C "super-crm-deploy"
gh secret set SSH_PRIVATE_KEY -R NiltonCarlosdawg/Super-CRM < ~/.ssh/supercrm_deploy
```

- [ ] **Step 5:** Definir as repo variables (valores reais do Gate 0):

```bash
gh variable set DEPLOY_SSH_HOST -R NiltonCarlosdawg/Super-CRM --body "135.181.34.42"
gh variable set DEPLOY_SSH_USER -R NiltonCarlosdawg/Super-CRM --body "milvendas"
gh variable set DEPLOY_FRONTEND_DOCROOT -R NiltonCarlosdawg/Super-CRM --body "<G3>"
gh variable set DEPLOY_BACKEND_ROOT -R NiltonCarlosdawg/Super-CRM --body "<G4>"
gh variable set DEPLOY_RESTART_CMD -R NiltonCarlosdawg/Super-CRM --body "<G4>"
```

- [ ] **Step 6:** Provar a chave: `ssh -i ~/.ssh/supercrm_deploy $USER@$HOST 'echo ok'` → `ok`.

---

### Task 7: Primeiro deploy e critérios de aceitação (spec §11)

**Files:** nenhum (verificação em produção).

- [ ] **Step 1:** Pré-condições: Task 1 com G8 `Confirmado` e G9 registado; Tasks 2–6 todas commitadas; CI verde no PR da mudança.
- [ ] **Step 2:** Merge para `main` e observar o job `deploy` no GitHub Actions. Prova: URL da execução.
- [ ] **Step 3:** Correr os critérios da spec §11 e colar o output:

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' https://supcrm.milvendas.ao/                       # 200
curl -fsS https://supcrm.milvendas.ao/v1/health/live                                          # {"status":"ok"}
curl -fsS https://api.supercrm.milvendas.ao/health/live                                       # {"status":"ok"}
ssh -i ~/.ssh/supercrm_deploy $USER@$HOST 'ls -l $BACKEND_ROOT/.env'                         # sobrevive ao deploy
# db:migrate NÃO corre aqui (emenda 2026-11-07: migrations adiadas — sem pgvector)
```

- [ ] **Step 4:** Verificação no navegador (hook global): `bash ~/.config/opencode/skills/agent-browser-verify/scripts/verify.sh https://supcrm.milvendas.ao/` — login, consola sem erros, Socket.IO ligado (5 eventos), screenshot.
- [ ] **Step 5:** Prova de que **não** dispara fora do push: registo das execuções — o cron seguinte e um PR não podem mostrar execuções do job `deploy`.
- [ ] **Step 6:** Relatório final (o que mudou, evidência, restantes, riscos) + atualizar o estado da spec para implementado.

---

## Fora do âmbito (não fazer)

- CI de frontend completo (lint/typecheck/test) — melhoria separada.
- Staging, rollback automático, notificação de falha de deploy.
- Plano B FTS se G8 refutar pgvector (exige ADR próprio).
- Qualquer alteração a `reference/`, WA-AKG, schema ou orquestrador.
