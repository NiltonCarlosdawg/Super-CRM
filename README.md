# CRM WhatsApp — MilVendas

CRM **interno** da MilVendas para gerir conversas de WhatsApp com leads e clientes: várias contas num só lugar, campanhas com limites, e uma IA que responde, qualifica leads, faz follow-ups e **passa a um humano** quando deve.

> **Estado:** planeamento concluído. A Fase 0 (fundações e auditoria do WA-AKG) ainda não começou. Este repositório contém a documentação do plano e código de referência já testado.

## Como funciona

```
Painel ◄── REST / Socket.IO ──► Backend do CRM ──► PostgreSQL (+pgvector), Redis/BullMQ
                                   │      │
                                   │      └──► API do LLM (via AIProvider)
                                   ▼
                           Adaptador WA-AKG ──► WA-AKG (serviço separado, rede privada) ──► WhatsApp
```

- **O CRM é o dono dos dados e das regras.** Contactos, leads, conversas, campanhas, conhecimento e decisões vivem na base do CRM.
- **O WA-AKG é só transporte** do WhatsApp (sessões, envio, receção). Não tem lógica de negócio e nunca fica exposto à internet.
- **A IA classifica e responde. O código decide** handoff, bloqueio e registo.
- Para "ensinar" a IA, edita-se **conhecimento** (catálogo, documentos, regras). Não há treino do modelo.

## Documentação

Lê por esta ordem. O `AGENTS.md` é o que o opencode carrega em cada sessão.

| Ficheiro | Conteúdo |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Regras permanentes do agente: missão, regras inegociáveis, fluxo de trabalho, definição de pronto, gates |
| [`docs/01-contexto-e-plano.md`](docs/01-contexto-e-plano.md) | Contexto, decisões, decisões em aberto, arquitetura, entidades, fases e critérios de aceitação |
| [`docs/02-regras-backend.md`](docs/02-regras-backend.md) | Regras de código e boas práticas de backend |
| [`docs/03-seguranca.md`](docs/03-seguranca.md) | Segurança e privacidade |
| [`docs/04-integracao-wa-akg.md`](docs/04-integracao-wa-akg.md) | Papel e limites do WA-AKG, auditoria, contrato do adaptador, política de envio |
| [`docs/05-ia-conhecimento-handoff.md`](docs/05-ia-conhecimento-handoff.md) | IA, conhecimento, gatilhos de handoff, follow-ups, avaliação |
| [`docs/adr/`](docs/adr/0000-template.md) | Registo de decisões de arquitetura (modelo incluído) |

## Código de referência (`reference/`)

Já escrito e testado. É a fonte de verdade destes módulos. Só muda com ADR aprovado.

| Ficheiro | Conteúdo |
|---|---|
| `knowledge.schema.ts` | Schema Drizzle do módulo de conhecimento (12 tabelas, pgvector, índice HNSW) e `searchChunks()` |
| `handoff-triggers.seed.ts` | 16 gatilhos de handoff e seed idempotente |
| `ai-provider.ts` | Contrato `AIProvider` e `Ports` (só tipos) |
| `orchestrator.ts` | `handleInbound()`: decide o que fazer com cada mensagem |
| `orchestrator.test.ts` | 17 testes com portas em memória |
| `handoff-scenarios.ts` | 72 cenários sintéticos e `evaluate()` |
| `keyword-safety-net.ts` | Regras determinísticas para `human_requested` e `purchase_intent` |

Correr os testes de referência (numa pasta com Node.js):

```bash
npm i -D drizzle-orm tsx typescript @types/node
npx tsx --test reference/orchestrator.test.ts
```

Resultado esperado: `17 pass, 0 fail`. Testado com `drizzle-orm` 0.45.3 e `tsx` 4.23.

Os testes cobrem a lógica de decisão com um fornecedor de IA **simulado**. Não testam Postgres, Redis nem a qualidade das respostas de um modelo real.

## Como começar com o opencode

1. **Coloca este pacote na raiz do repositório** (`AGENTS.md`, `docs/`, `reference/`).
2. **Fecha as decisões em aberto** que bloqueiam o arranque (lista completa em `docs/01`, secção 4). Sugestão de quando cada uma é necessária:

   | Decisão | Necessária até |
   |---|---|
   | A1 Framework HTTP | Início da Fase 0 |
   | A5 Topologia de deploy | Auditoria do WA-AKG (Fase 0) |
   | A2 Autenticação do painel | Fase 1 |
   | A3 Modelo de LLM, A4 embeddings | Fase 2 e 3 |
   | A6 a A10 (handoffs, desconto, qualificação, ciclo das lacunas, devolver à IA) | Fase 3 |
   | A11 Base legal para enviar dados a um LLM externo | Antes de enviar qualquer conversa a um LLM |

3. **Começa pela Fase 0 e só por ela.** Prompt inicial sugerido:

   > Lê `AGENTS.md` e `docs/01` a `docs/05`. Executa **apenas a Fase 0**: repositório, CI, Docker Compose com Postgres+pgvector e Redis, configuração validada, integração dos ficheiros de `reference/` com os seus testes a passar, e a **auditoria só de leitura do WA-AKG** conforme `docs/04`, secção 3. Não escrevas o adaptador nem alteres o código do WA-AKG. Preenche a secção "Comandos" do `AGENTS.md`. No fim, entrega o relatório com evidência e **pára no gate**.

4. **Revê em cada gate.** O agente pára e espera pela tua aprovação.

## Gates (aprovação humana obrigatória)

1. Auditoria do WA-AKG e schema base (fim da Fase 0).
2. Primeiro envio real de WhatsApp, só para número de teste.
3. Primeira campanha real.
4. IA em modo autónomo (`ai_active`) em conversas reais.
5. Qualquer alteração ao código do WA-AKG.
6. Envio de dados de clientes a um serviço externo novo.

## Fases

| Fase | Conteúdo | Estado |
|---|---|---|
| 0 | Fundações e auditoria do WA-AKG | ☐ |
| 1 | Núcleo e WhatsApp (autenticação, adaptador, outbox, webhooks, contas) | ☐ |
| 2 | Conhecimento (CRUD, publicação, embeddings, lacunas, chat de teste) | ☐ |
| 3 | IA e handoff (`AIProvider` real, avaliação, modo sugestão) | ☐ |
| 4 | Campanhas (consentimento, opt-out, limites, pausa automática) | ☐ |
| 5 | Follow-ups e endurecimento | ☐ |

Critérios de aceitação de cada fase: `docs/01`, secção 8.

## Avisos importantes

- **O Baileys não é a API oficial do WhatsApp** e o seu uso viola os termos do WhatsApp. Há risco de banimento de números, sobretudo com envios em massa. O plano mitiga mas não elimina esse risco. Contas de campanha e de atendimento usam números diferentes.
- **Dados pessoais.** Angola tem a Lei n.º 22/11 de proteção de dados pessoais (fiscalizada pela APD). Consentimento, notificação, retenção, direitos dos titulares e envio de dados para fora do país têm de ser validados com um jurista antes de produção. Isto não é aconselhamento jurídico.
- **Conversas existentes.** As conversas de WhatsApp que a empresa tem **não têm permissão de uso** e não podem entrar em testes, prompts nem treino. Só cenários sintéticos.

## Licenças e responsáveis

- WA-AKG (origem do fork): MIT, `github.com/mrifqidaffaaditya/WA-AKG`. Manter a atribuição.
- Licença do código deste repositório: a definir (uso interno).
- Dono do produto: (preencher). Responsável técnico: (preencher).
