# 01 — Contexto e plano

## 1. Objetivo

CRM **interno** da MilVendas Lda para gerir conversas de WhatsApp com leads e clientes:

- várias contas de WhatsApp controladas num único lugar;
- campanhas e envios em massa;
- IA integrada que ajuda em tudo, responde automaticamente, qualifica e faz follow-ups nos leads;
- a IA conduz conversas completas até o lead decidir comprar. Nesse momento, ou em qualquer situação que exija intervenção humana, **notifica o painel e um humano assume a conversa**.

É para uso interno. Não é um produto multi-tenant para vender a terceiros, por isso não há isolamento por organização (pode vir no futuro).

## 2. Linhas de negócio

| Slug | O que vende | O que é "fechar" (hipótese a confirmar) |
|---|---|---|
| `software` | Produtos de software | Escolher plano e pedir demo ou compra |
| `custom` | Soluções personalizadas | Levantamento de requisitos e pedido de proposta. A IA qualifica, o humano conduz. Nunca dá preço nem prazo |
| `telecom` | Serviços de telecomunicações | Escolher serviço e agendar instalação. Avarias de clientes existentes são suporte, não vendas |
| `cctv` | Montagem de câmaras CCTV | Pedido de orçamento e visita técnica. Não há preço final sem visita |

Em `custom` e `cctv` quase nunca se fecha só no chat. O objetivo da IA aí é **qualificar bem e passar o lead pronto**.

## 3. Decisões tomadas

| # | Decisão | Detalhe |
|---|---|---|
| D1 | CRM interno da MilVendas | Sem multi-tenant por agora |
| D2 | **Base própria no centro; serviços externos como serviços separados** | O WA-AKG é o primeiro. Virão outros serviços/APIs que o dono do produto apresentará |
| D3 | WA-AKG como serviço separado, acedido só por API e webhooks | Nunca fork-and-embed. O CRM tem a sua própria base de dados |
| D4 | Modelo de dados do CRM neutro e próprio | Nenhum serviço externo dita o schema |
| D5 | Um adaptador por serviço externo | `MessagingProvider`, `AIProvider`. Trocar um serviço só mexe no adaptador |
| D6 | PostgreSQL + **Drizzle ORM** (não Prisma) | Com pgvector para pesquisa semântica |
| D7 | Redis + BullMQ para filas | Envios, jobs de embeddings, follow-ups |
| D8 | Socket.IO para eventos em tempo real ao painel | Handoffs, mensagens novas, estado das contas |
| D9 | "Ensinar a IA" = **editar conhecimento** (RAG + catálogo estruturado), não treinar o modelo | Atualizações valem na hora |
| D10 | **Sem fine-tuning agora** | Há ~20 conversas e **não há permissão** para as usar. LlamaFactory fica para uma fase futura, com dados recolhidos com consentimento |
| D11 | A IA classifica e responde; o **orquestrador decide** handoff, bloqueio, lacunas e registo | Determinístico e testável |
| D12 | Handoff por gatilhos configuráveis, com ação `handoff_now`, `handoff_when_qualified` ou `flag_only` | 16 gatilhos de arranque em `reference/handoff-triggers.seed.ts` |
| D13 | Arranque da IA em modo **sugestão** (`ai_suggest`): um humano aprova cada resposta | Só passa a `ai_active` nos temas de baixo risco depois de medir (gate) |
| D14 | Ao passar a humano, a mensagem enviada é **fixa e configurável**, não a do modelo | A IA diz que é um assistente virtual e não promete nada |
| D15 | A IA nunca finge ser humana | Princípio de honestidade e consentimento |
| D16 | Preços, disponibilidade e características vêm do catálogo por ferramenta | Nunca de texto solto |
| D17 | Cenários de teste sintéticos escritos à mão como conjunto de avaliação | `reference/handoff-scenarios.ts` (72 cenários) |
| D18 | O desenvolvimento é feito por agente (opencode) com gates de revisão humana | Ver secção 8 e `AGENTS.md` |

## 4. Decisões (A1–A11)

**Todas fechadas a 2026-10-07** — fonte de verdade em `docs/06-decisoes-fechadas-a1-a11.md`,
com ADRs em `docs/adr/0001` a `0004`. Resumo:

| # | Decisão | ADR |
|---|---|---|
| A1 | Node LTS + Fastify | 0001 |
| A2 | Sessões server-side + TOTP para `admin` | 0001 |
| A3 | LLM de API externa, escolhido por `evaluate()` | 0002 |
| A4 | Embeddings locais `multilingual-e5-small` (`vector(384)`) | 0002 |
| A5 | cPanel partilhado sem Docker; planos B para pgvector/Redis | 0001 |
| A6 | Horário configurável; IA fora de horas até handoff aceite; SLA 15 min/2 h | 0003 |
| A7 | `discount_limit` percentual, validado pelo adaptador | 0003 |
| A8 | Campos de qualificação dos docs como seed | 0004 |
| A9 | Lacuna preenchida → sugestão de resposta com aprovação | 0004 |
| A10 | Handoff resolvido/botão manual → devolve à IA | 0003 |
| A11 | Gate de produção + `redactForLLM` sempre ativo | 0002 |

Novas pendências factuais (não de decisão): verificações do cPanel (pgvector, Redis,
websockets, RAM) em `docs/06`, secção A5.

## 5. Arquitetura

```
                        ┌──────────────────────────────────────────┐
  Painel (fora de       │              BACKEND DO CRM              │
  âmbito) ◄─ REST ─────►│                                          │
          ◄─ Socket.IO ─│  API HTTP  ──►  Casos de uso (application)│
                        │                    │            │        │
                        │              Orquestrador   Campanhas /  │
                        │              (IA + gatilhos) Follow-ups  │
                        │                    │            │        │
                        │   Ports: MessagingProvider  AIProvider   │
                        │          Knowledge  Handoff  Audit       │
                        └───────┬────────────┬──────────┬─────────┘
                                │            │          │
              PostgreSQL+pgvector│     Redis/BullMQ     │ HTTPS
              (base própria)     │   (fila + outbox)    │
                                ▼                       ▼
                     ┌────────────────────┐     ┌───────────────┐
                     │  Adaptador WA-AKG  │     │ API do LLM    │
                     └─────────┬──────────┘     └───────────────┘
                               │ REST + webhooks (rede privada, API key, assinatura)
                               ▼
                     ┌────────────────────┐
                     │   WA-AKG (fork)    │──► WhatsApp (via Baileys)
                     │ sessões, QR, envio │
                     └────────────────────┘
```

### Responsabilidades

| Componente | Responsável por | NÃO é responsável por |
|---|---|---|
| **Backend do CRM** | Dados de negócio (contactos, leads, conversas, campanhas, conhecimento), regras, IA, handoff, filas, auditoria, API para o painel | Falar com o protocolo do WhatsApp |
| **WA-AKG** | Sessões WhatsApp (QR/ligação), receber e enviar mensagens, emitir eventos | Qualquer lógica de negócio, IA, campanhas, leads, CRM |
| **Adaptador WA-AKG** | Traduzir entre o contrato interno e a API do WA-AKG, verificar webhooks | Decidir quando ou quanto enviar |
| **Orquestrador** | Decidir o que fazer com cada mensagem de entrada | Gerar texto (é a IA) |
| **AIProvider** | Gerar resposta e classificar a mensagem | Decidir handoff, bloqueio ou registo |

## 6. Entidades da base (esboço)

O agente desenha o schema Drizzle a partir deste esboço e submete-o ao **gate de schema**. O módulo de conhecimento já está definido em `reference/knowledge.schema.ts`.

- `users`: equipa interna. `role` (`admin`, `editor`, `agent`), `active`, hash de palavra-passe.
- `whatsapp_accounts`: `label`, `phone_e164` (único), `provider` (`wa-akg`), `provider_session_id`, `status` (`connecting`, `connected`, `disconnected`, `suspected_ban`), **`purpose`** (`support`, `sales`, `campaigns`), limites diários.
- `contacts`: `phone_e164` (único), nome, **`marketing_consent`** (booleano + `consent_at` + `consent_source`), `opted_out_at`.
- `leads`: `contact_id`, `line`, `stage`, `owner_id`, `qualification` (jsonb), estado.
- `conversations`: `account_id`, `contact_id`, `lead_id`, `line`, **`ai_mode`** (`ai_active`, `ai_suggest`, `human_only`), `miss_streak`, `last_message_at`.
- `messages`: `conversation_id`, `direction`, `sender` (`customer`, `ai`, `human`, `campaign`), tipo, corpo, `provider_message_id` (único por conta), estado (`queued`, `sent`, `delivered`, `read`, `failed`).
- `inbound_events`: caixa de entrada de webhooks. `provider_event_id` único, payload, `received_at`, `processed_at`. Garante idempotência.
- `outbox_messages`: mensagens a enviar. `idempotency_key` único, `scheduled_at`, tentativas, erro, estado.
- `campaigns` e `campaign_recipients`: modelo de mensagem com variáveis, contas permitidas, limites, estado por destinatário (enviado, falhou, respondeu, opt-out).
- `followup_sequences`, `followup_steps`, `followup_runs`: ver `docs/05`.
- `audit_log`: quem fez o quê e quando (ações humanas e da IA).
- Módulo de conhecimento: `business_lines`, `catalog_items`, `knowledge_docs`, `knowledge_chunks`, `rules`, `qualification_questions`, `handoff_triggers`, `handoffs`, `knowledge_gaps`, `knowledge_suggestions`, `knowledge_revisions`, `answer_traces`.

Conceitos: **Contact** é a pessoa/número. **Lead** é uma oportunidade numa linha de negócio. **Conversation** é o fio de mensagens entre uma conta WhatsApp e um contacto.

## 7. Fluxos principais

**Mensagem de entrada**: webhook do WA-AKG → verificação de assinatura → grava em `inbound_events` (idempotente) → job → guarda a mensagem → `handleInbound` (orquestrador) → resposta/handoff → resposta vai para a `outbox` → fila envia com limites → evento Socket.IO ao painel.

**Handoff**: gatilho dispara → `handoffs` criado (resumo da IA, estado do lead, prioridade) → conversa passa a `human_only` → mensagem fixa ao cliente → notificação ao painel → humano aceita e resolve.

**Campanha**: criar → selecionar destinatários com consentimento e sem opt-out → agendar → job envia com atrasos aleatórios e limites por conta → registar estado por destinatário → pausa automática se houver sinais de problema (`docs/04`).

**Conhecimento**: editar item → publicar (revisão guardada) → job gera chunks e embeddings → só chunks de itens publicados e válidos ficam ativos.

## 8. Fases e critérios de aceitação

Cada critério tem de ser **demonstrado** com testes ou saída de comandos.

### Fase 0 — Fundações e auditoria (sem WhatsApp real)
- Repositório, CI (lint, typecheck, testes), Docker Compose com Postgres+pgvector e Redis.
- Configuração validada por esquema. Logging estruturado. Estrutura de pastas de `docs/02`.
- Ficheiros de `reference/` integrados e a passar os seus testes (17 testes do orquestrador).
- **Auditoria do WA-AKG (só leitura)** conforme `docs/04`, secção Auditoria. Entrega: `docs/wa-akg-audit.md` com evidências.
- Secção "Comandos" do `AGENTS.md` preenchida.
- **Gate:** aprovação da auditoria e do schema base.

### Fase 1 — Núcleo e WhatsApp
- Autenticação e RBAC do painel.
- Schema base aplicado por migrações numa base vazia.
- Adaptador WA-AKG com testes de contrato contra um mock fiel ao comportamento auditado.
- Webhooks: verificação de assinatura, caixa de entrada idempotente (testado com o mesmo evento 2 vezes).
- Outbox + fila de envio com atrasos e limites por conta.
- Gestão de contas WhatsApp (criar sessão, QR, estado, desligar).
- API REST e eventos Socket.IO para conversas e mensagens.
- **Gate:** primeiro envio real, só para número de teste.

### Fase 2 — Conhecimento
- CRUD do catálogo, documentos, regras, perguntas de qualificação e gatilhos, com papéis (`editor`, `admin`).
- Publicação com histórico de versões e reversão.
- Job de chunking e embeddings. Pesquisa semântica só em itens publicados e válidos.
- Registo de lacunas e fila de sugestões a partir de correções humanas.
- Chat de teste (`isTest`) que mostra as fontes usadas. Não gera handoffs nem lacunas.
- Alertas de itens por rever (`reviewed_at` + `review_every_days`).

### Fase 3 — IA e handoff
- Implementação real do `AIProvider` (`docs/05`).
- Orquestrador ligado às portas reais. Handoff, bloqueio, notificação ao painel.
- `evaluate()` contra os 72 cenários com relatório por gatilho. Metas de qualidade definidas pelo dono do produto antes do gate.
- Modo `ai_suggest` primeiro. **Gate:** só passa a `ai_active` com autorização.

### Fase 4 — Campanhas
- Entidades, segmentação, consentimento e opt-out, limites por conta, janelas horárias, pausa automática.
- Contas com `purpose = support` nunca são usadas em campanhas.
- **Gate:** primeira campanha real, pequena.

### Fase 5 — Follow-ups e endurecimento
- Sequências de follow-up com condições de paragem (`docs/05`).
- Observabilidade (métricas, alertas), backups testados, retenção e apagamento de dados, revisão de segurança.

## 9. Ficheiros de referência (`reference/`)

Já escritos e testados (`tsc` limpo, 17 testes a passar, mutações detetadas):

| Ficheiro | Conteúdo |
|---|---|
| `knowledge.schema.ts` | Schema Drizzle do módulo de conhecimento (12 tabelas, pgvector, HNSW) e `searchChunks()` |
| `handoff-triggers.seed.ts` | 16 gatilhos de arranque (8 globais + 8 por linha) e seed idempotente |
| `ai-provider.ts` | Contrato `AIProvider` e `Ports` (só tipos) |
| `orchestrator.ts` | `handleInbound()`: decisão por mensagem |
| `orchestrator.test.ts` | 17 testes com portas em memória |
| `handoff-scenarios.ts` | 72 cenários sintéticos e `evaluate()` |
| `keyword-safety-net.ts` | Regras determinísticas para `human_requested` e `purchase_intent` |

Pré-requisito de base de dados: `CREATE EXTENSION IF NOT EXISTS vector;` como migração SQL personalizada, antes das tabelas.

## 10. Riscos conhecidos

1. **O Baileys não é a API oficial do WhatsApp.** Viola os termos do WhatsApp. Há risco de banimento de números, sobretudo com envios em massa, e o protocolo pode mudar e quebrar a ligação. Mitigações em `docs/04`.
2. **Higiene do WA-AKG:** o repositório tem ficheiros de logs e testes soltos na raiz, uma pasta `patches/`, inconsistência de versão do Next.js e um único mantenedor. Tudo isto vem da leitura do repo e **tem de ser verificado** na auditoria.
3. **Dados pessoais e LLM externo:** enviar conversas a um serviço fora de Angola tem implicações legais (ver `docs/03`).
4. **Autonomia da IA:** ver D13 e os gates.

## 11. Glossário

- **Handoff:** passagem de uma conversa da IA para um humano.
- **Gatilho:** regra que reconhece uma situação que pede intervenção (reclamação, pedido de humano, intenção de compra...).
- **Lacuna:** pergunta a que a IA não soube responder por falta de fonte.
- **RAG:** a IA consulta conhecimento publicado antes de responder.
- **Outbox:** tabela de mensagens por enviar, processada por uma fila. Evita perder ou duplicar envios.
- **ADR:** registo curto de uma decisão de arquitetura.
