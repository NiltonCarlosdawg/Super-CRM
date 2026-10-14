# Fase 4 — Campanhas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar campanhas de WhatsApp com segmentação por consentimento, ritmo limitado por conta, pausa automática e opt-out imediato, expostas por API REST com RBAC `admin`.
**Architecture:** Módulo próprio de campanhas: regras puras em `domain` (ritmo, template, opt-out, pausa), casos de uso em `application`, e ports para os contratos das Fases 1–3 (contactos, contas, outbox, audit, realtime). Todo o envio sai pela outbox + fila da Fase 1, com um *tick* por (campanha, conta) que aplica limites, janela silenciosa e prioridade das conversas; guardas de pausa correm no mesmo *tick* e a retoma é exclusivamente humana (API).
**Tech Stack:** Node LTS + Fastify, PostgreSQL + Drizzle, Redis + BullMQ, zod, testes com Postgres e Redis reais (contentores).
**Spec:** docs/01-contexto-e-plano.md §8 (Fase 4) + docs/06-decisoes-fechadas-a1-a11.md

## Global Constraints

- TypeScript `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`; sem `any` sem comentário `// any: motivo` na própria linha.
- IDs `uuid` (`randomUUID()` na aplicação); datas `timestamptz` sempre UTC; dinheiro `numeric` (string em TS); telefones E.164 pela função única da Fase 1 (campanhas nunca formatam telefones).
- Sem segredos em código, logs ou fixtures; só dados sintéticos — as 20 conversas reais são proibidas (`docs/03` §7).
- Testes sem internet e sem hora real: relógio (`now()`) e `rng()` injetados; integração com Postgres e Redis reais (contentores da Fase 0).
- WhatsApp só sai pela outbox + fila da Fase 1 (`MessagingProvider`); nenhum handler HTTP nem job chama `send` diretamente (`docs/04` §7).
- Limites impostos no código do CRM (`docs/04` §7): `WA_CAMPAIGN_DELAY_MS` default `15000-45000`; `WA_CAMPAIGN_RAMP` default `1-3:30,4-7:60,8-14:100,default:150`; `WA_QUIET_HOURS` default `20:00-08:00`, fuso `Africa/Luanda`; sem rotação de números nem contornar limites.
- Segmentação: só contactos com `marketing_consent = true` E `opted_out_at IS NULL`; qualquer conta com `purpose = 'support'` é recusada em campanhas (`docs/03` §8, teste obrigatório).
- Toda a entrada validada na fronteira com zod (HTTP, env, jobs); erros RFC 9457 `application/problem+json` mapeados num único ponto (Fase 1).
- Idempotência: jobs (`jobId` determinístico), envios (`outbox_messages.idempotency_key`), destinatários (unicidade `(campaign_id, contact_id, step)`), API (`Idempotency-Key` obrigatório em `POST /v1/campaigns` e `POST /v1/campaigns/:id/start`).
- RBAC: todas as rotas de campanhas exigem papel `admin`; criar/iniciar/pausar/retomar escrevem no `audit_log` (`docs/03` §3).
- Config por env validada no arranque: valor inválido → processo não arranca (`docs/02` §4). Limites e limiares são config, nunca constantes soltas.
- Sem follow-ups: nada de `followup_sequences|followup_steps|followup_runs` nem passos múltiplos; `campaign_recipients.step = 1` (Fase 5).
- Sem dependências novas (zod, Drizzle, BullMQ já em uso) — nenhum ADR novo.
- Caminhos e contratos das Fases 0–3 (`src/infra/config.ts`, app Fastify, pipeline de entrada, port de outbox/audit/realtime, helpers de testes com contentores) seguem `docs/02` §1; ao executar, confirmar o nome real no repositório e adaptar **só** o caminho/import, nunca o comportamento. Os nomes usados neste plano são os previstos.
- Runner e comandos: `npm run lint`, `npm run typecheck`, `npm test -- <ficheiro>`, `npm run db:generate`, `npm run db:migrate` (secção "Comandos" do `AGENTS.md`, preenchida na Fase 0); testes com `node:test` (`describe`/`it`) + asserções `node:assert/strict`, como nos planos das outras fases.

## Review Focus

- Fuso e relógio do anfitrião: `WA_QUIET_HOURS` e o ramp calculados com o TZ do processo guardariam janelas erradas → teste com instantes fixos e `Intl` com tz explícita (`2026-10-07T19:30:00Z` é janela; `2026-10-07T07:00:00Z` é limite de saída) — Task 3, `tests/unit/campaigns/rhythm.test.ts`.
- Consentimento retirado ou opt-out entre a materialização e o envio → teste: contacto com `opted_out_at` preenchido depois de materializado nunca sai na outbox e o seu destinatário fica `opted_out` — Task 9 (`tests/unit/campaigns/tick.test.ts`) com o efeito real criado na Task 7.
- Conta que deixa de ser `campaigns` ou fica `disconnected` depois de a campanha começar → teste: o *tick* não enfileira (`account_unavailable`) e a campanha pausa com `session_down` — Tasks 9 e 10.
- Janela de falhas congelada durante a pausa: sem reset, a retoma humana re-pausaria sempre e a campanha nunca mais arrancaria → teste: retoma reinicia a janela (`since = resumedAt`) e as falhas antigas não voltam a pausar — Task 10, `tests/integration/campaigns/auto-pause.test.ts`.
- PII nos logs do job de campanha (`docs/02` §10: máscara de telefones) → teste: nenhuma linha de log do *tick* contém E.164 completo, só uuids — Task 9, `tests/unit/campaigns/tick.test.ts`.

---

### Task 1: Config de campanhas

**Files:**
- Create: `src/modules/campaigns/config.ts`
- Modify: `src/infra/config.ts` (adicionar `campaigns: loadCampaignConfig(process.env)` ao config carregado uma vez no arranque)
- Test: `tests/unit/campaigns/config.test.ts`

**Interfaces:**
- Consumes: módulo `config` da Fase 0 (leitura única de env no arranque, `docs/02` §4).
- Produces:
```ts
export interface CampaignConfig {
  delay: { minMs: number; maxMs: number };
  ramp: { bands: readonly { fromDay: number; toDay: number; cap: number }[]; defaultCap: number };
  quietHours: { startMinute: number; endMinute: number }; // minutos desde meia-noite local
  timezone: 'Africa/Luanda';
  optOutKeywords: readonly string[];   // já normalizados: minúsculas, sem acentos, sem duplicados
  optOutFooter: string;
  pause: { failWindow: number; failRatio: number; optOutWindow: number; optOutCount: number };
}
export class CampaignConfigError extends Error {}
export function loadCampaignConfig(env: Readonly<Record<string, string | undefined>>): CampaignConfig;
```
- Chaves env (com defaults exatos): `WA_CAMPAIGN_DELAY_MS=15000-45000`, `WA_CAMPAIGN_RAMP=1-3:30,4-7:60,8-14:100,default:150`, `WA_QUIET_HOURS=20:00-08:00`, `CAMPAIGN_OPTOUT_KEYWORDS=sair`, `CAMPAIGN_OPT_OUT_FOOTER='Responde SAIR para sair desta lista.'`, `CAMPAIGN_FAIL_WINDOW=20`, `CAMPAIGN_FAIL_RATIO=0.30`, `CAMPAIGN_OPTOUT_WINDOW=50`, `CAMPAIGN_OPTOUT_COUNT=5`. Erros de validação mencionam o nome da chave.

- [ ] **Step 1: Escrever o teste falhado**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadCampaignConfig } from '../../../src/modules/campaigns/config';

describe('campaign config', () => {
  it('carrega os defaults de docs/04 §7', () => {
    const cfg = loadCampaignConfig({});
    assert.deepEqual(cfg.delay, { minMs: 15000, maxMs: 45000 });
    assert.deepEqual(cfg.ramp, {
      bands: [
        { fromDay: 1, toDay: 3, cap: 30 },
        { fromDay: 4, toDay: 7, cap: 60 },
        { fromDay: 8, toDay: 14, cap: 100 },
      ],
      defaultCap: 150,
    });
    assert.deepEqual(cfg.quietHours, { startMinute: 1200, endMinute: 480 });
    assert.equal(cfg.timezone, 'Africa/Luanda');
    assert.deepEqual(cfg.optOutKeywords, ['sair']);
    assert.equal(cfg.optOutFooter, 'Responde SAIR para sair desta lista.');
    assert.deepEqual(cfg.pause, { failWindow: 20, failRatio: 0.3, optOutWindow: 50, optOutCount: 5 });
  });

  it('rejeita configuração inválida pelo nome da chave', () => {
    assert.throws(() => loadCampaignConfig({ WA_CAMPAIGN_DELAY_MS: '45000-15000' }), /WA_CAMPAIGN_DELAY_MS/);
    assert.throws(() => loadCampaignConfig({ WA_CAMPAIGN_DELAY_MS: 'abc' }), /WA_CAMPAIGN_DELAY_MS/);
    assert.throws(() => loadCampaignConfig({ WA_CAMPAIGN_RAMP: '1-3:30' }), /default/);
    assert.throws(() => loadCampaignConfig({ WA_CAMPAIGN_RAMP: '1-7:30,4-9:60,default:150' }), /WA_CAMPAIGN_RAMP/);
    assert.throws(() => loadCampaignConfig({ WA_QUIET_HOURS: '20:00-20:00' }), /WA_QUIET_HOURS/);
    assert.throws(() => loadCampaignConfig({ WA_QUIET_HOURS: '25:00-08:00' }), /WA_QUIET_HOURS/);
    assert.throws(() => loadCampaignConfig({ CAMPAIGN_FAIL_RATIO: '30' }), /CAMPAIGN_FAIL_RATIO/);
    assert.throws(() => loadCampaignConfig({ CAMPAIGN_FAIL_WINDOW: '0' }), /CAMPAIGN_FAIL_WINDOW/);
    assert.throws(() => loadCampaignConfig({ CAMPAIGN_OPTOUT_KEYWORDS: ' , ' }), /CAMPAIGN_OPTOUT_KEYWORDS/);
    assert.throws(
      () => loadCampaignConfig({ CAMPAIGN_OPT_OUT_FOOTER: 'Obrigado pela preferência.' }),
      /CAMPAIGN_OPT_OUT_FOOTER/,
    );
  });

  it('normaliza as palavras-chave de opt-out (minúsculas, sem acentos, sem duplicados)', () => {
    assert.deepEqual(
      loadCampaignConfig({ CAMPAIGN_OPTOUT_KEYWORDS: 'SAIR, Saír , unsubscribe' }).optOutKeywords,
      ['sair', 'unsubscribe'],
    );
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/campaigns/config.test.ts`
Expected: FAIL — `Cannot find module '../../../src/modules/campaigns/config'`

- [ ] **Step 3: Implementar `loadCampaignConfig(env)` em `src/modules/campaigns/config.ts`**

Esquema zod por chave env com parse: delay `min-max` (inteiros, min ≤ max), ramp por bands `from-to:cap` separadas por vírgula mais entrada `default:cap` obrigatória (bands ordenadas, sem sobreposição), quiet hours `HH:MM-HH:MM` (0–1439, início ≠ fim) convertidas para minutos, keywords separadas por vírgula normalizadas com o mesmo `normalize` de `reference/keyword-safety-net.ts` (NFD sem diacríticos + lowercase) e deduplicadas, rodapé tem de conter pelo menos uma keyword normalizada, limiares (`failWindow ≥ 1`, `0 < failRatio ≤ 1`, `optOutWindow ≥ 1`, `optOutCount ≥ 1`). Lançar `CampaignConfigError` com o nome da chave na mensagem. `src/infra/config.ts` chama `loadCampaignConfig(process.env)` no arranque (Fase 0).

- [ ] **Step 4: Correr e ver passar**

Run: `npm run typecheck && npm test -- tests/unit/campaigns/config.test.ts`
Expected: PASS — 3 testes, 0 falhas

- [ ] **Step 5: Commit**

```bash
git add src/modules/campaigns/config.ts src/infra/config.ts tests/unit/campaigns/config.test.ts
git commit -m "feat: add campaign configuration with pacing and opt-out env keys"
```

---

### Task 2: Entidades `campaigns` e `campaign_recipients`

**Files:**
- Create: `src/domain/campaigns/types.ts`
- Create: `src/modules/campaigns/schema.ts`
- Create: migração gerada por `npm run db:generate` (caminho devolvido pelo comando, revista antes de aplicar)
- Test: `tests/integration/campaigns/schema.test.ts`

**Interfaces:**
- Consumes: harness de migração/DB com contentores da Fase 0 (`tests/helpers/db.ts` — nome real da Fase 0/1); tabelas base da Fase 1 (`contacts`, `whatsapp_accounts`, `users`).
- Produces:
```ts
// src/domain/campaigns/types.ts (fonte única dos enums)
export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const RECIPIENT_STATUSES = ['pending', 'sent', 'failed', 'replied', 'opted_out'] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];
export const PAUSE_REASONS = ['failure_rate', 'session_down', 'opt_out_spike', 'human'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  messageTemplate: string;
  allowedAccountIds: string[];
  dailyLimit: number | null;          // por conta, por dia; null = só o ramp
  scheduledAt: Date | null;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  pausedBy: string | null;            // null = pausa automática
  resumedBy: string | null;
  resumedAt: Date | null;             // reinicia a janela de pausa automática
  createIdempotencyKey: string | null;
  createRequestHash: string | null;
  startIdempotencyKey: string | null;
  startRequestHash: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface NewCampaign {
  id: string; name: string; messageTemplate: string; allowedAccountIds: string[];
  dailyLimit: number | null; createdBy: string;
  createIdempotencyKey: string; createRequestHash: string;
}
export interface CampaignRecipient {
  id: string; campaignId: string; contactId: string; accountId: string;
  step: number; status: RecipientStatus; outboxKey: string | null;
  enqueuedAt: Date | null; repliedAt: Date | null; optedOutAt: Date | null; createdAt: Date;
}
```
- Tabelas: `campaigns` (colunas acima + `pgEnum`s `campaign_status`, `pause_reason`, `recipient_status`) e `campaign_recipients` com FK para `campaigns`, `contacts` e `whatsapp_accounts`.
- Índices/unicidades: parcial único `campaigns(create_idempotency_key) WHERE NOT NULL`; parcial único `campaigns(start_idempotency_key) WHERE NOT NULL`; único `(campaign_id, contact_id, step)` em `campaign_recipients`; índice `(account_id, status, enqueued_at)`; índice `(campaign_id, status)`.

- [ ] **Step 1: Escrever o teste falhado**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { campaigns, campaignRecipients } from '../../../src/modules/campaigns/schema';
import { migratedDb } from '../../helpers/db';

const U1 = '00000000-0000-0000-0000-0000000000f1';
const A1 = '00000000-0000-0000-0000-0000000000a1';
const CT1 = '00000000-0000-0000-0000-0000000000c1';
const C1 = '00000000-0000-0000-0000-0000000000d1';

describe('campaign schema', () => {
  it('aplica as migrações do zero e impõe unicidades, enums e FKs', async () => {
    const db = await migratedDb();
    await db.insert(campaigns).values({
      id: C1, name: 'Promo Outubro', messageTemplate: 'Oi {{nome}}',
      allowedAccountIds: [A1], createdBy: U1, createIdempotencyKey: 'key-1',
    });

    // mesma Idempotency-Key de criação → violação de unicidade parcial
    await assert.rejects(db.insert(campaigns).values({
      id: '00000000-0000-0000-0000-0000000000d2', name: 'Dup', messageTemplate: 'Oi',
      allowedAccountIds: [A1], createdBy: U1, createIdempotencyKey: 'key-1',
    }), /create_idempotency_key/);

    await db.insert(campaignRecipients).values({
      id: '00000000-0000-0000-0000-0000000000e1', campaignId: C1, contactId: CT1, accountId: A1, step: 1,
    });
    // o mesmo destinatário não recebe duas vezes o mesmo passo
    await assert.rejects(db.insert(campaignRecipients).values({
      id: '00000000-0000-0000-0000-0000000000e2', campaignId: C1, contactId: CT1, accountId: A1, step: 1,
    }), /campaign_recipients/);

    // estado fora do enum
    await assert.rejects(db.execute(sql`
      insert into campaign_recipients (id, campaign_id, contact_id, account_id, step, status)
      values ('00000000-0000-0000-0000-0000000000e3', ${C1}, ${CT1}, ${A1}, 1, 'batting')
    `), /recipient_status/);

    // FK para contacto inexistente
    await assert.rejects(db.insert(campaignRecipients).values({
      id: '00000000-0000-0000-0000-0000000000e4', campaignId: C1,
      contactId: '00000000-0000-0000-0000-000000000099', accountId: A1, step: 1,
    }), /campaign_recipients_contact_id/);
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/integration/campaigns/schema.test.ts`
Expected: FAIL — tabela `campaigns` não existe (`relation "campaigns" does not exist`)

- [ ] **Step 3: Implementar schema + migração**

Criar `src/domain/campaigns/types.ts` e `src/modules/campaigns/schema.ts` com as colunas/índices listados em Interfaces (Drizzle `pgTable`, `timestamp(..., { withTimezone: true })`, `uuid().defaultRandom()` só para `campaign_recipients.id` — o `id` de `campaigns` vem do chamador). Correr `npm run db:generate`, **rever** o SQL gerado (nenhuma tabela existente alterada) e aplicar com `npm run db:migrate`.

- [ ] **Step 4: Correr e ver passar**

Run: `npm run typecheck && npm test -- tests/integration/campaigns/schema.test.ts`
Expected: PASS — 1 teste, 0 falhas; migração aplica-se do zero numa base vazia

- [ ] **Step 5: Commit**

```bash
git add src/domain/campaigns/types.ts src/modules/campaigns/schema.ts drizzle/ tests/integration/campaigns/schema.test.ts
git commit -m "feat: add campaign entities schema and migration"
```

---

### Task 3: Regras de ritmo (atrasos, ramp, janela silenciosa, caps)

**Files:**
- Create: `src/domain/campaigns/rhythm.ts`
- Test: `tests/unit/campaigns/rhythm.test.ts`

**Interfaces:**
- Consumes: `CampaignConfig` da Task 1.
- Produces:
```ts
export function isQuietHours(now: Date, cfg: Pick<CampaignConfig, 'quietHours' | 'timezone'>): boolean;
/** Próxima abertura da janela de envio (08:00 Africa/Luanda); now se não estiver em silêncio. */
export function nextCampaignWindowOpen(now: Date, cfg: Pick<CampaignConfig, 'quietHours' | 'timezone'>): Date;
/** Dia de vida da conta, 1-based (dia de criação = 1). */
export function accountAgeDays(createdAt: Date, now: Date): number;
export function rampCapFor(ageDays: number, ramp: CampaignConfig['ramp']): number;
/** min(ramp da idade da conta, dailyLimit da campanha | sem teto). */
export function effectiveDailyCap(input: { ageDays: number; ramp: CampaignConfig['ramp']; campaignDailyLimit: number | null }): number;
/** minMs + floor(rng() * (maxMs - minMs + 1)), inclusivo nos dois extremos. */
export function randomDelayMs(delay: CampaignConfig['delay'], rng: () => number): number;
/** Meia-noite local de `now` em `timeZone` (instante UTC ainda anterior a now). */
export function dayStartInTz(now: Date, timeZone: string): Date;
export function nextDayStartInTz(now: Date, timeZone: string): Date;
```

- [ ] **Step 1: Escrever o teste falhado**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  accountAgeDays, dayStartInTz, effectiveDailyCap, isQuietHours,
  nextCampaignWindowOpen, nextDayStartInTz, randomDelayMs, rampCapFor,
} from '../../../src/domain/campaigns/rhythm';
import type { CampaignConfig } from '../../../src/modules/campaigns/config';

const cfg = {
  quietHours: { startMinute: 1200, endMinute: 480 },
  timezone: 'Africa/Luanda',
  ramp: {
    bands: [
      { fromDay: 1, toDay: 3, cap: 30 },
      { fromDay: 4, toDay: 7, cap: 60 },
      { fromDay: 8, toDay: 14, cap: 100 },
    ],
    defaultCap: 150,
  },
  delay: { minMs: 15000, maxMs: 45000 },
} as const satisfies Pick<CampaignConfig, 'quietHours' | 'timezone' | 'ramp' | 'delay'>;

describe('rhythm', () => {
  it('janela silenciosa 20:00-08:00 Africa/Luanda com limites exatos', () => {
    assert.equal(isQuietHours(new Date('2026-10-07T18:59:59Z'), cfg), false); // 19:59:59 local
    assert.equal(isQuietHours(new Date('2026-10-07T19:00:00Z'), cfg), true);  // 20:00 local
    assert.equal(isQuietHours(new Date('2026-10-07T19:30:00Z'), cfg), true);  // 20:30 local
    assert.equal(isQuietHours(new Date('2026-10-07T06:59:59Z'), cfg), true);  // 07:59:59 local
    assert.equal(isQuietHours(new Date('2026-10-07T07:00:00Z'), cfg), false); // 08:00 local
    assert.deepEqual(nextCampaignWindowOpen(new Date('2026-10-07T19:30:00Z'), cfg),
      new Date('2026-10-08T07:00:00Z'));
    assert.deepEqual(nextCampaignWindowOpen(new Date('2026-10-07T03:00:00Z'), cfg),
      new Date('2026-10-07T07:00:00Z'));
    assert.deepEqual(nextCampaignWindowOpen(new Date('2026-10-07T07:00:00Z'), cfg),
      new Date('2026-10-07T07:00:00Z'));
  });

  it('idade da conta em dias (1-based)', () => {
    assert.equal(accountAgeDays(new Date('2026-10-07T10:00:00Z'), new Date('2026-10-07T10:00:00Z')), 1);
    assert.equal(accountAgeDays(new Date('2026-10-04T10:00:00Z'), new Date('2026-10-07T09:59:59Z')), 3);
    assert.equal(accountAgeDays(new Date('2026-10-04T10:00:00Z'), new Date('2026-10-07T10:00:00Z')), 4);
  });

  it('ramp: dias 1-3:30, 4-7:60, 8-14:100, depois default', () => {
    assert.equal(rampCapFor(1, cfg.ramp), 30);
    assert.equal(rampCapFor(3, cfg.ramp), 30);
    assert.equal(rampCapFor(4, cfg.ramp), 60);
    assert.equal(rampCapFor(7, cfg.ramp), 60);
    assert.equal(rampCapFor(8, cfg.ramp), 100);
    assert.equal(rampCapFor(14, cfg.ramp), 100);
    assert.equal(rampCapFor(15, cfg.ramp), 150);
    assert.equal(rampCapFor(90, cfg.ramp), 150);
  });

  it('cap efetivo = min(ramp, dailyLimit da campanha)', () => {
    assert.equal(effectiveDailyCap({ ageDays: 3, ramp: cfg.ramp, campaignDailyLimit: null }), 30);
    assert.equal(effectiveDailyCap({ ageDays: 3, ramp: cfg.ramp, campaignDailyLimit: 10 }), 10);
    assert.equal(effectiveDailyCap({ ageDays: 3, ramp: cfg.ramp, campaignDailyLimit: 500 }), 30);
  });

  it('atraso aleatório dentro de 15000-45000 (inclusivo)', () => {
    assert.equal(randomDelayMs(cfg.delay, () => 0), 15000);
    assert.equal(randomDelayMs(cfg.delay, () => 0.5), 30000);
    assert.equal(randomDelayMs(cfg.delay, () => 0.999999999999), 45000);
  });

  it('meia-noite local em Africa/Luanda (UTC+1, sem DST)', () => {
    assert.deepEqual(dayStartInTz(new Date('2026-10-07T19:30:00Z'), 'Africa/Luanda'),
      new Date('2026-10-06T23:00:00Z'));
    assert.deepEqual(dayStartInTz(new Date('2026-10-07T00:30:00Z'), 'Africa/Luanda'),
      new Date('2026-10-06T23:00:00Z'));
    assert.deepEqual(nextDayStartInTz(new Date('2026-10-07T19:30:00Z'), 'Africa/Luanda'),
      new Date('2026-10-07T23:00:00Z'));
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/campaigns/rhythm.test.ts`
Expected: FAIL — `Cannot find module '../../../src/domain/campaigns/rhythm'`

- [ ] **Step 3: Implementar as funções em `src/domain/campaigns/rhythm.ts`**

Sem I/O. Todas as conversões de fuso com `Intl.DateTimeFormat(..., { timeZone })` usando `formatToParts` e offset derivado do próprio formato (nunca `getTimezoneOffset()` do host); `isQuietHours` compara `minutoLocal >= startMinute || minutoLocal < endMinute`; `accountAgeDays = floor((now - createdAt)/86400000) + 1`.

- [ ] **Step 4: Correr e ver passar**

Run: `npm run typecheck && npm test -- tests/unit/campaigns/rhythm.test.ts`
Expected: PASS — 6 testes, 0 falhas

- [ ] **Step 5: Commit**

```bash
git add src/domain/campaigns/rhythm.ts tests/unit/campaigns/rhythm.test.ts
git commit -m "feat: add campaign pacing rules (delay, ramp, quiet hours, caps)"
```

---

### Task 4: Template de mensagem com variáveis e rodapé de opt-out

**Files:**
- Create: `src/domain/campaigns/template.ts`
- Test: `tests/unit/campaigns/template.test.ts`

**Interfaces:**
- Consumes: `CampaignConfig['optOutFooter']` (Task 1).
- Produces:
```ts
export const CAMPAIGN_VARIABLES = ['nome', 'primeiro_nome'] as const;
export type TemplateErrorCode = 'unknown_variable' | 'malformed_variable' | 'empty_template';
export class TemplateError extends Error {
  readonly code: TemplateErrorCode;
  constructor(code: TemplateErrorCode, detail: string); // message: `${code} ${detail}`
}
/** Validação no boundary (chamada na criação da campanha). Lança TemplateError. */
export function validateTemplate(template: string): void;
export function renderCampaignMessage(
  input: { template: string; contactName: string | null },
  cfg: Pick<CampaignConfig, 'optOutFooter'>,
): string;
```

- [ ] **Step 1: Escrever o teste falhado**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderCampaignMessage, validateTemplate } from '../../../src/domain/campaigns/template';

const FOOTER = 'Responde SAIR para sair desta lista.';
const cfg = { optOutFooter: FOOTER };

describe('campaign template', () => {
  it('valida variáveis no boundary', () => {
    assert.doesNotThrow(() => validateTemplate('Olá {{nome}}, temos novidades.'));
    assert.doesNotThrow(() => validateTemplate('Olá {{primeiro_nome}}!'));
    assert.throws(() => validateTemplate('Olá {{apelido}}'), /unknown_variable \{\{apelido\}\}/);
    assert.doesNotThrow(() => validateTemplate('Olá {{ nome }}'));
    assert.throws(() => validateTemplate('Olá {{nome'), /malformed_variable/);
    assert.throws(() => validateTemplate('   '), /empty_template/);
  });

  it('renderiza variáveis e anexa sempre o rodapé de opt-out', () => {
    assert.equal(renderCampaignMessage({ template: 'Olá {{nome}}!', contactName: '  Ana Maria  ' }, cfg),
      `Olá Ana Maria!\n\n${FOOTER}`);
    assert.equal(renderCampaignMessage({ template: 'Olá {{primeiro_nome}}!', contactName: 'Ana Maria' }, cfg),
      `Olá Ana!\n\n${FOOTER}`);
    assert.equal(renderCampaignMessage({ template: 'Oi {{nome}}', contactName: null }, cfg),
      `Oi \n\n${FOOTER}`);
    const already = `Oi {{nome}}\n\n${FOOTER}`;
    assert.equal(renderCampaignMessage({ template: already, contactName: 'Ana' }, cfg),
      `Oi Ana\n\n${FOOTER}`); // não duplica o rodapé
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/campaigns/template.test.ts`
Expected: FAIL — `Cannot find module '../../../src/domain/campaigns/template'`

- [ ] **Step 3: Implementar `validateTemplate` e `renderCampaignMessage`**

`validateTemplate`: rejeita vazio/espaços; encontra todos os `{{...}}` com `/\{\{\s*([a-z_]+)\s*\}\}/g`; chave fora de `CAMPAIGN_VARIABLES` → `unknown_variable`; sobra `{{` sem fecho válido → `malformed_variable`. `renderCampaignMessage`: substitui `{{nome}}` (nome faz `.trim()`, `null`/vazio → `''`) e `{{primeiro_nome}}` (primeira palavra do nome aparado), depois anexa `\n\n${optOutFooter}` se o texto final (normalizado) ainda não contiver o rodapé.

- [ ] **Step 4: Correr e ver passar**

Run: `npm run typecheck && npm test -- tests/unit/campaigns/template.test.ts`
Expected: PASS — 2 testes, 0 falhas

- [ ] **Step 5: Commit**

```bash
git add src/domain/campaigns/template.ts tests/unit/campaigns/template.test.ts
git commit -m "feat: validate and render campaign message templates"
```

---

### Task 5: Criar campanha (validação de contas e idempotência)

**Files:**
- Create: `src/ports/campaigns.ts`
- Create: `src/application/campaigns/create-campaign.ts`
- Create: `src/adapters/db/campaigns.ts`
- Modify: `src/ports/audit.ts` (se a Fase 1 ainda não expuser o port `Audit` de `docs/01` §5, criá-lo com a assinatura abaixo)
- Test: `tests/unit/campaigns/create-campaign.test.ts`
- Test helper: `tests/unit/campaigns/fakes.ts` (portas em memória reutilizadas nas Tasks 6–11)

**Interfaces:**
- Consumes: port `Audit` (Fase 1, `docs/01` §5): `record(input: { actorId: string | null; action: string; entity: string; entityId: string; detail?: Record<string, unknown>; at: Date }): Promise<void>`.
- Produces:
```ts
// src/ports/campaigns.ts
export type AccountPurpose = 'support' | 'sales' | 'campaigns';
export type AccountStatus = 'connecting' | 'connected' | 'disconnected' | 'suspected_ban';
export interface WhatsAppAccountStub { id: string; purpose: AccountPurpose; status: AccountStatus; createdAt: Date; }
export interface AccountGate { find(ids: readonly string[]): Promise<readonly WhatsAppAccountStub[]>; }

export interface StatusPatch {
  status: CampaignStatus;
  pauseReason?: PauseReason | null;
  pausedAt?: Date | null;
  pausedBy?: string | null;
  resumedBy?: string | null;
  resumedAt?: Date | null;
  scheduledAt?: Date | null;
  startIdempotencyKey?: string;
  startRequestHash?: string;
}
export interface CampaignRepository {
  insert(c: NewCampaign): Promise<Campaign>;
  findById(id: string): Promise<Campaign | null>;
  findByIdempotencyKey(key: string): Promise<Campaign | null>;
  list(input: { limit: number; cursor: string | null }): Promise<{ items: Campaign[]; nextCursor: string | null }>;
  /** Transição condicional (FOR UPDATE): só aplica se o estado atual estiver em `expected`. Devolve null se não. */
  compareAndSetStatus(id: string, expected: readonly CampaignStatus[], patch: StatusPatch): Promise<Campaign | null>;
}

// src/application/campaigns/create-campaign.ts
export interface CreateCampaignInput {
  idempotencyKey: string;
  actorId: string;
  name: string;
  messageTemplate: string;
  allowedAccountIds: readonly string[];  // sem duplicados, 1..10
  dailyLimit: number | null;             // >= 1 se presente
}
export type CampaignErrorCode =
  | 'invalid_template' | 'empty_accounts' | 'duplicate_account' | 'unknown_account'
  | 'unsupported_account_purpose' | 'idempotency_conflict';
export class CampaignError extends Error { readonly code: CampaignErrorCode; readonly status: number; }
export type CreateCampaign = (input: CreateCampaignInput) => Promise<{ campaign: Campaign; replayed: boolean }>;
```
- Adapter Drizzle `src/adapters/db/campaigns.ts` implementa `AccountGate` (lê `whatsapp_accounts`) e `CampaignRepository` (cursor = `createdAt.getTime()` + `id`).

- [ ] **Step 1: Escrever o teste falhado**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CampaignError, type CreateCampaign } from '../../../src/application/campaigns/create-campaign';
import { makeCreateDeps } from './fakes';

const U1 = '00000000-0000-0000-0000-0000000000f1';
const A_SUP = '00000000-0000-0000-0000-0000000000a1';
const A_CAMP = '00000000-0000-0000-0000-0000000000a2';
const base = {
  idempotencyKey: 'K1', actorId: U1, name: 'Promo Outubro',
  messageTemplate: 'Olá {{nome}}, temos novidades!', allowedAccountIds: [A_CAMP], dailyLimit: null,
};

describe('createCampaign', () => {
  it('REJEITA campanha numa conta purpose = support (obrigatório)', async () => {
    const { create } = makeCreateDeps({ accounts: [{ id: A_SUP, purpose: 'support', status: 'connected', createdAt: new Date('2026-10-01T00:00:00Z') }] });
    const err = await create({ ...base, allowedAccountIds: [A_SUP] }).catch((e: unknown) => e);
    assert.ok(err instanceof CampaignError);
    assert.equal((err as CampaignError).code, 'unsupported_account_purpose');
    assert.equal((err as CampaignError).status, 400);
  });

  it('cria em conta campaigns e regista audit', async () => {
    const { create, audit } = makeCreateDeps();
    const res = await create(base);
    assert.equal(res.replayed, false);
    assert.equal(res.campaign.status, 'draft');
    assert.equal(res.campaign.name, 'Promo Outubro');
    assert.equal(res.campaign.dailyLimit, null);
    assert.equal(audit.calls.length, 1);
    const auditCall = audit.calls[0]!;
    assert.equal(auditCall.actorId, U1);
    assert.equal(auditCall.action, 'campaign.created');
    assert.equal(auditCall.entity, 'campaign');
    assert.equal(auditCall.entityId, res.campaign.id);
    assert.ok(auditCall.at instanceof Date);
  });

  it('mesma Idempotency-Key + mesmo corpo = replay; corpo diferente = conflito', async () => {
    const { create } = makeCreateDeps();
    const first = await create(base);
    const replay = await create(base);
    assert.equal(replay.replayed, true);
    assert.equal(replay.campaign.id, first.campaign.id);
    const err = await create({ ...base, name: 'Outro nome' }).catch((e: unknown) => e);
    assert.ok(err instanceof CampaignError);
    assert.equal((err as CampaignError).code, 'idempotency_conflict');
    assert.equal((err as CampaignError).status, 409);
  });

  it('valida lista de contas e template', async () => {
    const { create } = makeCreateDeps({ accountsMissing: ['00000000-0000-0000-0000-0000000000a9'] });
    await assert.rejects(create({ ...base, allowedAccountIds: [] }), { code: 'empty_accounts' });
    await assert.rejects(create({ ...base, allowedAccountIds: [A_CAMP, A_CAMP] }), { code: 'duplicate_account' });
    await assert.rejects(create({ ...base, allowedAccountIds: ['00000000-0000-0000-0000-0000000000a9'] }), { code: 'unknown_account' });
    await assert.rejects(create({ ...base, messageTemplate: 'Oi {{apelido}}' }), { code: 'invalid_template' });
    await assert.rejects(create({ ...base, dailyLimit: 0 }), CampaignError);
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/campaigns/create-campaign.test.ts`
Expected: FAIL — `Cannot find module '../../../src/application/campaigns/create-campaign'`

- [ ] **Step 3: Implementar ports, caso de uso e adapter**

Ordem do caso de uso: (1) zod do input (`name` 1..120, `messageTemplate` 1..4096, `allowedAccountIds` 1..10 uuids sem duplicados, `dailyLimit` null ou ≥ 1) → `CampaignError('invalid_input', 400)`; (2) `validateTemplate` → `invalid_template`; (3) `AccountGate.find` — contas em falta → `unknown_account`, qualquer `purpose !== 'campaigns'` → `unsupported_account_purpose` (recusa `support`, `sales`); (4) `findByIdempotencyKey` — existente com `createRequestHash` igual → replay; diferente → `idempotency_conflict`; (5) `insert` com `randomUUID()` e `createRequestHash = sha256(canonical do corpo)` (`node:crypto`, sem dependência nova); (6) `Audit.record('campaign.created')`.

- [ ] **Step 4: Correr e ver passar**

Run: `npm run typecheck && npm test -- tests/unit/campaigns/create-campaign.test.ts`
Expected: PASS — 4 testes, 0 falhas

- [ ] **Step 5: Commit**

```bash
git add src/ports/campaigns.ts src/ports/audit.ts src/application/campaigns/create-campaign.ts src/adapters/db/campaigns.ts tests/unit/campaigns/
git commit -m "feat: create campaign use case with account purpose validation"
```

---

### Task 6: Iniciar campanha (segmentação por consentimento e agendamento)

**Files:**
- Create: `src/ports/campaign-audience.ts`
- Create: `src/ports/campaign-recipients.ts`
- Create: `src/application/campaigns/start-campaign.ts`
- Modify: `src/adapters/db/campaigns.ts` (implementar os dois ports novos)
- Test: `tests/unit/campaigns/start-campaign.test.ts`
- Test: `tests/integration/campaigns/segmentation.test.ts`

**Interfaces:**
- Consumes: `CampaignRepository`, `AccountGate`, `CampaignError`, `Audit` da Task 5.
- Produces:
```ts
// src/ports/campaign-audience.ts
export interface ContactAudience {
  /** Contactos com marketing_consent = true E opted_out_at IS NULL, ordenados por id. Só uuids. */
  eligibleContactIds(): Promise<readonly string[]>;
}
// src/ports/campaign-recipients.ts
export interface NewRecipient { id: string; campaignId: string; contactId: string; accountId: string; step: number; }
export interface CampaignRecipientStore {
  /** Idempotente: ON CONFLICT (campaign_id, contact_id, step) DO NOTHING. Devolve nº de linhas novas. */
  insertBatch(rows: readonly NewRecipient[]): Promise<number>;
  countByCampaign(campaignId: string): Promise<number>;
  /** pendente → sent: preenche outboxKey e enqueuedAt. Devolve true só se mudou (idempotente). */
  markEnqueued(recipientId: string, outboxKey: string, at: Date): Promise<boolean>;
}

// src/application/campaigns/start-campaign.ts
export interface StartCampaignInput {
  campaignId: string;
  idempotencyKey: string;
  actorId: string;
  scheduledAt: Date | null;   // null = começar já
  now: Date;
}
export type StartCampaign = (input: StartCampaignInput) =>
  Promise<{ campaign: Campaign; recipientsCreated: number; replayed: boolean }>;
// CampaignError codes acrescentados: 'invalid_status' (409), 'campaign_already_running' (409)
```

- [ ] **Step 1: Escrever os testes falhados**

`tests/unit/campaigns/start-campaign.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeStartDeps } from './fakes';

const U1 = '00000000-0000-0000-0000-0000000000f1';
const A1 = '00000000-0000-0000-0000-0000000000a1';
const A2 = '00000000-0000-0000-0000-0000000000a2';
const CT1 = '00000000-0000-0000-0000-0000000000c1';
const CT2 = '00000000-0000-0000-0000-0000000000c2';

describe('startCampaign', () => {
  it('materializa destinatários e só depois transita draft → running', async () => {
    const { start, recipients } = makeStartDeps({
      campaignId: '00000000-0000-0000-0000-0000000000d1',
      allowedAccountIds: [A1, A2], eligible: [CT1, CT2],
    });
    const res = await start({ campaignId: '00000000-0000-0000-0000-0000000000d1', idempotencyKey: 'S1', actorId: U1, scheduledAt: null, now: new Date('2026-10-07T10:00:00Z') });
    assert.equal(res.recipientsCreated, 2);
    assert.equal(res.replayed, false);
    assert.equal(res.campaign.status, 'running');
    assert.deepEqual(recipients.calls, ['insertBatch', 'compareAndSetStatus']); // crash-safe: materializar antes de transitar
    assert.equal(recipients.lastRows.length, 2);
    const [row1, row2] = recipients.lastRows;
    assert.ok(typeof row1.id === 'string' && typeof row2.id === 'string'); // ids gerados em runtime
    assert.deepEqual(
      { campaignId: row1.campaignId, contactId: row1.contactId, accountId: row1.accountId, step: row1.step },
      { campaignId: '00000000-0000-0000-0000-0000000000d1', contactId: CT1, accountId: A1, step: 1 },
    );
    assert.deepEqual(
      { campaignId: row2.campaignId, contactId: row2.contactId, accountId: row2.accountId, step: row2.step },
      { campaignId: '00000000-0000-0000-0000-0000000000d1', contactId: CT2, accountId: A2, step: 1 },
    );
  });

  it('scheduledAt futuro deixa a campanha scheduled; replay não recria destinatários', async () => {
    const { start } = makeStartDeps({ campaignId: '00000000-0000-0000-0000-0000000000d1', allowedAccountIds: [A1], eligible: [CT1] });
    const first = await start({ campaignId: '00000000-0000-0000-0000-0000000000d1', idempotencyKey: 'S1', actorId: U1, scheduledAt: new Date('2026-10-08T09:00:00Z'), now: new Date('2026-10-07T10:00:00Z') });
    assert.equal(first.campaign.status, 'scheduled');
    const replay = await start({ campaignId: '00000000-0000-0000-0000-0000000000d1', idempotencyKey: 'S1', actorId: U1, scheduledAt: new Date('2026-10-08T09:00:00Z'), now: new Date('2026-10-07T10:05:00Z') });
    assert.equal(replay.replayed, true);
    assert.equal(replay.recipientsCreated, 0);
    await assert.rejects(start({ campaignId: '00000000-0000-0000-0000-0000000000d1', idempotencyKey: 'S2', actorId: U1, scheduledAt: null, now: new Date('2026-10-07T10:06:00Z') }),
      { code: 'invalid_status', status: 409 });
  });

  it('re-valida purpose das contas no início (mudou desde a criação)', async () => {
    const { start } = makeStartDeps({ campaignId: '00000000-0000-0000-0000-0000000000d1', allowedAccountIds: [A1], eligible: [], purposeNow: 'support' });
    await assert.rejects(start({ campaignId: '00000000-0000-0000-0000-0000000000d1', idempotencyKey: 'S1', actorId: U1, scheduledAt: null, now: new Date('2026-10-07T10:00:00Z') }),
      { code: 'unsupported_account_purpose', status: 400 });
  });
});
```

`tests/integration/campaigns/segmentation.test.ts` (Postgres real; fixtures de contactos sintéticos):

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contacts } from '../../../src/adapters/db/schema'; // schema base da Fase 1
import { migratedDb } from '../../helpers/db';
import { buildAudience, buildRecipientStore } from '../../../src/adapters/db/campaigns';

const CT1 = '00000000-0000-0000-0000-0000000000c1'; // consent, sem opt-out
const CT2 = '00000000-0000-0000-0000-0000000000c2'; // consent + opted_out → excluído
const CT3 = '00000000-0000-0000-0000-0000000000c3'; // sem consentimento → excluído
const CT4 = '00000000-0000-0000-0000-0000000000c4'; // consent, sem opt-out

describe('segmentation', () => {
  it('só marketing_consent = true e opted_out_at is null; round-robin pelas contas; idempotente', async () => {
    const db = await migratedDb();
    await db.insert(contacts).values([
      { id: CT1, phoneE164: '+244900000001', name: 'Ana', marketingConsent: true, optedOutAt: null },
      { id: CT2, phoneE164: '+244900000002', name: 'Bia', marketingConsent: true, optedOutAt: new Date('2026-10-01T00:00:00Z') },
      { id: CT3, phoneE164: '+244900000003', name: 'Cá', marketingConsent: false, optedOutAt: null },
      { id: CT4, phoneE164: '+244900000004', name: 'Dio', marketingConsent: true, optedOutAt: null },
    ]);

    const audience = buildAudience(db);
    assert.deepEqual(await audience.eligibleContactIds(), [CT1, CT4]);

    const store = buildRecipientStore(db);
    const rows = [CT1, CT4].map((contactId, i) => ({
      id: `00000000-0000-0000-0000-0000000000e${i + 1}`,
      campaignId: '00000000-0000-0000-0000-0000000000d1', contactId,
      accountId: i === 0 ? '00000000-0000-0000-0000-0000000000a1' : '00000000-0000-0000-0000-0000000000a2',
      step: 1,
    }));
    assert.equal(await store.insertBatch(rows), 2);
    assert.equal(await store.insertBatch(rows), 0); // o mesmo destinatário não recebe duas vezes o mesmo passo
    assert.equal(await store.countByCampaign('00000000-0000-0000-0000-0000000000d1'), 2);
    const at = new Date('2026-10-07T10:00:00Z');
    assert.equal(await store.markEnqueued('00000000-0000-0000-0000-0000000000e1', 'campaign-key', at), true);
    assert.equal(await store.markEnqueued('00000000-0000-0000-0000-0000000000e1', 'campaign-key', at), false); // idempotente
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/campaigns/start-campaign.test.ts`
Expected: FAIL — `Cannot find module '../../../src/application/campaigns/start-campaign'`

Run: `npm test -- tests/integration/campaigns/segmentation.test.ts`
Expected: FAIL — ports/adapters novos não existem

- [ ] **Step 3: Implementar ports, adapter e caso de uso**

`startCampaign`: (1) replay por `startIdempotencyKey` + `startRequestHash` (sha256 do corpo `{ scheduledAt }`); (2) `findById` — inexistente → `invalid_status`; (3) re-valida contas como na Task 5; (4) `eligibleContactIds()` e atribuição round-robin `accountId = allowedAccountIds[i % allowedAccountIds.length]`, `step: 1`, `randomUUID()` por linha; (5) `insertBatch` (ON CONFLICT DO NOTHING) **antes** de (6) `compareAndSetStatus(['draft'], { status: scheduledAt > now ? 'scheduled' : 'running', scheduledAt, startIdempotencyKey, startRequestHash })` — nulo → `invalid_status` (se já tiver chave igual, antes devolve replay); (7) `Audit.record('campaign.started')`. No adapter: `insertBatch` com `ON CONFLICT (campaign_id, contact_id, step) DO NOTHING`; `markEnqueued` = `UPDATE campaign_recipients SET status = 'sent', outbox_key = $2, enqueued_at = $3 WHERE id = $1 AND status = 'pending'` (devolve `true` só se atualizou).

- [ ] **Step 4: Correr e ver passar**

Run: `npm run typecheck && npm test -- tests/unit/campaigns/start-campaign.test.ts tests/integration/campaigns/segmentation.test.ts`
Expected: PASS — 3 + 1 testes, 0 falhas

- [ ] **Step 5: Commit**

```bash
git add src/ports/campaign-audience.ts src/ports/campaign-recipients.ts src/application/campaigns/start-campaign.ts src/adapters/db/campaigns.ts tests/unit/campaigns/start-campaign.test.ts tests/integration/campaigns/segmentation.test.ts
git commit -m "feat: start campaign with consent-based segmentation"
```

---

### Task 7: Opt-out imediato em todas as campanhas

**Files:**
- Create: `src/domain/campaigns/opt-out.ts`
- Create: `src/application/campaigns/apply-opt-out.ts`
- Modify: `src/ports/campaign-audience.ts` (`markOptedOut`)
- Modify: `src/ports/campaign-recipients.ts` (`markOptedOutByContact`)
- Modify: `src/adapters/db/campaigns.ts`
- Test: `tests/unit/campaigns/opt-out.test.ts`
- Test: `tests/integration/campaigns/opt-out.test.ts`

**Interfaces:**
- Consumes: `CampaignConfig['optOutKeywords']` (Task 1), ports das Tasks 5–6.
- Produces:
```ts
// src/domain/campaigns/opt-out.ts — normalização igual a reference/keyword-safety-net.ts (NFD sem diacríticos + lowercase)
export function detectOptOut(text: string, keywords: readonly string[]): boolean; // palavra inteira (\b), keywords vazio = false

// src/ports/campaign-audience.ts ( acrescentado )
markOptedOut(contactId: string, at: Date): Promise<boolean>; // idempotente: true só se opted_out_at passou a estar preenchido

// src/ports/campaign-recipients.ts ( acrescentado )
/** pending → opted_out; sent/replied/failed só levam opted_out_at. Todas as campanhas do contacto. Idempotente. */
markOptedOutByContact(contactId: string, at: Date): Promise<number>;

// src/application/campaigns/apply-opt-out.ts
export interface ApplyOptOutInput { contactId: string; at: Date; source: 'inbound_message' | 'manual'; }
export type ApplyOptOut = (input: ApplyOptOutInput) => Promise<{ optedOut: boolean; recipientsUpdated: number }>;
```

- [ ] **Step 1: Escrever os testes falhados**

`tests/unit/campaigns/opt-out.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectOptOut } from '../../../src/domain/campaigns/opt-out';

describe('detectOptOut', () => {
  it('deteta "SAIR" e variantes configuráveis, palavra inteira', () => {
    const k = ['sair', 'unsubscribe'];
    assert.equal(detectOptOut('SAIR', k), true);
    assert.equal(detectOptOut('sair por favor!!', k), true);
    assert.equal(detectOptOut('SAÍR', k), true);
    assert.equal(detectOptOut('Quero sair desta lista', k), true);
    assert.equal(detectOptOut('unsubscribe now', k), true);
    assert.equal(detectOptOut('sairia amanhã', k), false);
    assert.equal(detectOptOut('vamos sair juntos?', k), true); // contém a palavra inteira "sair"
    assert.equal(detectOptOut('obrigado pela ajuda', k), false);
    assert.equal(detectOptOut('', k), false);
    assert.equal(detectOptOut('SAIR', []), false);
  });
});
```

`tests/integration/campaigns/opt-out.test.ts` (Postgres real):

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migratedDb } from '../../helpers/db';
import { buildAudience, buildRecipientStore } from '../../../src/adapters/db/campaigns';
import { makeApplyOptOut } from '../../../src/application/campaigns/apply-opt-out';

const CT1 = '00000000-0000-0000-0000-0000000000c1';
const CAMP1 = '00000000-0000-0000-0000-0000000000d1';
const CAMP2 = '00000000-0000-0000-0000-0000000000d2';
const AT = new Date('2026-10-07T10:00:00Z');

describe('applyOptOut', () => {
  it('marca o contacto de imediato e sai de TODAS as campanhas (pendentes → opted_out)', async () => {
    const db = await migratedDb();
    const audience = buildAudience(db);
    const recipients = buildRecipientStore(db);
    const apply = makeApplyOptOut({ audience, recipients });

    // r1: pendente na campanha 1; r2: já enviado na campanha 1; r3: pendente na campanha 2
    await recipients.insertBatch([
      { id: '00000000-0000-0000-0000-0000000000e1', campaignId: CAMP1, contactId: CT1, accountId: '00000000-0000-0000-0000-0000000000a1', step: 1 },
      { id: '00000000-0000-0000-0000-0000000000e2', campaignId: CAMP1, contactId: CT1, accountId: '00000000-0000-0000-0000-0000000000a1', step: 1 },
      { id: '00000000-0000-0000-0000-0000000000e3', campaignId: CAMP2, contactId: CT1, accountId: '00000000-0000-0000-0000-0000000000a1', step: 1 },
    ]);
    assert.equal(await recipients.markEnqueued('00000000-0000-0000-0000-0000000000e2', 'campaign-key-2', AT), true);

    const first = await apply({ contactId: CT1, at: AT, source: 'inbound_message' });
    assert.deepEqual(first, { optedOut: true, recipientsUpdated: 2 }); // só as pendentes mudam de estado
    const second = await apply({ contactId: CT1, at: AT, source: 'inbound_message' });
    assert.deepEqual(second, { optedOut: false, recipientsUpdated: 0 }); // idempotente

    assert.ok(!(await audience.eligibleContactIds()).includes(CT1)); // fora da segmentação para sempre
    // r1 e r3: status 'opted_out' + opted_out_at preenchido; r2: continua 'sent' com opted_out_at preenchido
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/campaigns/opt-out.test.ts tests/integration/campaigns/opt-out.test.ts`
Expected: FAIL — `Cannot find module '../../../src/domain/campaigns/opt-out'`

- [ ] **Step 3: Implementar**

`detectOptOut`: normaliza o texto, testa cada keyword com `new RegExp('\\b' + escapeRegex(k) + '\\b')`. `applyOptOut`: (1) `audience.markOptedOut(contactId, at)` → se `false`, devolve `{ optedOut: false, recipientsUpdated: 0 }`; (2) `recipients.markOptedOutByContact(contactId, at)` (UPDATE único: `opted_out_at = at`; `status = 'opted_out'` só quando `status = 'pending'`; `WHERE opted_out_at IS NULL`); (3) `Audit.record('contact.opted_out')`. Adapter SQL correspondente nos dois ports.

- [ ] **Step 4: Correr e ver passar**

Run: `npm run typecheck && npm test -- tests/unit/campaigns/opt-out.test.ts tests/integration/campaigns/opt-out.test.ts`
Expected: PASS — 2 testes, 0 falhas

- [ ] **Step 5: Commit**

```bash
git add src/domain/campaigns/opt-out.ts src/application/campaigns/apply-opt-out.ts src/ports/ src/adapters/db/campaigns.ts tests/unit/campaigns/opt-out.test.ts tests/integration/campaigns/opt-out.test.ts
git commit -m "feat: immediate contact opt-out across all campaigns"
```

---

### Task 8: Efeitos da mensagem de entrada (opt-out e "respondeu")

**Files:**
- Create: `src/application/campaigns/inbound-effects.ts`
- Modify: `src/ports/campaign-recipients.ts` (`markRepliedByContact`)
- Modify: `src/adapters/db/campaigns.ts`
- Modify: `src/application/handle-inbound.ts` (caso de uso de entrada da Fase 1/3 — ponto "mensagem guardada → handleInbound" de `docs/01` §7; se a Fase 1/3 usar outro ficheiro, ligar exatamente nesse passo)
- Test: `tests/integration/campaigns/inbound-effects.test.ts`

**Interfaces:**
- Consumes: `detectOptOut` (Task 7), `applyOptOut` (Task 7), `CampaignConfig['optOutKeywords']`.
- Produces:
```ts
// src/ports/campaign-recipients.ts ( acrescentado )
/** sent → replied (só se replied_at for null). Devolve nº de linhas. */
markRepliedByContact(contactId: string, at: Date): Promise<number>;

// src/application/campaigns/inbound-effects.ts
export interface InboundCampaignEffectsInput { contactId: string; text: string; receivedAt: Date; }
export type InboundCampaignEffects = (input: InboundCampaignEffectsInput) =>
  Promise<{ optedOut: boolean; repliesMarked: number }>;
```
- Ordem fixa: se `detectOptOut` → `applyOptOut` e **não** conta como resposta de campanha (`repliesMarked: 0`); caso contrário `markRepliedByContact`.

- [ ] **Step 1: Escrever o teste falhado**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migratedDb } from '../../helpers/db';
import { buildAudience, buildRecipientStore } from '../../../src/adapters/db/campaigns';
import { makeApplyOptOut } from '../../../src/application/campaigns/apply-opt-out';
import { makeInboundEffects } from '../../../src/application/campaigns/inbound-effects';

const CT1 = '00000000-0000-0000-0000-0000000000c1';
const CAMP1 = '00000000-0000-0000-0000-0000000000d1';
const AT = new Date('2026-10-07T10:00:00Z');

describe('inbound campaign effects', () => {
  it('"SAIR" → opt-out imediato e não conta como resposta', async () => {
    const db = await migratedDb();
    const recipients = buildRecipientStore(db);
    const audience = buildAudience(db);
    const effects = makeInboundEffects({
      applyOptOut: makeApplyOptOut({ audience, recipients }),
      recipients, keywords: ['sair'],
    });
    await recipients.insertBatch([{ id: '00000000-0000-0000-0000-0000000000e1', campaignId: CAMP1, contactId: CT1, accountId: '00000000-0000-0000-0000-0000000000a1', step: 1 }]);
    await recipients.markEnqueued('00000000-0000-0000-0000-0000000000e1', 'k1', AT);

    assert.deepEqual(await effects({ contactId: CT1, text: 'SAIR', receivedAt: AT }),
      { optedOut: true, repliesMarked: 0 });
  });

  it('resposta normal → destinatário enviados ficam replied', async () => {
    const db = await migratedDb();
    const recipients = buildRecipientStore(db);
    const audience = buildAudience(db);
    const effects = makeInboundEffects({ applyOptOut: makeApplyOptOut({ audience, recipients }), recipients, keywords: ['sair'] });
    await recipients.insertBatch([{ id: '00000000-0000-0000-0000-0000000000e2', campaignId: CAMP1, contactId: CT1, accountId: '00000000-0000-0000-0000-0000000000a1', step: 1 }]);
    await recipients.markEnqueued('00000000-0000-0000-0000-0000000000e2', 'k2', AT);

    assert.deepEqual(await effects({ contactId: CT1, text: 'Muito obrigado!', receivedAt: AT }),
      { optedOut: false, repliesMarked: 1 });
    assert.deepEqual(await effects({ contactId: CT1, text: 'Muito obrigado!', receivedAt: AT }),
      { optedOut: false, repliesMarked: 0 }); // idempotente
  });
});
```

Adicionar também um teste de integração no pipeline real da Fase 1: gravar/processar uma mensagem de entrada sintética com texto `'SAIR'` para `CT1` pelo job de webhooks da Fase 1 e afirmar `contacts.opted_out_at` preenchido (o passo de wiring é este); reutilizar o helper de webhook/assinatura da Fase 1.

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/integration/campaigns/inbound-effects.test.ts`
Expected: FAIL — `Cannot find module '../../../src/application/campaigns/inbound-effects'`

- [ ] **Step 3: Implementar e ligar ao pipeline de entrada**

Implementar `inbound-effects.ts` (ordem: opt-out primeiro, senão `markRepliedByContact`). No caso de uso de entrada da Fase 1/3, chamar `inboundEffects({ contactId, text, receivedAt })` **depois** da mensagem estar guardada e **antes** de `handleInbound` (o opt-out tem de ser imediato, inclusive em conversas `human_only`), com `try/catch` que regista erro e propaga (nunca `catch {}`).

- [ ] **Step 4: Correr e ver passar**

Run: `npm run typecheck && npm test -- tests/integration/campaigns/inbound-effects.test.ts`
Expected: PASS — 3 testes (2 do módulo + 1 do wiring), 0 falhas

- [ ] **Step 5: Commit**

```bash
git add src/application/campaigns/inbound-effects.ts src/application/handle-inbound.ts src/ports/ src/adapters/db/campaigns.ts tests/integration/campaigns/inbound-effects.test.ts
git commit -m "feat: apply campaign opt-out and reply state on inbound messages"
```

---

### Task 9: Job de envio da campanha (tick)

**Files:**
- Create: `src/ports/campaign-dispatch.ts`
- Create: `src/application/campaigns/process-campaign-tick.ts`
- Create: `src/application/campaigns/ensure-campaign-ticks.ts`
- Create: `src/adapters/queue/campaign-tick.ts`
- Modify: `src/adapters/db/campaigns.ts`
- Test: `tests/unit/campaigns/tick.test.ts`
- Test: `tests/unit/campaigns/ensure-ticks.test.ts`
- Test: `tests/integration/campaigns/queue.test.ts`

**Interfaces:**
- Consumes: `CampaignConfig` (Task 1), `rhythm` (Task 3), `renderCampaignMessage` (Task 4), `CampaignRepository`/`AccountGate` (Task 5), `CampaignRecipientStore` (Task 6).
- Produces:
```ts
// src/ports/campaign-dispatch.ts
export interface CampaignDispatchStore {
  /** Pendente mais antiga DESTA conta. */
  nextPending(campaignId: string, accountId: string): Promise<{ id: string; contactId: string; step: number } | null>;
  /** pending → opted_out (+ opted_out_at) dos contactos sem consentimento ou com opt-out (limpeza antes do envio). */
  skipIneligibleContacts(campaignId: string, at: Date): Promise<number>;
  pendingCountForAccount(campaignId: string, accountId: string): Promise<number>;
  pendingCount(campaignId: string): Promise<number>;
  countEnqueuedSince(accountId: string, since: Date): Promise<number>;
}
export interface ContactNameSource { displayName(contactId: string): Promise<string | null>; }
/** Port da Fase 1 (outbox + fila). enqueue é idempotente por idempotencyKey. */
export interface CampaignOutbox {
  enqueue(input: { accountId: string; contactId: string; conversationId: string; sender: 'campaign';
                   text: string; idempotencyKey: string; scheduledAt: Date; }): Promise<{ outboxId: string; duplicate: boolean }>;
  pendingConversationCount(accountId: string): Promise<number>;
}
export interface ConversationFinder {
  /** Devolve a conversa existente de (accountId, contactId) ou cria uma com line = null e o ai_mode por defeito da conta (config da Fase 3). */
  findOrCreateForCampaign(input: { accountId: string; contactId: string }): Promise<{ id: string }>;
}
export interface TickScheduler {
  /** jobId determinístico `campaign:{campaignId}:account:{accountId}`; no-op se o job já existir. */
  ensureTick(input: { campaignId: string; accountId: string; runAt: Date }): Promise<void>;
}
export type PauseReasonCode = PauseReason;
export type PauseGuard = (ctx: { campaign: Campaign; account: WhatsAppAccountStub; now: Date }) =>
  Promise<{ reason: PauseReasonCode } | null>;
export interface PauseApplier {
  apply(input: { campaignId: string; reason: PauseReasonCode; actorId: string | null; now: Date }): Promise<boolean>;
}

// src/application/campaigns/process-campaign-tick.ts
export type TickReason =
  | 'campaign_not_running' | 'scheduled_not_due' | 'account_unavailable' | 'quiet_hours'
  | 'daily_cap' | 'conversation_backlog' | 'no_pending_recipient' | 'paused';
export type TickResult =
  | { outcome: 'idle'; reason: TickReason }
  | { outcome: 'waiting'; reason: TickReason; retryAt: Date }
  | { outcome: 'sent'; recipientId: string; outboxKey: string; retryAt: Date }
  | { outcome: 'completed' };
export interface TickDeps {
  campaigns: CampaignRepository;
  dispatch: CampaignDispatchStore;
  recipients: CampaignRecipientStore;
  contacts: ContactNameSource;
  accounts: AccountGate;
  outbox: CampaignOutbox;
  conversations: ConversationFinder;
  pauseGuards: readonly PauseGuard[];
  applyPause: PauseApplier;
  now(): Date;
  rng(): number;
  cfg: CampaignConfig;
}
export async function processCampaignTick(input: { campaignId: string; accountId: string }, deps: TickDeps): Promise<TickResult>;

// src/application/campaigns/ensure-campaign-ticks.ts
export interface EnsureDeps { campaigns: CampaignRepository; dispatch: CampaignDispatchStore; scheduler: TickScheduler; now(): Date; }
export async function ensureCampaignTicks(deps: EnsureDeps): Promise<{ scheduled: number; completed: number }>;
```
- Ordem do *tick*: (1) carregar campanha → `paused` ⇒ `idle paused`; `draft|completed|cancelled` ⇒ `idle campaign_not_running`; `scheduled` com `now < scheduledAt` ⇒ `waiting scheduled_not_due` (retryAt = `scheduledAt`); (2) carregar conta (input `accountId`) → ausente, `purpose !== 'campaigns'` ou `status !== 'connected'` ⇒ `waiting account_unavailable` (retryAt = now + delay); (3) correr `pauseGuards` → motivo ⇒ `applyPause` (actorId `null`) e `idle paused`; (4) `scheduled` devido ⇒ transitar para `running`; (5) `dispatch.skipIneligibleContacts` (contactos sem `marketing_consent` ou com `opted_out_at` ficam `opted_out` — consentimento retirado é não-contactável; usamos o estado `opted_out` em vez de inventar um sexto estado, `docs/01` §6 é esboço) e depois `dispatch.nextPending` nulo ⇒ `dispatch.pendingCount === 0` ? transitar para `completed` (`completed`) : `idle no_pending_recipient`; (6) gates: silêncio ⇒ `waiting quiet_hours` (retryAt = `nextCampaignWindowOpen`), cap diário (`dispatch.countEnqueuedSince(accountId, dayStartInTz) >= effectiveDailyCap`) ⇒ `waiting daily_cap` (retryAt = `nextDayStartInTz`), backlog de conversas ⇒ `waiting conversation_backlog` (retryAt = now + delay); (7) renderizar, `findOrCreateForCampaign`, `outboxKey = 'campaign:{campaignId}:recipient:{recipientId}:step:{step}'`, `outbox.enqueue` (usando **`recipient.accountId`** — nunca o `accountId` vindo do job) e `recipients.markEnqueued` ⇒ `sent` (retryAt = now + `randomDelayMs`).
- Fila: BullMQ queue `campaigns`, job `tick` (`jobId` determinístico acima) e job `ensure` repetível (repeat `every: 60000`, jobId `campaigns-ensure`, registado uma só vez).

- [ ] **Step 1: Escrever os testes falhados**

`tests/unit/campaigns/tick.test.ts` (relógio e rng controlados; casos exatos):

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { processCampaignTick, type TickDeps } from '../../../src/application/campaigns/process-campaign-tick';
import { makeTickDeps } from './fakes';

const CAMP = '00000000-0000-0000-0000-0000000000d1';
const ACC = '00000000-0000-0000-0000-0000000000a1';
const REC = '00000000-0000-0000-0000-0000000000e1';

describe('processCampaignTick', () => {
  it('caminho feliz: envia UMA mensagem e agenda o próximo passo', async () => {
    const d = makeTickDeps({ now: '2026-10-07T10:00:00Z', rng: 0.5, campaignStatus: 'running', accountCreatedAt: '2026-10-04T10:00:00Z', contactName: 'Ana Souza', template: 'Olá {{nome}}!' });
    const r = await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d);
    assert.deepEqual(r, { outcome: 'sent', recipientId: REC, outboxKey: `campaign:${CAMP}:recipient:${REC}:step:1`, retryAt: new Date('2026-10-07T10:00:30Z') });
    assert.equal(d.outbox.enqueue.calls.length, 1); // serialização: um envio por tick/conta
    const enqueueArgs = d.outbox.enqueue.calls[0]!;
    assert.equal(enqueueArgs[0].accountId, ACC);
    assert.equal(enqueueArgs[0].sender, 'campaign');
    assert.equal(enqueueArgs[0].idempotencyKey, `campaign:${CAMP}:recipient:${REC}:step:1`);
    assert.equal(enqueueArgs[0].text, 'Olá Ana Souza!\n\nResponde SAIR para sair desta lista.');
    assert.deepEqual(enqueueArgs[0].scheduledAt, new Date('2026-10-07T10:00:00Z'));
  });

  it('nunca retoma uma campanha em pausa', async () => {
    const d = makeTickDeps({ now: '2026-10-07T10:00:00Z', campaignStatus: 'paused' });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d),
      { outcome: 'idle', reason: 'paused' });
    assert.equal(d.outbox.enqueue.calls.length, 0);
    assert.equal(d.applyPause.apply.calls.length, 0);
  });

  it('agendamento: espera até scheduledAt e depois envia', async () => {
    const future = makeTickDeps({ now: '2026-10-07T10:00:00Z', campaignStatus: 'scheduled', scheduledAt: '2026-10-08T09:00:00Z' });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, future),
      { outcome: 'waiting', reason: 'scheduled_not_due', retryAt: new Date('2026-10-08T09:00:00Z') });
    const due = makeTickDeps({ now: '2026-10-07T10:00:00Z', campaignStatus: 'scheduled', scheduledAt: '2026-10-07T09:00:00Z' });
    assert.equal((await processCampaignTick({ campaignId: CAMP, accountId: ACC }, due)).outcome, 'sent');
    const setStatusArgs = due.campaigns.compareAndSetStatus.calls[0]!;
    assert.equal(setStatusArgs[0], CAMP);
    assert.deepEqual(setStatusArgs[1], ['scheduled']);
    assert.equal(setStatusArgs[2].status, 'running');
  });

  it('janela silenciosa: espera até 08:00 Africa/Luanda', async () => {
    const d = makeTickDeps({ now: '2026-10-07T19:30:00Z', campaignStatus: 'running' });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d),
      { outcome: 'waiting', reason: 'quiet_hours', retryAt: new Date('2026-10-08T07:00:00Z') });
    assert.equal(d.outbox.enqueue.calls.length, 0);
  });

  it('cap diário (ramp da idade da conta): às 30 mensagens espera até à meia-noite local', async () => {
    // conta criada em 2026-10-05T10:00Z → dia 3 → ramp 30
    const d = makeTickDeps({ now: '2026-10-07T10:00:00Z', campaignStatus: 'running', accountCreatedAt: '2026-10-05T10:00:00Z', enqueuedToday: 30 });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d),
      { outcome: 'waiting', reason: 'daily_cap', retryAt: new Date('2026-10-07T23:00:00Z') });
  });

  it('cap da campanha (dailyLimit) é o mínimo entre ele e o ramp', async () => {
    const d = makeTickDeps({ now: '2026-10-07T10:00:00Z', campaignStatus: 'running', accountCreatedAt: '2026-10-04T10:00:00Z', campaignDailyLimit: 10, enqueuedToday: 10 });
    const r = await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d);
    assert.equal(r.outcome, 'waiting');
    assert.equal(r.reason, 'daily_cap');
  });

  it('prioridade das respostas de conversa sobre campanhas', async () => {
    const d = makeTickDeps({ now: '2026-10-07T10:00:00Z', campaignStatus: 'running', pendingConversationCount: 2 });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d),
      { outcome: 'waiting', reason: 'conversation_backlog', retryAt: new Date('2026-10-07T10:00:30Z') });
    assert.equal(d.outbox.enqueue.calls.length, 0);
  });

  it('conta support / desconectada não envia (sem rotação para outra conta)', async () => {
    const support = makeTickDeps({ now: '2026-10-07T10:00:00Z', campaignStatus: 'running', accountPurpose: 'support' });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, support),
      { outcome: 'waiting', reason: 'account_unavailable', retryAt: new Date('2026-10-07T10:00:30Z') });
    assert.equal(support.outbox.enqueue.calls.length, 0);
    const down = makeTickDeps({ now: '2026-10-07T10:00:00Z', campaignStatus: 'running', accountStatus: 'disconnected' });
    assert.equal((await processCampaignTick({ campaignId: CAMP, accountId: ACC }, down)).reason, 'account_unavailable');
  });

  it('contacto sem consentimento ou com opt-out depois da materialização nunca recebe', async () => {
    const d = makeTickDeps({ now: '2026-10-07T10:00:00Z', campaignStatus: 'running', nextPending: null, pendingCount: 0 });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d), { outcome: 'completed' });
    assert.deepEqual(d.dispatch.skipIneligibleContacts.calls[0], [CAMP, new Date('2026-10-07T10:00:00Z')]);
    assert.equal(d.outbox.enqueue.calls.length, 0);
  });

  it('sem destinatários pendentes: conclui a campanha', async () => {
    const d = makeTickDeps({ now: '2026-10-07T10:00:00Z', campaignStatus: 'running', nextPending: null, pendingCount: 0 });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d), { outcome: 'completed' });
    assert.deepEqual(d.campaigns.compareAndSetStatus.calls[0], [CAMP, ['running', 'scheduled'], { status: 'completed' }]);
  });

  it('guardas de pausa correm antes dos gates e pausam com o motivo devolvido', async () => {
    const d = makeTickDeps({ now: '2026-10-07T10:00:00Z', campaignStatus: 'running', guardReason: 'session_down' });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d), { outcome: 'idle', reason: 'paused' });
    assert.deepEqual(d.applyPause.apply.calls[0], [{ campaignId: CAMP, reason: 'session_down', actorId: null, now: new Date('2026-10-07T10:00:00Z') }]);
    assert.equal(d.outbox.enqueue.calls.length, 0);
  });

  it('logs do tick sem telefones E.164 completos (só uuids)', async () => {
    const lines: string[] = [];
    const d = makeTickDeps({ now: '2026-10-07T10:00:00Z', campaignStatus: 'running', logger: (msg: string) => lines.push(msg) });
    await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d);
    assert.doesNotMatch(lines.join('\n'), /\+244\d{9}/);
    assert.ok(lines.join('\n').includes(CAMP));
  });
});
```

`tests/unit/campaigns/ensure-ticks.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ensureCampaignTicks } from '../../../src/application/campaigns/ensure-campaign-ticks';
import { makeEnsureDeps } from './fakes';

describe('ensureCampaignTicks', () => {
  it('agenda um tick por conta com pendentes e não toca em campanhas pausadas', async () => {
    const d = makeEnsureDeps({ campaigns: [
      { id: 'c1', status: 'running', allowedAccountIds: ['a1', 'a2'], pending: { a1: 3, a2: 0 } },
      { id: 'c2', status: 'paused', allowedAccountIds: ['a1'], pending: { a1: 9 } },
      { id: 'c3', status: 'running', allowedAccountIds: ['a1'], pending: { a1: 0 } },
    ]});
    assert.deepEqual(await ensureCampaignTicks(d), { scheduled: 1, completed: 1 });
    assert.equal(d.scheduler.ensureTick.calls.length, 1);
    const ensureArgs = d.scheduler.ensureTick.calls[0]!;
    assert.equal(ensureArgs[0].campaignId, 'c1');
    assert.equal(ensureArgs[0].accountId, 'a1');
    assert.ok(ensureArgs[0].runAt instanceof Date);
    assert.deepEqual(d.campaigns.compareAndSetStatus.calls[0], ['c3', ['running', 'scheduled'], { status: 'completed' }]);
  });
});
```

`tests/integration/campaigns/queue.test.ts` (Redis real): registar o job repetível `ensure` duas vezes → `getRepeatableJobs()` devolve 1 entrada; `ensureTick` duas vezes para a mesma (campanha, conta) → `queue.getJobs(['waiting','delayed'])` tem 1 job com `jobId = campaign:{c}:account:{a}`; entregar o job de *tick* duas vezes ao handler (com stores reais de Postgres e `CampaignOutbox` em memória) → **uma** chamada de efeito na outbox e `campaign_recipients.status = 'sent'`.

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/campaigns/tick.test.ts`
Expected: FAIL — `Cannot find module '../../../src/application/campaigns/process-campaign-tick'`

Run: `npm test -- tests/unit/campaigns/ensure-ticks.test.ts tests/integration/campaigns/queue.test.ts`
Expected: FAIL — módulos inexistentes

- [ ] **Step 3: Implementar ports, casos de uso e adaptador de fila**

Implementar a ordem do *tick* descrita em Interfaces, `ensureCampaignTicks` (campanhas `running|scheduled`: pendentes = 0 ⇒ `compareAndSetStatus → completed`; senão `ensureTick` por conta com pendentes > 0) e o adaptador BullMQ (`campaigns/tick` com `jobId` determinístico, `campaigns/ensure` repetível a cada 60 s registado uma vez, retries com backoff e *dead-letter* conforme `docs/02` §6, payloads só com IDs). O adaptador injeta os ports Drizzle, a outbox da Fase 1, `ConversationFinder`, `now`, `rng` e `cfg` lidos no arranque.

- [ ] **Step 4: Correr e ver passar**

Run: `npm run typecheck && npm test -- tests/unit/campaigns/tick.test.ts tests/unit/campaigns/ensure-ticks.test.ts tests/integration/campaigns/queue.test.ts`
Expected: PASS — 12 + 1 + 3 testes, 0 falhas

- [ ] **Step 5: Commit**

```bash
git add src/ports/campaign-dispatch.ts src/application/campaigns/ src/adapters/queue/campaign-tick.ts src/adapters/db/campaigns.ts tests/unit/campaigns/ tests/integration/campaigns/queue.test.ts
git commit -m "feat: campaign send tick with pacing gates and idempotent enqueue"
```

---

### Task 10: Pausa automática e retoma só humana

**Files:**
- Create: `src/domain/campaigns/auto-pause.ts`
- Create: `src/ports/campaign-stats.ts`
- Create: `src/application/campaigns/reconcile-failures.ts`
- Create: `src/application/campaigns/pause-campaign.ts`
- Create: `src/application/campaigns/resume-campaign.ts`
- Create: `src/adapters/realtime/campaign-alerts.ts`
- Modify: `src/adapters/db/campaigns.ts`
- Modify: `src/adapters/queue/campaign-tick.ts` (registar `pauseGuards = [sessionPauseGuard, volumePauseGuard]` e `applyPause` ligados aos casos de uso)
- Test: `tests/unit/campaigns/auto-pause.test.ts`
- Test: `tests/integration/campaigns/auto-pause.test.ts`

**Interfaces:**
- Consumes: `PauseGuard`, `PauseApplier`, `PauseReason`, `processCampaignTick` (Task 9); `AccountGate` (Task 5); port `Audit` e adaptador realtime da Fase 1 (evento novo `campaign.paused`); `CampaignConfig`.
- Produces:
```ts
// src/domain/campaigns/auto-pause.ts
export interface VolumeWindow {
  /** Últimos `failWindow` resultados CONHECIDOS ('sent' | 'failed'). */
  knownOutcomes: readonly ('sent' | 'failed')[];
  /** Destinatários com opted_out_at entre as últimas `optOutWindow` mensagens enfileiradas desde `since`. */
  optOutsInWindow: number;
}
/** Ordem das regras: failure_rate primeiro, depois opt_out_spike. null = não pausa. */
export function evaluateVolumePause(w: VolumeWindow, cfg: CampaignConfig['pause']): PauseReason | null;

// src/ports/campaign-stats.ts
export interface DeliveryProbe {
  /** Estado da outbox por idempotency_key; 'unknown' NUNCA conta como falha (docs/04 §5). */
  outboxStates(keys: readonly string[]): Promise<ReadonlyMap<string, 'pending' | 'sent' | 'failed' | 'unknown'>>;
}
export interface RecipientStatsStore {
  /** Até 200 linhas 'sent' com outboxKey desta conta, mais recentes primeiro. */
  sentOutboxKeys(accountId: string, limit: number): Promise<readonly { id: string; outboxKey: string }[]>;
  /** status → 'failed' apenas se ainda for 'sent'. */
  markFailed(recipientId: string, at: Date): Promise<void>;
  /** Janela desde `since`: usa campaigns.resumedAt ?? campaigns.createdAt como limiar de enqueued_at. */
  volumeWindow(accountId: string, since: Date, input: { failWindow: number; optOutWindow: number }): Promise<VolumeWindow>;
}
export interface CampaignAlertSink {
  campaignPaused(input: { campaignId: string; accountId: string; reason: PauseReason; auto: boolean; at: Date }): Promise<void>;
}

// src/application/campaigns/reconcile-failures.ts
export type ReconcileFailures =
  (accountId: string, deps: { stats: RecipientStatsStore; probe: DeliveryProbe; now(): Date }) => Promise<number>;

// src/application/campaigns/pause-campaign.ts
export type PauseCampaign = (input: { campaignId: string; accountId: string | null; reason: PauseReason; actorId: string | null; now: Date }) =>
  Promise<{ paused: Campaign }>;
// compareAndSetStatus(['running','scheduled'] → 'paused', pauseReason, pausedAt, pausedBy = actorId);
// se mudou: Audit 'campaign.auto_paused' (actorId null) ou 'campaign.paused'; CampaignAlertSink.campaignPaused só quando automática.
// Exportar também `export const pauseApplier: PauseApplier` (adapta para a assinatura da Task 9).

// src/application/campaigns/resume-campaign.ts
export type ResumeCampaign = (input: { campaignId: string; actorId: string; now: Date }) => Promise<{ campaign: Campaign }>;
// compareAndSetStatus(['paused'] → scheduledAt > now ? 'scheduled' : 'running', resumedBy = actorId, resumedAt = now, pauseReason = null);
// actorId em falta → CampaignError('human_required', 400) — estender `CampaignErrorCode` da Task 5 com 'human_required': a retoma é só por ação humana (docs/04 §7).
// Audit 'campaign.resumed'. NO job não existe nenhum caminho paused → running.

// guardas (registradas na Task 9)
export function sessionPauseGuard(deps: { accounts: AccountGate }): PauseGuard;   // ctx.account.status !== 'connected' → session_down
export function volumePauseGuard(deps: { stats: RecipientStatsStore; probe: DeliveryProbe; cfg: CampaignConfig; reconcile: ReconcileFailures }): PauseGuard;
// volumePauseGuard: since = ctx.campaign.resumedAt ?? ctx.campaign.createdAt; chama reconcile; evaluateVolumePause
```

- [ ] **Step 1: Escrever os testes falhados**

`tests/unit/campaigns/auto-pause.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateVolumePause } from '../../../src/domain/campaigns/auto-pause';

const cfg = { failWindow: 20, failRatio: 0.3, optOutWindow: 50, optOutCount: 5 };
const outcomes = (sent: number, failed: number): ('sent' | 'failed')[] => [
  ...Array.from({ length: sent }, () => 'sent' as const),
  ...Array.from({ length: failed }, () => 'failed' as const),
];

describe('evaluateVolumePause', () => {
  it('pausa a failure_rate com ≥30% de falhas nas últimas 20 mensagens', () => {
    assert.equal(evaluateVolumePause({ knownOutcomes: outcomes(14, 6), optOutsInWindow: 0 }, cfg), 'failure_rate'); // 6/20 = 30%
    assert.equal(evaluateVolumePause({ knownOutcomes: outcomes(15, 5), optOutsInWindow: 0 }, cfg), null);          // 5/20 = 25%
    assert.equal(evaluateVolumePause({ knownOutcomes: outcomes(0, 19), optOutsInWindow: 0 }, cfg), null);          // janela incompleta (<20)
  });

  it('pausa opt_out_spike com ≥5 opt-outs em 50 mensagens, mesmo com janela parcial', () => {
    assert.equal(evaluateVolumePause({ knownOutcomes: outcomes(7, 0), optOutsInWindow: 5 }, cfg), 'opt_out_spike');
    assert.equal(evaluateVolumePause({ knownOutcomes: outcomes(7, 0), optOutsInWindow: 4 }, cfg), null);
  });

  it('falhas avaliadas primeiro quando ambos os limiares falham', () => {
    assert.equal(evaluateVolumePause({ knownOutcomes: outcomes(0, 20), optOutsInWindow: 6 }, cfg), 'failure_rate');
  });
});
```

`tests/integration/campaigns/auto-pause.test.ts` (Postgres real; conta `A1`, campanha `CAMP` em `running`):

```ts
// 1) failure_rate: 20 destinatários enfileirados — 14 'sent' + 6 'sent' cuja outbox está 'failed';
//    probe devolve 'failed' para k15..k20 e 'sent' para k1..k14 → volumePauseGuard pausa
assert.deepEqual(await volumeGuard(ctx), { reason: 'failure_rate' });
const after = await repo.findById(CAMP);
assert.equal(after.status, 'paused');
assert.equal(after.pauseReason, 'failure_rate');
assert.equal(after.pausedBy, null);
assert.ok(audit.calls.map((c: { action: string }) => c.action).includes('campaign.auto_paused'));
const alertCall = alerts.calls[0]!;
assert.equal(alertCall.campaignId, CAMP);
assert.equal(alertCall.reason, 'failure_rate');
assert.equal(alertCall.auto, true);

// 2) 'unknown' nunca vira falha: probe devolve 'unknown' para k15..k20 → reconcile marca 0 → janela 20 sent → null
// 3) opt_out_spike: outra campanha com 12 enfileiradas, 5 com opted_out_at → { reason: 'opt_out_spike' }
// 4) sessão: conta 'disconnected' + campanha running → processCampaignTick com as guardas reais →
//    { outcome: 'idle', reason: 'paused' } e status 'paused'/'session_down'
// 5) retoma reinicia a janela: resumeCampaign({ campaignId: CAMP, actorId: ADMIN, now: T2 }) → running, resumedAt = T2;
//    volumeGuard com enqueuedAt todos anteriores a T2 → null (sem re-pausa imediata)
// 6) retoma é humana: resumeCampaign({ campaignId: CAMP, actorId: undefined as unknown as string, now: T2 })
//    → CampaignError { code: 'human_required', status: 400 };
//    e 3 ticks seguidos depois da pausa → enqueue nunca chamado (já coberto na Task 9)
```

No mesmo ficheiro, o caso 1 e o caso 5 escrevem os `assert` completos (mostrados acima); os casos 2–4 usam os mesmos `assert` estruturados com os valores indicados.

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/campaigns/auto-pause.test.ts`
Expected: FAIL — `Cannot find module '../../../src/domain/campaigns/auto-pause'`

- [ ] **Step 3: Implementar domínio, ports, casos de uso, guardas e alerta**

`evaluateVolumePause`: se `knownOutcomes.length === failWindow` e `failed/failWindow >= failRatio` → `failure_rate`; senão se `optOutsInWindow >= optOutCount` → `opt_out_spike`; senão `null`. Casos de uso com `compareAndSetStatus` condicional (só escreve audit/alerta se a transição mudou algo). Adaptador `campaign-alerts.ts`: `Audit.record` + emit Socket.IO `campaign.paused` pelo adaptador realtime da Fase 1. Guardas como descrito em Interfaces; `volumePauseGuard` chama `reconcileFailures` primeiro e usa `since = resumedAt ?? createdAt` (janela que evita o bloqueio de retoma descrito em Review Focus).

- [ ] **Step 4: Correr e ver passar**

Run: `npm run typecheck && npm test -- tests/unit/campaigns/auto-pause.test.ts tests/integration/campaigns/auto-pause.test.ts`
Expected: PASS — 3 + 6 testes, 0 falhas

- [ ] **Step 5: Commit**

```bash
git add src/domain/campaigns/auto-pause.ts src/ports/campaign-stats.ts src/application/campaigns/ src/adapters/realtime/campaign-alerts.ts src/adapters/db/campaigns.ts src/adapters/queue/campaign-tick.ts tests/unit/campaigns/auto-pause.test.ts tests/integration/campaigns/auto-pause.test.ts
git commit -m "feat: automatic campaign pause with human-only resume"
```

---

### Task 11: API REST de campanhas (RBAC `admin` + `Idempotency-Key`)

**Files:**
- Create: `src/adapters/http/routes/campaigns.ts`
- Modify: arranque HTTP da Fase 1 (registar rotas + schemas OpenAPI)
- Modify: `src/ports/campaign-recipients.ts` (`counts`)
- Modify: `src/adapters/db/campaigns.ts`
- Test: `tests/integration/campaigns/api.test.ts`

**Interfaces:**
- Consumes: `createCampaign` (Task 5), `startCampaign` (Task 6), `pauseCampaign`/`resumeCampaign` (Task 10), guard de sessão/CSRF/`requireRole` e mapper RFC 9457 da Fase 1 (adaptar nomes), helpers de sessão dos testes da Fase 1.
- Produces:
```ts
// src/ports/campaign-recipients.ts ( acrescentado )
/** optedOut = linhas com opted_out_at NOT NULL (pode sobrepor-se a sent/replied). */
counts(campaignId: string): Promise<{ pending: number; sent: number; failed: number; replied: number; optedOut: number }>;

// rotas (todas atrás de sessão + CSRF + requireRole('admin'))
POST   /v1/campaigns            body { name, messageTemplate, allowedAccountIds, dailyLimit }   → 201 { campaign, replayed: false }
POST   /v1/campaigns/:id/start  body { scheduledAt?: string | null }                             → 200 { campaign, recipientsCreated, replayed }
POST   /v1/campaigns/:id/pause  body {}                                                          → 200 { campaign }
POST   /v1/campaigns/:id/resume body {}                                                          → 200 { campaign }
GET    /v1/campaigns/:id                                                                     → 200 { campaign, counts }
GET    /v1/campaigns?limit=20&cursor=...                                                     → 200 { items, nextCursor }
```
- `Idempotency-Key` **obrigatório** em `POST /v1/campaigns` e `POST /v1/campaigns/:id/start` (ausente → 400 problem com `detail` a citar `Idempotency-Key`).
- `pause`: de `running|scheduled` → `paused` com `reason: 'human'`; já `paused` → 409. `resume`: de `paused` → `scheduled|running`; caso contrário → 409. Todos os erros em `application/problem+json`.

- [ ] **Step 1: Escrever o teste falhado**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTestApp } from '../../helpers/http'; // helpers de sessão/CSRF da Fase 1

const A_SUP = '00000000-0000-0000-0000-0000000000a1';
const A_CAMP = '00000000-0000-0000-0000-0000000000a2';
const body = { name: 'Promo Outubro', messageTemplate: 'Olá {{nome}}, temos novidades!', allowedAccountIds: [A_CAMP], dailyLimit: null };

describe('POST /v1/campaigns', () => {
  it('exige sessão e papel admin', async () => {
    const app = await buildTestApp();
    assert.equal((await app.inject({ method: 'POST', url: '/v1/campaigns', payload: body })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/campaigns', payload: body, cookies: { session: app.sessions.agent }, headers: { 'x-csrf-token': app.csrf.agent } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/campaigns', payload: body, cookies: { session: app.sessions.editor }, headers: { 'x-csrf-token': app.csrf.editor } })).statusCode, 403);
  });

  it('recusa conta purpose = support no boundary HTTP (obrigatório)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/v1/campaigns', cookies: { session: app.sessions.admin }, headers: { 'x-csrf-token': app.csrf.admin, 'idempotency-key': 'K1' }, payload: { ...body, allowedAccountIds: [A_SUP] } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().detail, /purpose/);
  });

  it('Idempotency-Key obrigatória: em falta 400, replay 200, corpo diferente 409', async () => {
    const app = await buildTestApp();
    const auth = { cookies: { session: app.sessions.admin }, headers: { 'x-csrf-token': app.csrf.admin } };
    const missing = await app.inject({ method: 'POST', url: '/v1/campaigns', ...auth, payload: body });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().detail, /Idempotency-Key/);

    const first = await app.inject({ method: 'POST', url: '/v1/campaigns', ...auth, headers: { ...auth.headers, 'idempotency-key': 'K1' }, payload: body });
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().replayed, false);

    const replay = await app.inject({ method: 'POST', url: '/v1/campaigns', ...auth, headers: { ...auth.headers, 'idempotency-key': 'K1' }, payload: body });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().replayed, true);
    assert.equal(replay.json().campaign.id, first.json().campaign.id);

    const conflict = await app.inject({ method: 'POST', url: '/v1/campaigns', ...auth, headers: { ...auth.headers, 'idempotency-key': 'K1' }, payload: { ...body, name: 'Outro' } });
    assert.equal(conflict.statusCode, 409);
    assert.match(conflict.headers['content-type'], /application\/problem\+json/);
  });
});

describe('ciclo start/pause/resume/estados', () => {
  it('start materializa; pause/resume mudam estado com 409 no estado errado; GET devolve contagens', async () => {
    // start com 'idempotency-key': 'S1' → 200 { recipientsCreated: 3, replayed: false }
    // replay de S1 → 200 { replayed: true, recipientsCreated: 0 }
    // start de novo com 'S2' → 409
    // pause → 200 { campaign: { status: 'paused', pauseReason: 'human' } }; pause outra vez → 409
    // resume → 200 { campaign: { status: 'running' } }; resume outra vez → 409
    // GET /v1/campaigns/:id → 200 counts { pending: 0, sent: 2, failed: 1, replied: 1, optedOut: 1 }
    // GET /v1/campaigns?limit=2 → 2 itens + nextCursor; 2.ª página → 1 item
    // audit_log tem campaign.created, campaign.started, campaign.paused, campaign.resumed
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/integration/campaigns/api.test.ts`
Expected: FAIL — rota `POST /v1/campaigns` devolve 404

- [ ] **Step 3: Implementar as rotas**

Fastify `src/adapters/http/routes/campaigns.ts`: schemas de entrada zod (mesmos limites da Task 5; `dailyLimit` null ou ≥ 1; `scheduledAt` ISO válido), conversão de erros `CampaignError` para problem+json no mapper único da Fase 1, `Idempotency-Key` lida do cabeçalho e passada aos casos de uso, `requireRole('admin')` em todas as rotas, listagem com cursor. Nenhuma regra de negócio no controlador — só validar, chamar o caso de uso e serializar (`docs/02` §8). Registar as rotas no arranque HTTP para o OpenAPI gerado do código.

- [ ] **Step 4: Correr e ver passar**

Run: `npm run typecheck && npm run lint && npm test -- tests/integration/campaigns/api.test.ts`
Expected: PASS — 4 testes, 0 falhas

- [ ] **Step 5: Commit**

```bash
git add src/adapters/http/ src/ports/campaign-recipients.ts src/adapters/db/campaigns.ts tests/integration/campaigns/api.test.ts
git commit -m "feat: campaigns REST API with admin RBAC and idempotency"
```

---

### Task 12: Jornada ponta-a-ponta, README e suite completa

**Files:**
- Create: `src/modules/campaigns/README.md`
- Test: `tests/integration/campaigns/journey.test.ts`

**Interfaces:**
- Consumes: tudo das Tasks 1–11 + app de teste da Fase 1 (`buildTestApp`) e adaptador real de outbox da Fase 1.
- Produces: nenhuma interface nova. `src/modules/campaigns/README.md` com: responsabilidade, estados de `campaigns`/`campaign_recipients`, chaves env com defaults, ports públicos, comandos de teste e as proibições (`purpose = support`, sem rotação, sem contornar limites).

- [ ] **Step 1: Escrever o teste falhado**

`tests/integration/campaigns/journey.test.ts` (Postgres + Redis reais, relógio controlado; contactos: `CT1`/`CT4`/`CT5` elegíveis, `CT2` com opt-out, `CT3` sem consentimento; conta `A1` `campaigns`/`connected`):

```ts
it('jornada completa: criar → iniciar → enviar → opt-out → responder → pausar → retomar → concluir', async () => {
  // 1. POST /v1/campaigns (Idempotency-Key 'K1') → 201; replay 'K1' → 200 mesmo id
  // 2. POST /:id/start ('S1') → 200 recipientsCreated = 3 (CT2 e CT3 excluídos pela segmentação)
  // 3. tick(ct1) → 1 linha na outbox (sender 'campaign'), r1 = 'sent', conversa criada para (A1, CT1)
  // 4. webhook/servidor de entrada: 'SAIR' de CT1 → contacts.opted_out_at preenchido, r1.opted_out_at preenchido
  // 5. tick(ct4) → envia para CT4; nunca mais para CT1 (conjunto elegível e estados fechados)
  // 6. entrada: 'Muito obrigado!' de CT4 → r(CT4) = 'replied'
  // 7. tick(ct5) → envia para CT5; tick seguinte → { outcome: 'completed' } e status 'completed'
  // 8. GET /v1/campaigns/:id → counts { pending: 0, sent: 2, failed: 0, replied: 1, optedOut: 1 }
  // 9. admin pause → 200; 3 ticks → nenhuma linha nova na outbox; admin resume → 200
  // 10. audit_log contém campaign.created, campaign.started, campaign.paused, campaign.resumed
  // 11. nenhum send direto: o mock do MessagingProvider tem 0 chamadas; todas as mensagens passam pela outbox
});
```

Cada passo é um `assert` concreto no ficheiro (valores acima), com o relógio fixado e `rng` devolvendo `0.5`.

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/integration/campaigns/journey.test.ts`
Expected: FAIL — dependências das Tasks anteriores em falta (falha na compilação/import)

- [ ] **Step 3: Implementar a jornada e o README**

Escrever a jornada como teste de integração real (sem mocks de DB/fila; só o `MessagingProvider` é o mock fiel da Fase 1). Escrever `src/modules/campaigns/README.md` (obrigatório por `docs/02` §13).

- [ ] **Step 4: Correr a suite completa e colar a saída no relatório**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS — 0 falhas; registar a saída completa como evidência (lint limpo, typecheck limpo, total de testes)

- [ ] **Step 5: Commit**

```bash
git add src/modules/campaigns/README.md tests/integration/campaigns/journey.test.ts
git commit -m "test: add campaigns end-to-end journey and module README"
```

---

## Gate de fim de fase

`docs/01` §8, Fase 4: *"Entidades, segmentação, consentimento e opt-out, limites por conta, janelas horárias, pausa automática. Contas com `purpose = support` nunca são usadas em campanhas. **Gate:** primeira campanha real, pequena."*

Evidência automatizada (exigida por `AGENTS.md` antes do gate):

| Critério da spec | Tarefa e teste |
|---|---|
| Entidades `campaigns`/`campaign_recipients`, estados por destinatário | Task 2 (`schema.test.ts`) |
| Segmentação só com consentimento e sem opt-out | Task 6 (`segmentation.test.ts`) |
| Conta `purpose = support` recusada | Task 5 (`create-campaign.test.ts`) e Task 11 (`api.test.ts`) |
| `WA_CAMPAIGN_DELAY_MS` 15000–45000, ramp 30/60/100+config, `WA_QUIET_HOURS` 20:00–08:00 Africa/Luanda | Tasks 1 e 3 (`config.test.ts`, `rhythm.test.ts`) e Task 9 (`tick.test.ts`) |
| Serialização por conta e prioridade das conversas | Task 9 (`tick.test.ts`, `queue.test.ts`) |
| Pausa automática nos três cenários, retoma só humana, alerta | Task 10 (`auto-pause.test.ts`) |
| Opt-out imediato ("SAIR" e variantes) fora de todas as campanhas | Tasks 7 e 8 (`opt-out.test.ts`, `inbound-effects.test.ts`) |
| Mensagem com forma de sair; variáveis validadas no boundary | Tasks 4 e 11 |
| Idempotência por `campaign_recipients` e `Idempotency-Key` | Tasks 2, 9 e 11 |
| RBAC `admin` + `audit_log` | Task 11 |
| Sem rotação de números, sem contornar limites | Task 9 (`account_unavailable`, cap efetivo, atribuição fixa na materialização) |

**Gate humano (obrigatório, não automatizável):** a **primeira campanha real, pequena**, só depois de autorização explícita do dono do produto (`AGENTS.md`: "ativar qualquer campanha em produção" e "primeiro envio real" são gates de revisão humana). Nesta fase o agente entrega o código, os testes e a evidência; o envio real a números que não sejam de teste fica à espera do aval humano, com número de testes em staging primeiro (`docs/03` §10).
