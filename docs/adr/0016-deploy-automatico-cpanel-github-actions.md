# ADR-0016 — Deploy automático no cPanel via GitHub Actions + SSH

- **Estado:** aceite (aprovado pelo dono a 2026-11-05)
- **Data:** 2026-11-05
- **Autor:** agente
- **Decide:** topologia de deploy (gate de `AGENTS.md`: "Decidir sozinho… topologia de deploy. Propõe num ADR e espera")

## Contexto

`docs/01` §4/A5 (`docs/adr/0001`) já fixou **cPanel partilhado sem Docker**, com duas apps
Node persistentes. Falta decidir **como** o código chega lá.

Estado verificado a 2026-11-05:

- `.github/workflows/ci.yml:81-87` tem um job `deploy` que é **placeholder**
  (`echo "Deploy não configurado (produção é cPanel, A5)"`).
- Só existe o workflow `CI`. Não há deploy keys no repositório (`gh api …/keys` → `[]`).
- Segredo único no GitHub: `AI_API_KEY`.
- Frontend usa **URLs relativos** (`/v1/...`, 113 ocorrências) e
  `io({ withCredentials: true })` sem URL (`packages/frontend/src/lib/socket.tsx:76-79`),
  com o comentário a dizer "mesma origem". Em produção isto **exige reverse proxy** no
  origin do frontend — não é opcional.
- Só as portas **80 e 443** estão abertas em `135.181.34.42`; 3000/3001/8080/8443 fechadas.
  O backend **não** pode ser exposto por porta crua.
- Já existem apps Passenger a funcionar: `api.milvendas.ao` e `elaleko.api.milvendas.ao`
  (`https://…` → 200, certos Let's Encrypt).

## Opções

1. **GitHub Actions → SSH no cPanel** (rsync + `npm ci` + `drizzle-kit migrate` + restart).
   - Vantagens: padrão estándar, dá para build + migrations + restart no mesmo sítio,
     segredos no GitHub, sem dependência da UI do cPanel.
   - Custos: exige SSH activo na conta; segredo privado de deploy a rodrar.
   - Riscos: chave comprometida = acesso à conta; migrations correm directo na base de produção.
2. **cPanel API token + UAPI** chamado a partir do Actions.
   - Vantagens: sem SSH.
   - Custos: precisaria de inventar/conhecer chamadas UAPI exactas (viola "não inventes");
     mais frágil entre versões do cPanel.
3. **Git Version Control do cPanel** com deploy automático.
   - Vantagens: integrado.
   - Custos: **não faz build nem migrations** — não satisfaz o pedido.
4. **Deploy manual** por FTP/terminal.
   - Fora do pedido (o dono pediu automático em `push`).

## Decisão

**Opção 1.**

- **Frontend** em `supcrm.milvendas.ao`: site estático (build feito no CI) + reverse
  proxy de `/v1` e `/socket.io` para o backend na mesma origem.
- **Backend** em `api.supercrm.milvendas.ao`: app Passenger, como as já existentes.
- **Migrations** (`npm run db:migrate`) correm no servidor **antes** do restart do backend.
- **Gate de CI:** o deploy substitui o placeholder em `ci.yml` e só corre em
  `push` para `main` — **não** em `pull_request`, `schedule` nem `workflow_dispatch`
  (o `if:` actual em `ci.yml:84` só testa `github.ref`, pelo que hoje correria também
  no cron diário).

## Consequências

- Passa a haver uma **chave de deploy dedicada e revogável** no GitHub; rodar = revogar.
- Deploy em produção **sem staging e sem rollback automático** — aceite para uso interno,
  mas um `push` defeituoso põe a versão má lá. Mitigação mínima: o deploy só corre se a
  CI passar, e o restart é o último passo.
- Migrations automáticas em base **de produção**: se uma falhar a meio, a base pode ficar
  parcialmente migrada com a app antiga ainda a correr. Ver riscos na spec.
- O backend passa a ter de arrancar por um comando de produção (`start`), hoje inexistente
  (`packages/backend/package.json` só tem `dev`).
- Desfazer: remover o job de deploy, apagar as chaves, desligar as apps — o código do repo
  não fica preso a nada.

## Emenda 2026-11-11 (implementação, medições no host)

A implementação executou a Opção 1 com quatro correções forçadas pelo servidor real —
todas medidas, não presumidas:

1. **Transporte: `tar` sobre ssh, não rsync** — Gate 0 (2026-11-07) provou que o
   servidor não tem `rsync`; `tar` + `--exclude='.env' --exclude='node_modules'` (§6 da
   spec).
2. **Migrations adiadas** (dono, 2026-11-07) — sem pgvector a migration `0000` falha;
   o `deploy.sh` publica só código e o guardião (`deploy.test.sh`) **proíbe** `db:migrate`
   no script. Desvio da decisão original acima; reacrescentar só com decisão nova.
3. **Node 22, não 24** — o servidor só tem Node 22 (`/opt/alt/alt-nodejs22`); `engines`
   desceu para `>=22` e a CI corre a suite em Node 22 (a prova está no job `test` do
   PR). O arranque é `packages/backend/start.mjs`: o campo *Application startup file* do
   cPanel é um **ficheiro** (`PassengerStartupFile` → `node <ficheiro>`), `npm start` não
   é aceite; o wrapper carrega `.env` se existir, regista o tsx e importa `main.ts`
   (testado: `/health/live` → 200).
4. **Instalação de produção: `npm ci --omit=dev` sobrevive à cage LVE; o completo não**
   — medido no host (2026-11-11): a cage CloudLinux mata processos por SIGKILL a
   **~950MB RSS** (probe: exit 137 a 953716KB). `npm ci` completo atinge esse limiar em
   ~5s (buffers de extração, memória externa ao heap — caps de `--max-old-space-size` não
   ajudam) e morre sempre; `npm ci --omit=dev` completou com exit 0 (`added 190 packages
   em 13m`, pico 872MB) com sync periódico de disco durante a instalação. Para isso
   **`tsx`** (arranque via `start.mjs`) e **`ioredis`** (import de runtime em
   `src/infra/main.ts:6`) passaram de `devDependencies` a `dependencies` — a instalação
   de produção tem de conter tudo o que o processo de arranque importa. O `ssh`
   não-interativo também não tem `node`/`npm` no PATH: o script exporta
   `/opt/alt/alt-nodejs22/root/usr/bin`.
