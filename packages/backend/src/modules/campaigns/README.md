# Módulo de campanhas (Fase 4)

Campanhas de WhatsApp com segmentação por consentimento, envio faseado pela
outbox + fila, pausa automática e retoma **só humana**. Nenhuma mensagem sai
diretamente: o tick escreve na outbox da Fase 1 e o worker de envio é a única
saída (`docs/04 §7`). Toda a leitura/escrita é scoped por tenant.

## Responsabilidade

- Criar/iniciar/pausar/retomar campanhas (API `/v1/campaigns`, só `admin`).
- Materializar destinatários elegíveis (`marketing_consent = true` e sem
  `opted_out_at`) no início, de forma idempotente.
- Serializar um envio por (campanha, conta) por tick, com atraso aleatório,
  ramp por idade da conta, janela silenciosa, cap diário e backlog de conversas.
- Pausar sozinho quando a sessão cai, a taxa de falhas sobe ou há um pico de
  opt-outs; **nunca** retomar sozinho.
- Aplicar opt-out e "respondeu" a partir de mensagens de entrada.

## Estados

`campaigns.status`:

```
draft ──start──▶ scheduled ──(hora)──▶ running ──(sem pendentes)──▶ completed
draft ──start──▶ running
running|scheduled ──pause (humano|auto)──▶ paused ──resume (humano)──▶ running|scheduled
```

`paused` nunca é retomado por um job. `cancelled` existe no enum e não é
produzido pelo fluxo atual.

`campaign_recipients.status`: `pending → sent | failed`, `sent → replied`,
`pending → opted_out`. As linhas já enviadas/replied/failed podem ganhar
`opted_out_at` sem perder o estado (as contagens contam `opted_out` à parte).

## Configuração (`loadCampaignConfig`)

| Chave | Default |
|---|---|
| `WA_CAMPAIGN_DELAY_MS` | `15000-45000` |
| `WA_CAMPAIGN_RAMP` | `1-3:30,4-7:60,8-14:100,default:150` |
| `WA_QUIET_HOURS` | `20:00-08:00` (Africa/Luanda, fixo) |
| `CAMPAIGN_OPTOUT_KEYWORDS` | `sair` |
| `CAMPAIGN_OPT_OUT_FOOTER` | `Responde SAIR para sair desta lista.` |
| `CAMPAIGN_FAIL_WINDOW` | `20` |
| `CAMPAIGN_FAIL_RATIO` | `0.30` |
| `CAMPAIGN_OPTOUT_WINDOW` | `50` |
| `CAMPAIGN_OPTOUT_COUNT` | `5` |

Inválidas falham no arranque (`CampaignConfigError`), sem ecoar o valor.

## Ports públicos

- `CampaignRepository`, `AccountGate` (`ports/campaigns.ts`)
- `ContactAudience` (`ports/campaign-audience.ts`)
- `CampaignRecipientStore` (`ports/campaign-recipients.ts`)
- `CampaignDispatchStore`, `ContactNameSource`, `ConversationFinder`,
  `TickScheduler`, `PauseGuard`, `PauseApplier`, `CampaignOutbox`
  (`ports/campaign-dispatch.ts`)
- `DeliveryProbe`, `RecipientStatsStore`, `CampaignAlertSink`
  (`ports/campaign-stats.ts`)

Casos de uso em `application/campaigns/`; regras puras em `domain/campaigns/`;
adaptadores Drizzle em `adapters/db/campaigns.ts`; fila em
`adapters/queue/campaign-tick.ts`; rotas em
`adapters/http/routes/campaigns.ts`.

## Comandos

```bash
npm test                                              # unitários
npx tsx --test --test-concurrency=1 tests/integration/campaigns/*.test.ts
npm run test:integration                              # suite completa (Docker)
```

## Proibições

- Contas com `purpose = 'support'` nunca entram em campanhas (recusadas na
  criação, no início e no tick).
- Sem rotação de números, sem contornar limites, sem "anti-ban" agressivo.
- Nenhum canal envia diretamente: só `outbox_messages` + worker.
- A IA não decide pausa, retoma, bloqueio ou lacunas — o orquestrador/tick
  decide e a retoma é sempre de um humano autenticado.
- Nunca usar conversas reais em testes, prompts ou fixtures.
