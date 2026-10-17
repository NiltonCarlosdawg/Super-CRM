# ADR 0007 — Multitenancy: isolamento por schema único com `tenant_id`

- Estado: proposto (a aguardar revisão humana — registado pela Task 12 da Onda 1)
- Data: 2026-10-17
- Autor: agente (Task 12, onda multitenancy)

## Contexto

O CRM era um produto interno da MilVendas — `docs/01-contexto-e-plano.md` (D1:
"Sem multi-tenant por agora"). O dono do produto mudou de decisão: a instalação
única passa a servir **vários clientes** (empresas), cada um isolado dos outros
(spec `docs/superpowers/specs/2026-10-16-multitenant-design.md`, requisitos
aprovados R1–R5). Isto reverte D1 e obriga a registar aqui o modelo de
isolamento escolhido.

Restrições confirmadas no momento da decisão:

- O motor já é PostgreSQL (`drizzle.config.ts`); a mudança é o **modelo de
  dados**, não o motor. O fork WA-AKG mantém MySQL e **não é alterado**
  (`docs/03` §5, `docs/04`; alteração ao fork = gate humano).
- Os dados existentes migram para o tenant **"MilVendas"**; nada se perde (R3).
- Auto-registo público cria tenant + admin do tenant (R2); um **platform
  admin** da equipa MilVendas gere o ciclo de vida dos tenants (R4).
- Escala actual: poucos tenants, equipa pequena, sem billing/cobrança de
  tenants (não-objectivos v1 da spec).

## Opções

1. **Base de dados por tenant** — isolamento forte (grant, backup, restauração e
   `pg_dump` por tenant; uma fuga de query é fisicamente impossível entre
   tenants). Custos: operações ×N (N bases, N conjuntos de migrações, N backups,
   pools de conexão por base), pgvector/embeddings replicados por base, e o
   custo de abrir uma base nova por tenant novo. Com a escala actual é
   operação desproporcional para ~poucos tenants.
2. **Schema (namespace) por tenant** — um só motor e uma só base; isolamento
   lógico intermédio via `search_path`. Custos: migrações a correr N vezes (uma
   por schema), ferramentas (Drizzle/migrator) sem suporte nativo a
   multi-schema, consultas cross-tenant de plataforma complexas, e o risco de
   `search_path` errado em pools de ligação partilhados. Complexidade alta sem
   ganho de isolamento real face à opção 3 a esta escala.
3. **Schema único com `tenant_id` (linhas etiquetadas)** — todas as tabelas de
   negócio ganham `tenant_id` (NOT NULL por omissão); o escopo é uma coluna, as
   migrações correm uma vez, as ferramentas Drizzle são nativas, e a plataforma
   lê qualquer tenant com um parâmetro. Risco central: **uma query esquecida =
   fuga de dados** — mitigado por choke point (todos os repositórios exigem um
   `scope` explícito `{ tenantId }`, sem ele o código não compila/não corre),
   guards `requireTenant`/`requirePlatform` em todas as rotas e uma **suite de
   isolamento obrigatória** (tenants A/B espelhados; rota a rota, IDs alheios →
   404).

## Decisão

**Opção 3 — schema único com `tenant_id`** (R5 da spec, aprovada pelo dono do
produto). Regras concretas implementadas na Onda 1:

- `tenants` (id, name, status) + tenant **"MilVendas"** criado pela migração e
  alvo de FK de todos os dados existentes (backfill).
- `tenant_id NOT NULL` em 23 tabelas de negócio; excepções justificadas na spec
  §4.2: `audit_log` e `inbound_events` anuláveis (ação de plataforma/sistema e
  evento gravado antes de resolver a conta); `sessions` e `business_lines` sem
  coluna (infra de auth e dicionário global de slugs).
- `users` ganha o enum `platform_admin` com CHECK `role = 'platform_admin' ⇔
  tenant_id IS NULL`; unicidade de email mantém-se global (v1: uma pessoa, uma
  conta). O problema das migrações de enum (ADD VALUE + uso na mesma transacção)
  está registado em `docs/adr/0008-migracoes-enum-split-transacao.md`.
- O `tenant_id` **nunca vem do corpo do pedido**; deriva do registo pai já
  escopado, na mesma transacção.
- Rotas de plataforma em `/v1/platform/*` com `requirePlatform`; rotas de tenant
  nunca aceitam `tenantId` no path; qualquer leitura/escrita cross-tenant
  responde **404** (nunca 403) para não revelar existência de IDs alheios.
- Registo público (`POST /v1/auth/register`) cria tenant + admin do tenant
  transaccionalmente; o primeiro platform admin cria-se por CLI
  (`scripts/create-user.ts --role platform_admin`).

## Consequências

- **Uma só migração por mudança de schema** e uma só base de dados — operação
  simples à escala actual.
- **Choke point obrigatório para sempre:** qualquer repositório novo com acesso
  a tabelas de negócio tem de exigir `scope` explícito; a suite de isolamento é
  rede de aceitação permanente. Esquecer o escopo é o modo de falha nº 1.
- **Escalas futuras:** se um dia forem necessários milhares de tenants, isolamento
  regulatório por cliente ou billing com separação financeira rígida, o caminho
  é migrar para BD/schema por tenant (cópia por tenant a partir do schema único;
  o `tenant_id` actual facilita o split). Essa migração é cara e fica para
  quando houver esse requisito real.
- **Desfazer:** reverter a onda inteira (remover `tenant_id`, fundir tenants) é
  tecnicamente possível mas sem caso de uso — não se prevê.
- Uma pessoa não pode pertencer a dois tenants (email globalmente único,
  consciente em v1); impersonation de platform admin dentro de um tenant é
  trabalho futuro (v1 = leitura auditada, escrita = 403).
