# AGENTS.md — CRM WhatsApp da MilVendas

Este ficheiro é carregado em todas as sessões. É curto de propósito. O detalhe está em `docs/`.
Responde ao utilizador em português. Código, identificadores e commits em inglês.

## Missão

Construir o backend de um CRM interno para a MilVendas (software, soluções personalizadas, telecomunicações, CCTV) que:

1. controla várias contas de WhatsApp num único lugar;
2. faz campanhas e envios em massa, com limites;
3. tem uma IA que responde, qualifica leads, faz follow-ups e **passa a um humano** quando deve.

O WhatsApp é servido por um serviço separado, o **WA-AKG** (fork de `mrifqidaffaaditya/WA-AKG`, usa Baileys). Tu implementas o nosso backend **e** a integração com o WA-AKG, dentro dos limites de `docs/04-integracao-wa-akg.md`.

## Leitura obrigatória, por esta ordem

1. `docs/01-contexto-e-plano.md`: contexto, decisões, arquitetura, fases, gates.
2. `docs/02-regras-backend.md`: regras de código e boas práticas.
3. `docs/03-seguranca.md`: segurança e privacidade. Aplica-se a TUDO.
4. `docs/04-integracao-wa-akg.md`: o que o WA-AKG faz, o que não faz, limites.
5. `docs/05-ia-conhecimento-handoff.md`: módulo de IA, conhecimento e handoff.
6. `reference/`: código já escrito e testado (schema, seed, contrato, orquestrador, cenários). É a fonte de verdade desses módulos.

## Regras inegociáveis

1. **Âmbito.** Faz só o que a tarefa pede. Sem refactors, renomeações ou "melhorias" não pedidas. Nova dependência só com justificação escrita (ADR curto).
2. **Prova.** Nada está "feito" sem testes a passar e o output real dos comandos no relatório. Afirmações sobre o WA-AKG ou APIs externas exigem evidência: `ficheiro:linha`, resposta real, log. O README do WA-AKG não conta como evidência.
3. **Não inventes.** Se uma informação não está nos docs nem no código, pergunta. Nunca assumas endpoints, campos ou formatos de payload do WA-AKG: descobre-os no código e documenta-os.
4. **Segredos nunca** em código, commits, logs, fixtures ou prompts. Configuração por variáveis de ambiente validadas no arranque.
5. **WA-AKG só pelo adaptador** `MessagingProvider`. Nunca importes código dele nem leias a base de dados dele.
6. **WhatsApp só sai pela outbox + fila**, com limites de ritmo. Nenhum handler HTTP chama `send` diretamente.
7. **IA só pelo `AIProvider`.** A IA classifica e responde. Quem decide handoff, bloqueio, lacunas e registo é o orquestrador (`reference/orchestrator.ts`). Nunca movas essa decisão para o prompt.
8. **Preço, prazo, cobertura e disponibilidade** vêm do catálogo/conhecimento publicado. Nunca de texto livre do modelo.
9. **Idempotência** em webhooks, jobs, envios e processamento de mensagens.
10. **Valida toda a entrada** nas fronteiras (HTTP, webhooks, jobs, saída estruturada do LLM). TypeScript `strict`, sem `any` sem comentário a justificar.
11. **Migrações Drizzle** versionadas e revistas. Nunca edites uma migração já aplicada. Nunca `drizzle-kit push` fora de desenvolvimento local.
12. **Testes primeiro** para lógica de decisão. Testes de integração com Postgres e Redis reais (contentores). Nunca apagues ou enfraqueças um teste para o fazer passar.
13. **Dados pessoais:** minimizar, mascarar em logs. As 20 conversas de WhatsApp que existem **não podem ser usadas** (sem permissão): nem em testes, nem em prompts, nem em exemplos. Usa só cenários sintéticos.
14. **Ficheiros em `reference/`** só mudam com ADR aprovado. Podes movê-los para `src/` ajustando imports, sem alterar comportamento.
15. **Git:** commits pequenos e convencionais (`feat:`, `fix:`, `test:`...). Sem `push --force`. Sem commits com testes a falhar.

## Como trabalhar em cada tarefa

1. Lê a tarefa e os docs relevantes. Se algo for ambíguo ou faltar uma decisão (ver "Decisões em aberto" em `docs/01`), **pára e pergunta**.
2. Escreve o plano em até 10 linhas: o que vais fazer, o que NÃO vais fazer, como vais provar que funciona.
3. Escreve o teste que falha. Implementa o mínimo. Faz passar.
4. Corre lint, typecheck e testes. Cola o output no relatório.
5. Relatório final com: o que mudou, evidência, o que ficou por fazer, riscos novos, decisões que precisam de humano.
6. Se tomaste uma decisão de arquitetura, regista-a em `docs/adr/NNNN-titulo.md` (contexto, opções, decisão, consequências).

## Definição de pronto

- Typecheck, lint e testes passam (unitários e de integração).
- Critérios de aceitação da fase cumpridos e demonstrados (`docs/01`, secção Fases).
- Sem segredos nem dados pessoais em código, logs ou fixtures.
- Migrações geradas, revistas e a aplicar-se do zero numa base vazia.
- Docs atualizados (README do módulo, ADR se houve decisão).
- Relatório com evidência entregue.

## Gates: pára e espera aprovação humana antes de

- fechar a auditoria do WA-AKG (Fase 0) e antes de escrever o adaptador;
- aprovar o schema base (contas, contactos, leads, conversas, mensagens);
- o **primeiro envio real** de WhatsApp para um número que não seja de teste;
- ativar qualquer **campanha** em produção;
- ativar a IA em modo `ai_active` (autónomo) em conversas reais;
- qualquer alteração ao código do WA-AKG (ver política de patches em `docs/04`);
- enviar dados de clientes a um serviço externo novo (LLM, embeddings, analytics).

## Fora de âmbito (não faças)

- Frontend/painel. Só expões as APIs e eventos Socket.IO definidos em `docs/01`.
- Usar as 20 conversas existentes, ou qualquer conversa real, para treino, prompts ou testes.
- Fine-tuning (LlamaFactory) nesta fase. Está previsto para uma fase futura, quando houver dados com consentimento.
- Contornar limites de envio, "anti-ban" agressivo ou rotação de números para fugir a bloqueios.
- Decidir sozinho: framework HTTP, modelo de LLM, fornecedor de embeddings, topologia de deploy. Propõe num ADR e espera.

## Comandos

Preenche esta secção na Fase 0, com os comandos reais do repositório:

```
install:           (a definir)
dev:               (a definir)
lint:              (a definir)
typecheck:         (a definir)
test:              (a definir)
test:integration:  (a definir)
db:generate:       (a definir)
db:migrate:        (a definir)
eval:              (a definir)   # avalia o classificador contra reference/handoff-scenarios.ts
```
