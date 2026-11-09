# Plano — Frontend completo: campanhas (Fase 4), handoffs/rascunhos (Fase 3) e conhecimento (Fase 2)

Data: 2026-11-09 · Estado: **à espera de aprovação** · Âmbito aprovado pelo utilizador: *tudo o que o backend expõe*.
Base: `docs/plans/2026-10-16-frontend-completo.md` (desenho), `main` em `6a35736`.

## Objetivo

Fechar as telas que faltam no `packages/frontend` depois das Fases 2–4 do backend:
campanhas reais (hoje placeholder), fila de handoffs, aprovação de rascunhos na
conversa e o módulo de conhecimento/treino. Nenhum ficheiro de
`packages/backend` muda.

## Fora de âmbito

- Novos endpoints, novos eventos Socket.IO, novos providers.
- Upload de PDF/OCR (o backend devolve 415; a UI aceita só `text/plain` e
  `text/markdown`, como o parser real).
- Fine-tuning, `ai_active`, primeiro envio real e primeira campanha real (gates).

## Rotas e permissões

| Rota | Página | Guarda |
|---|---|---|
| `/campaigns` | Campanhas reais | `RequireAdmin` (backend já exige admin) |
| `/handoffs` | Fila de handoffs | `RequireAuth` (backend: agent/admin) |
| `/knowledge` | Conhecimento (tabs) | `RequireRole(['editor','admin'])` (novo) |

`Sidebar`: Campanhas (admin), Handoffs (todos), Conhecimento (editor/admin).
A conversa ganha: painel de rascunhos pendentes (aprovar/rejeitar) e botão
“Devolver à IA” quando há handoff aceite.

## Contratos usados (extraídos do código real)

### Campanhas (`adapters/http/routes/campaigns.ts`)
- `POST /v1/campaigns` `{name,messageTemplate,allowedAccountIds,dailyLimit?}` + `Idempotency-Key` → `{campaign,replayed}`
- `GET /v1/campaigns?limit&cursor` → `{items,nextCursor}`
- `GET /v1/campaigns/:id` → `{campaign, counts:{pending,sent,failed,replied,optedOut}}`
- `POST /:id/start` `{scheduledAt}` + `Idempotency-Key` → `{campaign,recipientsCreated}`
- `POST /:id/pause` `{}` → `{campaign}`; `POST /:id/resume` → `{campaign}`

### Handoffs (`routes/handoffs.ts`)
- `GET /v1/handoffs?status=pending&limit` → `{handoffs: HandoffRow[]}`
- `GET /v1/handoffs/:id` → `{handoff}`
- `POST /v1/handoffs/:id/accept` → `{status}` (409 `handoff_taken`)
- `POST /v1/handoffs/:id/resolve` → `{status}`
- `POST /v1/conversations/:id/return-to-ai` → resultado do serviço

### Rascunhos (`routes/drafts.ts`)
- `GET /v1/conversations/:id/drafts` → `{drafts}`
- `POST /v1/drafts/:id/approve` → `{status,outboxId}`
- `POST /v1/drafts/:id/reject` `{reason}` → `{status}`

### Conhecimento (`routes/knowledge-*.ts`)
- Treino: `POST /train/documents` (JSON base64), `POST /train/guided`, `GET /train/draft`, `PATCH/DELETE /train/draft/:id`, `GET /train/diff`, `POST /train/validate` `{acceptConflicts?}` → `{publicationId,applied,idempotent}`.
- Publicado: `GET /published`, `PATCH /items/:id` `{entityType,patch}`, `GET /publications`, `POST /published/revert` `{publicationId}`, `GET /reviews`, `POST /reviews/:entityType/:id`, `POST /reembed`.
- Lacunas: `GET /gaps?status`, `POST /gaps/:id/resolve|ignore`, `GET /suggestions?status`, `POST /suggestions`, `POST /suggestions/:id/approve|reject`.
- Configuração: CRUD `qualification-questions` e `triggers` (com `expectedVersion` no patch/delete), `GET /config-revisions?entityType&entityId`, `POST /config-revisions/:id/revert`.
- Teste: `POST /knowledge/chat/test` `{text,target:'draft'|'published',lineSlug?}` → `{reply,sources}`.

## Tarefas

### T1 — Campanhas reais
- Reescrever `pages/campaigns.tsx`: lista paginada, criação (nome, mensagem, contas
  `purpose=campaigns` ligadas, limite diário), detalhe com contagens, acções
  start/pause/resume com estado e erro visível.
- `lib/campaigns.ts` com transições puras (`canStart/canPause/canResume`) + testes.
- Tipos `Campaign`, `CampaignCounts`, `CampaignList` em `lib/types.ts`; rótulos em `lib/labels.ts`.
- Testes de página: criação envia payload + chave; botões aparecem por estado; conflito mostra toast.

### T2 — Handoffs
- `pages/handoffs.tsx`: fila por prioridade, resumo/motivo do gatilho, aceitar (409
  “já aceite” recarrega), resolver, link para a conversa.
- `lib/labels.ts`: `handoffStatusLabel`, `handoffPriorityLabel` já existe (verificar assinatura).
- Testes: aceitar chama o endpoint e remove da fila; 409 recarrega; prioridade ordenada.

### T3 — Rascunhos na conversa
- Painel na thread: `GET /drafts`, aprovar, rejeitar com motivo (modal), estado.
- `pages/conversations.tsx` + testes do helper `draftActionLabel`/lista.

### T4 — Conhecimento: treino
- Rota `/knowledge` com tabs. Tab Treino: upload de ficheiros texto/markdown
  (FileReader → base64), passo-a-passo (linha + pares pergunta/resposta), lista do
  rascunho com edição rápida (JSON do payload validado pelo servidor), apagar,
  “Ver diferenças” e “Publicar” (com `acceptConflicts`).
- Helpers puros: `fileToBase64`, `guidedAnswersFrom`, `diffTone` + testes.

### T5 — Conhecimento: publicado, lacunas, configuração, teste
- Publicado: lista, edição rápida por tipo, publicações + reverter, revisões
  vencidas + marcar revisto, reembed.
- Lacunas: lacunas abertas (resolver/ignorar) e sugestões (criar/aprovar/rejeitar).
- Configuração: perguntas e gatilhos (criar/editar/desativar) com
  `expectedVersion`; histórico de revisões + reverter.
- Teste: chat com `target` e `lineSlug`, mostra resposta e fontes.
- Testes: payloads exatos de criação/edição e mapeamento de estados.

### T6 — Rotas, sidebar, README, verificação final
- `RequireRole` + testes; rotas em `main.tsx`; itens de sidebar.
- Atualizar `src/README.md` (novas páginas e permissões).
- Gates: `lint`, `typecheck`, `test`, `build` verdes.
- Browser (agent-browser) com a stack real: login → campanhas → handoffs →
  conhecimento (cada tab) → consola/erros limpos → screenshots.

## Critérios de aceitação

- Cada endpoint listado acima tem um controlo na UI (nenhuma chamada “morta”).
- Nenhum ecrã novo inventa dados: tudo vem das rotas reais ou mostra vazio honesto.
- `purpose='support'` nunca aparece como conta seleccionável para campanhas.
- Nenhum `console.log` de telefones/corpos; sem segredos.
- Testes novos cobrem as transições/estados e os payloads das mutações.
- `npm run lint && npm run typecheck && npm test && npm run build` verdes.
