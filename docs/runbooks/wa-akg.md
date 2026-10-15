# Runbook — WA-AKG (Fase 1)

> Situações de `docs/04` §10 com o que **existe mesmo** na Fase 1 (mecanismos testados),
> sem segredos literais — `${WA_AKG_API_KEY}`/`${WA_WEBHOOK_SECRET}` vêm do ambiente.
> Correr os comandos em `packages/backend`. A base de dados do WA-AKG **nunca é lida**
> (`docs/04` §1): o diagnóstico usa a nossa BD, o adaptador e os endpoints públicos do fork.

## 0. Diagnóstico rápido

```bash
# o nosso serviço — /health/live (processo) e /health/ready (db + redis;
# 200 ok | 503 degraded, 2 s de timeout por cheque)
curl -s "http://localhost:${PORT:-3000}/health/live"
curl -s "http://localhost:${PORT:-3000}/health/ready"

# WA-AKG — o fork não tem rota de saúde; o ping autenticado é a lista de
# sessões (README do adaptador, endpoint 7): falha/timeout ⇒ WA-AKG em baixo.
curl -s -H "x-api-key: ${WA_AKG_API_KEY}" "${WA_AKG_BASE_URL}/api/sessions"
```

```sql
-- estado das contas (nossa BD)
SELECT id, label, phone_e164, provider_session_id, status, purpose, updated_at
FROM whatsapp_accounts ORDER BY created_at;

-- outbox: por enviar / em envio / por reconciliar
SELECT o.id, o.message_id, o.account_id, o.status, o.attempts, o.last_error, o.updated_at
FROM outbox_messages o
WHERE o.status IN ('queued', 'sending', 'unknown_delivery')
ORDER BY o.updated_at DESC LIMIT 50;
```

## 1. Sessão desligada (conta `disconnected`)

Automático (`docs/04` §6): conta não-`connected` ⇒ o worker **não envia**; as mensagens ficam
`queued` e **retomam sozinhas** quando o WA-AKG reconecta e emite `session.status = connected`
(job → conta `connected` → próximo `outbox.tick` envia).

1. SQL da §0 → `status` da conta.
2. `curl -s -H "x-api-key: $WA_AKG_API_KEY" "$WA_AKG_BASE_URL/api/sessions/{provider_session_id}"`
   → estado real no fork.
3. Fork re-ligou sozinho: nada a fazer.
4. Fork em `STOPPED`: arrancar/parear — no fork (a nossa `POST /v1/whatsapp-accounts` cria
   sessão nova; `GET /v1/whatsapp-accounts/:id` devolve o QR enquanto `connecting`). Reusar o
   MESMO número exige `phone_e164` único → fazer antes `POST /v1/whatsapp-accounts/:id/logout`
   na conta antiga (o logout limpa `phone_e164`).

## 2. `logged_out` inesperado ou pico de falhas (`suspected_ban`)

- `session.status = logged_out` ⇒ o lifecycle marca a conta `suspected_ban` **uma vez**
  (audit `account.suspected_ban`); os envios ficam **bloqueados automaticamente** (o worker só
  envia contas `connected`). Sem automação de recuperação (`docs/04` §6).
- Pico de falhas consecutivas do provider ⇒ circuit breaker abre (após `cbThreshold`
  `ProviderUnavailableError`/`unknown` seguidos): sem chamadas ao fork durante `cbCooldownMs`,
  depois uma chamada de teste (meia-abertura). **Não** altera o estado da conta.

```sql
SELECT created_at, action, details FROM audit_log
WHERE action IN ('account.suspected_ban', 'account.status_changed', 'account.logout')
ORDER BY created_at DESC LIMIT 20;
```

Investigar a causa (regra do número, denúncias, múltiplos logins) **antes** de qualquer
reset. **Não existe reset em Fase 1** (sem rota; `docs/04` §6): recuperação é decisão humana,
e novo QR/número novo tem gate (`AGENTS.md`).

## 3. Protocolo do WhatsApp mudou (Baileys desatualizado)

1. As nossas mensagens ficam na outbox (`queued`, com retry) — nada se perde.
2. Reverter o fork para a versão fixada anterior (num ramo — nunca directo em produção).
3. No fork: atualizar o Baileys → correr **do nosso backend** `npm run test:contract`
   (os contratos falam com um mock local do fork, sem internet) + `npm test`.
4. Publicar só com tudo verde. **Alterar o código do WA-AKG exige gate humano**
   (`AGENTS.md`; política de patches em `docs/04` §3).

## 4. WA-AKG em baixo

Sintomas: ping da §0 falha; sem webhooks de entrada; outbox a acumular (`attempts`/`last_error`
a crescer); breaker abre. Nota: em Fase 1 o nosso `/health/ready` sonda **só db + redis** — a
indisponibilidade do fork vê-se pelo ping da §0 e pela outbox.

1. Reiniciar o serviço WA-AKG (infraestrutura — fora deste repositório).
2. Repetir o ping da §0 → `200` com a lista de sessões.
3. Confirmar a retoma: linhas `queued` passam a `sent` no próximo `outbox.tick` (contas
   `connected`), sem duplicados (idempotência `idempotencyKey`).
4. Restarem linhas `unknown_delivery` → §5.

## 5. Reconciliação de `unknown_delivery`

`docs/04` §5/§7: timeout/abort a meio do envio ⇒ `unknown_delivery` ⇒ **nunca retry
automático** (risco de duplicar a mensagem ao cliente); reconciliação **humana**, obrigatória
**antes do primeiro envio real** (gate).

```sql
SELECT o.id, o.message_id, m.status AS message_status, m.provider_message_id,
       o.attempts, o.last_error, o.updated_at
FROM outbox_messages o
JOIN messages m ON m.id = o.message_id
WHERE o.status = 'unknown_delivery'
ORDER BY o.updated_at;
```

Passos manuais, por linha (decisão humana; registar sempre o motivo em `audit_log`):

1. Comprovar se a mensagem chegou (número de teste: confirmar no telemóvel; cliente:
   perguntar). Sem confirmação, **não reenviar às cegas**.
2. Chegou ⇒ marcar como entregue e fechar a linha:
   ```sql
   UPDATE messages SET status = 'delivered', updated_at = now() WHERE id = '<message_id>';
   UPDATE outbox_messages SET status = 'sent', updated_at = now() WHERE id = '<outbox_id>';
   ```
3. Não chegou ⇒ reenfileirar **uma vez** (o worker repete com a mesma `idempotencyKey`):
   ```sql
   UPDATE outbox_messages
   SET status = 'queued', attempts = 0, scheduled_at = now(), updated_at = now()
   WHERE id = '<outbox_id>';
   ```
4. Impossível decidir ⇒ fechar como não entregue e registar:
   ```sql
   UPDATE messages SET status = 'failed', updated_at = now() WHERE id = '<message_id>';
   UPDATE outbox_messages SET status = 'failed', updated_at = now() WHERE id = '<outbox_id>';
   ```
5. Repetir até a consulta devolver **0 linhas** e anexar o resultado ao relatório do gate.

## 6. Fuga da API key ou do segredo de webhook — rodar já

1. **Rodar já:** gerar nova API key no WA-AKG e novo `WA_WEBHOOK_SECRET` (≥ 32 caracteres);
   atualizar as env vars do backend e do fork; reiniciar ambos.
2. **Validar a rotação:**
   - chave antiga: `curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: chave-antiga" "$WA_AKG_BASE_URL/api/sessions"`
     → `401` (o fork valida `x-api-key` — README do adaptador);
   - webhook assinado com o segredo antigo → `401` no nosso `POST /v1/webhooks/wa-akg`.
3. **Se o armazenamento de sessões do fork foi exposto:** terminar todas as sessões
   (`POST /v1/whatsapp-accounts/:id/logout` por conta, que chama o logout no fork) e voltar a
   ligar com QR novo (§1).
4. Conferir `whatsapp_accounts` e o audit (`account.logout`, `account.status_changed`) no
   rescaldo.

## Ver também

- `docs/04` §5 (contrato de erros), §6 (estados da conta), §7 (envio e limites).
- `src/adapters/wa-akg/README.md` (endpoints reais do fork, extraídos do código).
