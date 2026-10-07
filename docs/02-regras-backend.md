# 02 — Regras de desenvolvimento e boas práticas de backend

Estas regras são obrigatórias. Se uma regra impedir uma tarefa, pára e pergunta. Não a contornes.

## 1. Estrutura e camadas

Arquitetura hexagonal simples. As dependências apontam sempre para dentro.

```
src/
  domain/            tipos e regras puras (sem I/O, sem frameworks)
  application/       casos de uso (ex.: handleInbound, publishKnowledgeItem)
  ports/             interfaces (MessagingProvider, AIProvider, Ports...)
  adapters/
    wa-akg/          adaptador do WA-AKG
    ai/              implementação do AIProvider
    db/              repositórios Drizzle
    queue/           BullMQ
    http/            rotas, validação, serialização
    realtime/        Socket.IO
  infra/             config, logging, métricas, arranque
  modules/knowledge/ schema Drizzle, seed, services (vindos de reference/)
tests/               unit/, integration/, contract/, eval/
docs/adr/            decisões
```

Regras:
- `domain` e `application` **não importam** Drizzle, BullMQ, Socket.IO, Fastify/Elysia nem SDKs. Falam com o mundo por `ports`.
- Um módulo não lê tabelas de outro módulo diretamente: usa o repositório/serviço dele.
- Nada de lógica de negócio em rotas HTTP ou em handlers de jobs. Eles só validam, chamam um caso de uso e serializam.

## 2. TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`.
- Sem `any`. Se for inevitável, comentário `// any: motivo` na própria linha.
- Tipos de domínio explícitos. Enums de base de dados exportados de um só lugar.
- Dinheiro: `numeric` no Postgres, **string** em TypeScript. Nunca `number` com vírgula flutuante.
- Datas: sempre UTC e `timestamptz`. Conversão de fuso só na apresentação.
- Telefones: sempre E.164 normalizado (`+244...`) numa função única e testada.
- IDs: `uuid`. Nunca expor IDs sequenciais.

## 3. Validação e erros

- Toda a entrada externa é validada com um esquema (zod ou equivalente) **na fronteira**: HTTP, webhooks, jobs, variáveis de ambiente, e **a saída estruturada do LLM**.
- Falha de validação = erro 400 (HTTP) ou job rejeitado sem retry. Nunca "corrigir" dados em silêncio.
- Erros tipados (`DomainError` com `code`), mapeados para respostas HTTP num único ponto. Formato de erro uniforme (RFC 9457 `application/problem+json`). Nunca devolver stack traces nem mensagens internas ao cliente.
- Não uses exceções para controlo de fluxo normal.
- Nunca engolir erros: ou trata, ou regista com contexto e propaga.

## 4. Configuração

- Variáveis de ambiente lidas **uma vez**, num módulo `config`, validadas no arranque. Se faltar algo, o processo **não arranca**.
- Sem valores por defeito inseguros para segredos. Existe `.env.example` sem valores reais.
- Limites e parâmetros operacionais (atrasos, caps, timeouts, limiares) são configuração, não constantes soltas.

## 5. Base de dados (PostgreSQL + Drizzle)

- Migrações geradas por `drizzle-kit generate`, **revistas** e versionadas. Nunca editar uma já aplicada. Nunca `push` fora de desenvolvimento local.
- Cada migração tem de aplicar-se do zero numa base vazia (teste de CI).
- A extensão `vector` é criada por migração SQL personalizada anterior às tabelas.
- Transações para tudo o que escreve em mais de uma tabela. Define o nível de isolamento quando houver concorrência relevante.
- Índices para cada filtro/ordenação frequente. Sem `SELECT *`. Sem N+1: usa `with`/joins ou lotes.
- Paginação **por cursor** em listas que crescem (mensagens, conversas, handoffs). Limite máximo por página.
- Integridade na base: `NOT NULL`, `UNIQUE`, `FOREIGN KEY` e `CHECK` onde fizer sentido. Não confies só na aplicação.
- SQL manual só com o template `sql\`\`` do Drizzle (parametrizado). **Nunca** concatenar strings em SQL.
- Utilizador de aplicação com o mínimo de privilégios. O utilizador de migrações é diferente.
- Soft delete só onde há requisito. Dados pessoais têm política de retenção e apagamento (`docs/03`).

## 6. Filas e jobs (Redis + BullMQ)

- **Todo o job é idempotente.** Se correr duas vezes, o efeito é o mesmo. Usa `idempotency_key` ou `jobId` determinístico.
- Padrão **outbox** para envios: grava a intenção na base (transação) e a fila processa. Nunca "grava e envia" no mesmo passo sem rede de segurança.
- Retries com backoff exponencial e jitter, limite de tentativas, e **dead-letter** com alerta. Distingue erro transitório (retry) de erro permanente (falha direta).
- Timeouts em todas as chamadas externas. Um job não pode ficar pendurado.
- Concorrência e limitadores por fila e **por conta WhatsApp** (envios de uma conta são serializados).
- Jobs recorrentes (follow-ups, alertas de revisão) têm *lock* para não correrem em duplicado.
- Nunca ponhas dados sensíveis desnecessários no payload do job: leva IDs, não conversas inteiras.

## 7. Webhooks e eventos de entrada

- Verifica a assinatura sobre o **corpo bruto** (antes de fazer parse). Rejeita sem assinatura válida. Compara em tempo constante. Protege contra repetição (timestamp/nonce) se o WA-AKG o permitir.
- Grava em `inbound_events` (chave única do evento do fornecedor) e responde 2xx **rápido**. O processamento é assíncrono por job.
- Evento duplicado: ignora sem efeitos. Evento fora de ordem: tem de ser tolerado (estados de mensagem só avançam).
- Nunca confies no conteúdo: tudo o que vem de um webhook é entrada não fiável.

## 8. API HTTP

- REST versionada (`/v1`). Recursos no plural. Verbos HTTP corretos. Códigos de estado corretos.
- Autenticação e autorização em **todas** as rotas, exceto as explicitamente públicas (webhooks, que têm a sua própria verificação). Autorização por papel e por recurso.
- Esquemas de entrada e saída documentados (OpenAPI gerado do código).
- Idempotência em operações de criação sensíveis (cabeçalho `Idempotency-Key`), por exemplo criar campanha ou pedido de envio.
- Limites de tamanho de corpo, rate limiting por utilizador e por IP.
- Sem lógica de negócio nos controladores.

## 9. Tempo real (Socket.IO)

- Autentica a ligação no *handshake*. Salas por permissão (ex.: fila de handoffs só para `agent` e `admin`).
- Eventos com nome e payload versionados e documentados. O servidor é a fonte de verdade: o cliente nunca decide permissões.
- Eventos mínimos: `handoff.created`, `handoff.updated`, `message.created`, `message.status`, `account.status`.
- Reenvio/recuperação: o cliente pode pedir o estado atual por REST. Não dependas de entrega garantida do socket.

## 10. Logging, métricas e observabilidade

- Logs **estruturados** (JSON) com `requestId`/`correlationId` propagado por HTTP, jobs e chamadas externas.
- Níveis corretos. Sem `console.log` em produção.
- **Nunca** registar: segredos, tokens, corpos completos de mensagens, números de telefone completos (mascara: `+244 9** *** *12`), prompts completos com dados de clientes.
- Métricas mínimas: mensagens recebidas/enviadas, latência da IA, taxa de handoffs, taxa de lacunas, tamanho e atraso das filas, falhas por conta WhatsApp, estado das sessões.
- Health checks: `/health/live` e `/health/ready` (base, Redis, WA-AKG).
- Alertas: sessão desligada, fila parada, dead-letter com itens, taxa de falhas de envio acima do limiar, erro do fornecedor de IA.

## 11. Testes

| Tipo | O que testa | Regras |
|---|---|---|
| Unitários | Domínio e casos de uso | Sem I/O. Rápidos. Portas em memória |
| Integração | Repositórios, filas, rotas | **Postgres e Redis reais** (contentores). Não simular a base de dados |
| Contrato | Adaptador WA-AKG | Contra um mock fiel ao comportamento auditado. Se o WA-AKG mudar, o teste falha |
| Avaliação (eval) | Classificador da IA | `evaluate()` contra `handoff-scenarios.ts`. Relatório por gatilho |
| Segurança | Autorização, validação, assinatura de webhook | Casos de abuso (sem token, token de outro papel, payload malformado, assinatura inválida) |

- Testes primeiro para lógica de decisão (gatilhos, handoff, limites de envio, consentimento).
- Cada bug corrigido ganha um teste que o reproduz.
- Sem testes dependentes de hora real, rede externa ou ordem de execução. Controla o relógio.
- **Nunca** uses conversas reais como fixtures. Só dados sintéticos.
- Cobertura é indicador, não objetivo. O que importa: casos de borda e falhas.

## 12. Dependências

- Fixar versões com *lockfile*. Revisão manual de cada dependência nova: manutenção, licença, tamanho, histórico de vulnerabilidades. Justifica no PR.
- `npm audit` (ou equivalente) em CI. Atualizações regulares e pequenas.
- Preferir a biblioteca padrão e poucas dependências. Não adicionar uma biblioteca para uma função de 10 linhas.

## 13. Git, PRs e documentação

- Commits pequenos, mensagens convencionais (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- Um PR = uma intenção. Descrição com: contexto, o que mudou, como foi testado (output), riscos, o que não foi feito.
- Nunca commits com testes a falhar. Nunca `push --force` em ramos partilhados.
- Decisões de arquitetura em `docs/adr/NNNN-titulo.md`.
- Cada módulo tem um README curto: responsabilidade, API pública, como testar.
- Comentários explicam o **porquê**, não o quê.

## 14. Performance e robustez

- Medir antes de otimizar. Nada de otimização prematura.
- Sem operações bloqueantes no *event loop*. Trabalho pesado vai para jobs.
- Todas as chamadas externas com timeout, retry limitado e *circuit breaker* simples onde houver risco de cascata (LLM, WA-AKG).
- Degradação segura: se a IA falhar, o orquestrador passa a humano (já implementado). Se o WA-AKG estiver em baixo, as mensagens ficam na outbox e retomam.
- Arranque e paragem limpos (*graceful shutdown*): termina jobs em curso, fecha ligações.

## 15. Anti-padrões proibidos

- Enviar WhatsApp a partir de um handler HTTP.
- Ler ou escrever na base de dados do WA-AKG.
- Decisão de handoff dentro do prompt da IA.
- Números ou preços "de cabeça" no código ou no prompt.
- Chaves, tokens ou palavras-passe em código, testes, logs ou exemplos.
- `catch {}` vazio. `any` sem justificação. `// @ts-ignore` sem justificação.
- Migração editada depois de aplicada.
- Testes que dependem da internet.
- Código "temporário" sem *ticket* nem data de remoção.
