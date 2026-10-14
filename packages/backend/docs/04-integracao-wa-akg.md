# 04 — Integração com o WA-AKG

Repositório de origem: `github.com/mrifqidaffaaditya/WA-AKG` (MIT). Vamos usar um **fork nosso**, como **serviço separado**.

## 1. Papel do WA-AKG no sistema

O WA-AKG é a **camada de transporte do WhatsApp**: mantém as sessões (QR/ligação), recebe e envia mensagens e emite eventos. Nada mais.

| O WA-AKG FAZ | O WA-AKG NÃO FAZ (é do CRM) |
|---|---|
| Ligar e manter sessões WhatsApp (QR, reconexão) | Contactos, leads, conversas e mensagens como fonte de verdade |
| Enviar texto e mídia por uma sessão | Decidir **quando** e **quanto** enviar (outbox, limites, janelas) |
| Receber mensagens e estados e emitir **webhooks** | Campanhas, segmentação, consentimento, opt-out |
| Expor uma API autenticada ao CRM | IA, respostas automáticas, follow-ups, handoff |
| | Utilizadores e permissões do negócio |

### Funcionalidades do WA-AKG que NÃO usamos (desligar ou ignorar)

- Auto-reply por palavra-chave, broadcast, agendador e *dashboard* do WA-AKG: **o CRM é o dono** disto. Se não puderem ser desligados por configuração, é um achado da auditoria.
- Dashboard e Swagger do WA-AKG: nunca públicos.
- Grupos, status/stories e chamadas: fora de âmbito.

### Limites duros

1. Sem lógica de negócio dentro do WA-AKG.
2. O CRM **nunca** lê nem escreve na base de dados do WA-AKG.
3. O WA-AKG **nunca** fica exposto à internet.
4. O WA-AKG **não é fonte de verdade**: tudo o que importa é copiado para a base do CRM. Mídia recebida é copiada para o nosso armazenamento (os URLs do WA-AKG podem expirar. Verificar na auditoria).
5. Uma conta WhatsApp do CRM = uma sessão do WA-AKG. O mapeamento (`whatsapp_accounts.provider_session_id`) vive no CRM.
6. Todo o acesso é pelo adaptador `MessagingProvider` (secção 5).

## 2. O que sabemos (README e estrutura do repo: NÃO verificado)

Isto vem de uma leitura do README e da listagem de ficheiros, **não do código**. O agente trata tudo como **hipótese**.

- Gateway + dashboard em Next.js, motor **Baileys**, Prisma (MySQL/PostgreSQL), NextAuth, PM2/Docker.
- Multi-sessão por QR code. Mais de 109 endpoints, Swagger, autenticação por API key.
- Broadcast com atrasos aleatórios de 10 a 30 s e lotes. Agendador com mídia. Auto-reply por palavra-chave.
- Webhooks e nós de n8n. Perfis `SUPERADMIN`, `OWNER`, `STAFF`.
- v1.6.2, 416 commits, um mantenedor. Pasta `patches/`. Ficheiros soltos na raiz (`eslint-errors.txt`, `ts_errors.log`, `lint_output.txt`, `tmp-missing-APIs.txt`, vários `test-*.js`, `API_REFACTOR_TASK.txt`). Inconsistência de versão do Next.js no README. Funcionalidade de status/stories assinalada como instável.
- Não vimos: assinatura de webhooks, idempotência de envio, isolamento por organização, caixa de entrada de conversas.

## 3. Fase 0 — Auditoria (só leitura) — OBRIGATÓRIA antes do adaptador

Entrega: `docs/wa-akg-audit.md`. Para **cada** pergunta: resposta, **evidência** (`ficheiro:linha` ou comando e saída) e estado (`Confirmado`, `Refutado`, `Não verificável`). Sem evidência, o estado é `Não verificável`. **Não alteres o código do WA-AKG nesta fase.**

**A. API**
1. Como autentica a API (cabeçalho, API key, JWT)? Há *rate limiting*?
2. Tabela de todos os endpoints (método, caminho, função, corpo, resposta). Marca os que vamos usar: criar sessão, obter QR, estado, logout, enviar texto, enviar mídia, marcar como lido, indicador de escrita, listar sessões.
3. O envio aceita chave de idempotência? Que resposta devolve (ID da mensagem do WhatsApp)? O que acontece num timeout (a mensagem pode ter saído)?
4. Limites de tamanho e tipos de mídia. Como é entregue a mídia recebida (URL, base64) e quanto tempo dura?

**B. Webhooks**
5. Eventos disponíveis e payloads **reais** (captura de exemplo de cada um).
6. Há assinatura (HMAC) ou segredo? Como se configura? É por sessão ou global?
7. Semântica de entrega (pelo menos uma vez?), *retries*, *timeout*, ordem, eventos duplicados.
8. Como notificam desligamentos, QR novo e banimentos?

**C. Sessões**
9. Onde e como guardam as credenciais da sessão (ficheiros ou base de dados)? Estão cifradas? Quem consegue lê-las?
10. Reconexão automática: quando acontece, o que emite, o que falha. Expiração do QR.
11. Limite de sessões simultâneas, memória por sessão.
12. O que acontece com mensagens recebidas enquanto a sessão está offline? Há forma de reconciliar lacunas?

**D. Dados**
13. Schema Prisma: que dados de mensagens e contactos guarda? É possível **desligar o armazenamento de mensagens** ou limitar a retenção? (Duplicação de dados pessoais.)
14. Há migrações? Que base de dados e versão exige?

**E. Funcionalidades a desligar**
15. Auto-reply, broadcast, agendador, dashboard: como se desligam por configuração? Têm *defaults* ativos?
16. Utilizadores e credenciais por defeito (seeds, `SUPERADMIN` inicial). Existem palavras-passe ou chaves por defeito?

**F. Segurança**
17. `npm audit`, dependências diretas e transitivas relevantes (Baileys, versão), *scripts* de instalação (`postinstall`), conteúdo e motivo de `patches/`.
18. Validação de entrada, uploads, SSRF em *webhooks* (o WA-AKG chama URLs configuráveis), CORS, cabeçalhos, segredos em logs.
19. Segredos em código ou no histórico git.

**G. Qualidade e operação**
20. Testes existentes e se passam. CI. Ficheiros soltos: lixo ou trabalho em curso? A API está completa (`tmp-missing-APIs.txt`)?
21. Como se corre (Docker, PM2), *healthcheck*, logs, requisitos de recursos, procedimento de *upgrade*.
22. A versão exata do Next.js usada e o motivo da inconsistência no README.

**Conclusão da auditoria:** lista de **lacunas bloqueantes** (ex.: sem assinatura de webhooks, sem idempotência, sem forma de desligar o armazenamento), cada uma com proposta: configurar, contornar no adaptador, ou **patch mínimo** (ver secção 9). **Gate humano** antes de avançar.

## 4. Topologia e deploy

- Rede privada. O WA-AKG só aceita ligações do backend do CRM. O backend só chama o WA-AKG por URL interna.
- Variáveis de ambiente e segredos conforme `docs/03`. Contentor não-root, versão fixada por *digest*.
- Base de dados própria do WA-AKG, credenciais distintas das do CRM.
- Volume de sessões cifrado e com backup cifrado.
- Ambientes: dev e staging usam **números de teste**. Nunca números de clientes.
- Healthcheck: o `/health/ready` do CRM inclui o estado do WA-AKG.

## 5. Contrato interno `MessagingProvider`

Definido no CRM (`src/ports/messaging-provider.ts`). Os nomes e formatos reais do WA-AKG são mapeados dentro do adaptador, **depois da auditoria**.

```ts
export type SessionStatus =
  | 'connecting' | 'qr_pending' | 'connected' | 'disconnected' | 'logged_out' | 'unknown';

export interface SendResult {
  providerMessageId: string | null;
  /** 'unknown' = o envio pode ter ocorrido (timeout). NUNCA fazer retry automático. */
  outcome: 'accepted' | 'rejected' | 'unknown';
  error?: string;
}

export type ProviderEvent =
  | { type: 'message.received'; providerEventId: string; sessionId: string;
      providerMessageId: string; from: string; timestamp: Date;
      message: { kind: 'text' | 'audio' | 'image' | 'video' | 'document' | 'other';
                 text?: string; mediaRef?: string } }
  | { type: 'message.status'; providerEventId: string; sessionId: string;
      providerMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed';
      timestamp: Date }
  | { type: 'session.status'; providerEventId: string; sessionId: string; status: SessionStatus }
  | { type: 'session.qr'; providerEventId: string; sessionId: string; qr: string };

export interface MessagingProvider {
  readonly name: string;
  health(): Promise<{ ok: boolean; detail?: string }>;
  createSession(input: { label: string }): Promise<{ sessionId: string }>;
  getSession(sessionId: string): Promise<{ status: SessionStatus; phone?: string }>;
  getQr(sessionId: string): Promise<{ qr: string; expiresAt?: Date } | null>;
  logout(sessionId: string): Promise<void>;
  sendText(input: { sessionId: string; to: string; text: string; idempotencyKey: string }): Promise<SendResult>;
  sendMedia(input: { sessionId: string; to: string; mediaUrl: string; caption?: string;
                     mimeType: string; idempotencyKey: string }): Promise<SendResult>;
  /** Verifica a assinatura sobre o corpo BRUTO e devolve eventos normalizados. Lança se inválido. */
  verifyAndParseWebhook(headers: Record<string, string | undefined>, rawBody: Buffer): ProviderEvent[];
}
```

Regras do adaptador:
- Valida **todas** as respostas e payloads do WA-AKG com esquemas. Resposta inesperada = erro, nunca "adivinhar".
- Timeouts curtos e *circuit breaker*. Erros distinguem transitório de permanente.
- Normaliza telefones para E.164 e IDs de mensagem para strings.
- Se o WA-AKG **não** suportar idempotência, o adaptador **não repete** um envio que deu *timeout*: devolve `outcome: 'unknown'`. A outbox marca `unknown_delivery`, **não** faz retry automático e gera alerta para reconciliação (duplicar uma mensagem a um cliente é pior do que atrasá-la).
- Sem tipos do WA-AKG a vazar para fora de `adapters/wa-akg/`.

## 6. Ciclo de vida das contas

- `whatsapp_accounts.status`: `connecting`, `connected`, `disconnected`, `suspected_ban`.
- Criar conta: admin cria → adaptador cria sessão → QR emitido por evento Socket.IO ao painel → admin lê → `connected`.
- Desligamento (`disconnected`): a outbox dessa conta **pausa** (as mensagens ficam na fila). Retoma quando voltar `connected`. Alerta ao admin. Se `logged_out`, é preciso novo QR (manual).
- `suspected_ban`: quando a sessão sai (`logged_out`) sem pedido do admin, ou há pico de falhas de envio. A conta fica **bloqueada para envios**, alerta ao admin. **Sem automação para ressuscitar** nem para trocar de número.
- Cada conta tem `purpose`: `support`, `sales` ou `campaigns`. **Campanhas só usam contas `campaigns`.**

## 7. Envio

Todo o envio: `caso de uso → outbox (transação) → fila por conta → adaptador`. Nunca direto.

### Política de ritmo (configuração; valores iniciais NOSSOS, a calibrar)

Os valores abaixo são pontos de partida conservadores definidos por nós, **não** garantias nem limites oficiais do WhatsApp. Calibrar com monitorização.

| Chave | Significado | Valor inicial |
|---|---|---|
| `WA_REPLY_DELAY_MS` | Atraso humano ao responder numa conversa (IA ou humano) | 1000 a 5000 (aleatório) |
| `WA_CAMPAIGN_DELAY_MS` | Atraso entre mensagens de campanha, por conta | 15000 a 45000 (aleatório) |
| `WA_CAMPAIGN_RAMP` | Teto diário de campanha por conta, por idade da conta | dias 1-3: 30. dias 4-7: 60. dias 8-14: 100. depois: valor definido pelo admin |
| `WA_QUIET_HOURS` | Janela sem campanhas (fuso Africa/Luanda) | 20:00 a 08:00 |
| `WA_SEND_TIMEOUT_MS` | Timeout de uma chamada de envio | 15000 |

Regras:
- Envios de **uma conta são serializados** (concorrência 1 por conta).
- Respostas de conversa têm prioridade sobre campanhas na fila.
- Cada limite é imposto **no código do CRM**, não confiado ao WA-AKG.

### Campanhas — limites e pausa automática

- Só para contactos com `marketing_consent = true` e `opted_out_at is null`.
- Mensagem inclui forma de sair. Resposta "SAIR" (e variantes configuráveis) → opt-out imediato, fora de todas as campanhas.
- **Pausa automática** da campanha e alerta se, por conta e numa janela móvel (valores em configuração):
  - a proporção de falhas ultrapassar o limiar (inicial: ≥ 30% nas últimas 20 mensagens);
  - a sessão desligar ou sair (`logged_out`) durante a campanha;
  - houver pico de opt-outs (inicial: ≥ 5 em 50 mensagens).
- Retoma **só por ação humana**.
- Proibido: rotação de números para fugir a bloqueios, variação artificial para iludir deteção, ou contornar os limites. O risco de banimento é aceite, **não agravado**.

## 8. Receção

`webhook → verifyAndParseWebhook → inbound_events (único por providerEventId) → 2xx imediato → job → mensagem guardada → handleInbound`. Detalhes em `docs/02`, secção 7.

- Estados de mensagem só **avançam** (`queued` → `sent` → `delivered` → `read`). Evento atrasado não recua o estado.
- Mídia: copiar para o armazenamento do CRM, validar tipo/tamanho. `unsupported_media` trata o que a IA não interpreta.
- O CRM deve tolerar o WA-AKG estar em baixo: as mensagens de clientes chegam quando a sessão voltar (comportamento a confirmar na auditoria, pergunta 12).

## 9. Política de alterações ao fork

Ordem de preferência: **configuração → uso da API → lógica no adaptador → patch**.

1. Qualquer alteração ao código do WA-AKG exige **ADR** e **aprovação humana** (gate).
2. Um patch é pequeno, isolado, num commit com prefixo `ours:`, com teste, e documentado em `docs/wa-akg-patches.md`: o quê, porquê, estado no upstream, como remover.
3. **Não** reformatar, limpar ou refatorar código do upstream. **Não** apagar os ficheiros soltos. Isto mantém as atualizações do upstream fáceis de integrar.
4. Registar o *commit* base do upstream. Atualizações do upstream acontecem num ramo, com os testes de contrato a passar, antes de entrar.
5. Candidatos a patch, **a avaliar na auditoria e não pré-aprovados:** assinatura HMAC de webhooks, idempotência no envio, endpoint de saúde, desligar armazenamento de mensagens, desligar funcionalidades por configuração.

## 10. Falhas e *runbooks* (a escrever em `docs/runbooks/`)

| Situação | Resposta |
|---|---|
| Sessão desligada | Conta `disconnected`, outbox pausada, alerta. Retoma sozinha ao reconectar |
| `logged_out` inesperado ou pico de falhas | `suspected_ban`: bloquear envios da conta, alertar, investigar. Sem automação de recuperação |
| Protocolo do WhatsApp mudou (Baileys desatualizado) | Reverter para versão fixada anterior. Num ramo, atualizar o Baileys, correr testes de contrato, publicar. Mensagens ficam na outbox |
| WA-AKG em baixo | `/health/ready` falha, alerta, outbox acumula. Reiniciar. Reconciliar mensagens `unknown_delivery` |
| Fuga da API key ou do segredo de webhook | Rodar já. Se o armazenamento de sessões foi exposto: terminar sessões e voltar a ligar com QR novo |

## 11. Monitorização

Por conta: estado, último evento de entrada e saída, taxa de falhas de envio, profundidade da fila, tempo até `delivered`. Alertas: sessão desligada, `suspected_ban`, fila parada, falhas acima do limiar, *dead-letter* com itens.

## 12. Critérios de aceitação da integração

- [ ] `docs/wa-akg-audit.md` aprovado, com evidência em todas as respostas.
- [ ] O WA-AKG só é acessível da rede privada (teste do exterior falha).
- [ ] Adaptador implementa `MessagingProvider` com testes de contrato.
- [ ] Webhook com assinatura inválida é rejeitado. Evento repetido não duplica efeitos (testes).
- [ ] Nenhum envio fora da outbox (verificado por teste/análise estática).
- [ ] Timeout num envio **não** gera reenvio automático (teste).
- [ ] Limites de ritmo e janela horária impostos pelo CRM (testes com relógio controlado).
- [ ] Campanha pausa sozinha nos três cenários da secção 7 (testes).
- [ ] Contas `campaigns` e `support` separadas. Campanha em conta `support` é recusada (teste).
- [ ] Sessões, QR e estados visíveis por eventos Socket.IO.
- [ ] Patches (se houver) documentados e aprovados.
- [ ] *Runbooks* escritos.
