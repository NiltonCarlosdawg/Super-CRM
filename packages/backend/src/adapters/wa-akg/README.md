# Adaptador WA-AKG — mapa de API extraído do código

> **Fonte de verdade:** o código do fork, não o README. Clone em
> `~/Documentos/Projetos/Milvendas/WA-AKG`, commit auditado `c7dd01a04339e4363b549beb3a41fe02cf131acb`
> (mesmo de `docs/wa-akg-audit.md` §0). Todo o `file:linha` abaixo foi lido desse commit.
>
> **Errata:** a auditoria §A2 está errada em 3 caminhos e omite que não há endpoint de
> saúde — ver "Errata vs. auditoria" no fim e `docs/wa-akg-audit.md`. Este mapa foi
> confirmado por inspecção directa pelo humano (2026-10-15), com as decisões de
> mapeamento assinaladas **[decisão humana]**.

## Autenticação

Header `x-api-key` — `src/lib/api-auth.ts:15` (`request.headers.get("x-api-key")`);
fallback a cookie `next-auth.session-token` (mesma função `getAuthenticatedUser`),
que **não usamos**: o adaptador só envia `x-api-key`. Resposta sem chave válida: HTTP 401.

## Endpoints usados pelo port `MessagingProvider`

| # | Operação | Método + caminho | Corpo enviado | Resposta de sucesso | Erros |
|---|----------|------------------|---------------|---------------------|-------|
| 1 | criar sessão | `POST /api/sessions` | `{ name: string (obrigatório), sessionId?: string }` | 200 `{ status: true, message, data: { sessionId, status: "STOPPED", … } }` | 400 sem `name`; 401; 500 `{status:false,…}` |
| 2 | estado | `GET /api/sessions/{sessionId}` | — | 200 `{ status: true, message, data: { sessionId, status, qr, botConfig, webhooks, _count } }` | 401; 403 sem acesso; 404 inexistente; 500 |
| 3 | obter QR | `GET /api/sessions/{sessionId}/qr` | — | 200 `{ success: true, qr, base64 }` | 400 ligado/sem QR `{error, connected}`; 404 `{error, qr: null}`; 401; 403; 500 |
| 4 | logout | `POST /api/sessions/{sessionId}/logout` | — (corpo ignorado) | 200 `{ status: true, message }` | 400 acção inválida (`validActions`); 401; 403; 500 |
| 5 | enviar texto | `POST /api/messages/{sessionId}/{jid}/send` | `{ message: string (obrigatório), mentions?: string[], quotedMessageId?: string }` | 200 `{ status: true, message, data: { key: { id: "wamid…" }, … } }` | 400 sem `message`; 401; 403; 500 |
| 6 | enviar mídia | `POST /api/messages/{sessionId}/{jid}/media` | **multipart/form-data**: `file` (File, obrigatório), `type` (`image`\|`video`\|`audio`\|`document`), `caption` | 200 `{ status: true, message: "Operation successful", data: { key: { id }, … } }` | 400 sem `file`/formato; 401; 403; 500 |
| 7 | saúde (ping) | `GET /api/sessions` | — | 200 `{ status: true, message, data: [ … ] }` | 401 (chave errada); 5xx/rede/timeout → indisponível **[decisão humana]** |

Evidência:

- (1) `src/app/api/sessions/route.ts` (POST: `body.name` obrigatório → `waManager.createSession`);
  criação em `src/modules/whatsapp/manager.ts:61-95` (`prisma.session.create`, `sessionId`
  gerado se não enviado, `status: "STOPPED"`).
- (2) `src/app/api/sessions/[sessionId]/route.ts` (GET: `prisma.session.findUnique` com includes).
- (3) `src/app/api/sessions/[sessionId]/qr/route.ts` (GET: `success/qr/base64` na resposta 200;
  400 quando a sessão está ligada; 404 com `qr: null`).
- (4) `src/app/api/sessions/[sessionId]/[action]/route.ts:27` (`validActions = ["start","stop",
  "restart","logout","pair"]`) e case `logout` (~:53-64).
- (5) `src/app/api/messages/[sessionId]/[jid]/send/route.ts:15-16` (jid chega URL-encoded e é
  `decodeURIComponent`-ado), `:32` (`ChatService.sendTextMessage`);
  `src/modules/whatsapp/chat.service.ts:128,168` (`sendMessage` → `sendResult`, que em JSON tem
  `key.id`).
- (6) `src/app/api/messages/[sessionId]/[jid]/media/route.ts` (formData `file`/`type`/`caption`;
  `buffer = Buffer.from(await file.arrayBuffer())`; `ChatService.sendMediaMessage(...)`; resposta
  `data: sent`).
- (7) `src/app/api/sessions/route.ts` (GET lista sessões) — usado como ping autenticado porque o
  fork **não tem rota de saúde** (grep `/health` → zero; cf. auditoria G21 "Não verificável").

### `jid` (destinatário)

`{dígitos sem +}@s.whatsapp.net`, com `encodeURIComponent` no caminho (`send/route.ts:16` decodifica).
Os webhooks do WA-AKG normalizam JIDs para `@s.whatsapp.net` (`docs/wa-akg-audit.md` B5,
`resolveToPhoneJid`). O adaptador constrói o `jid` com `normalizePhoneE164(to)` do domínio
(`src/domain/phone.ts`): se `to` não for E.164 válido → `outcome: 'rejected'` sem chamada de rede.

### Mapeamento `status` da sessão → `SessionStatus` (port)

| `Session.status` (WA-AKG) | Port | Evidência |
|---------------------------|------|-----------|
| `CONNECTED` | `connected` | `instance.ts:209` |
| `SCAN_QR` | `qr_pending` | `instance.ts:103,109` (grava `qr` + `SCAN_QR`) |
| `STOPPED` | `disconnected` | `manager.ts:71` (criação) + `instance.ts:152,190` |
| `DISCONNECTED` | `disconnected` | `instance.ts:168,171` |
| `ZOMBIE` | `disconnected` | `prisma/schema.prisma:59` (comentário do campo) |
| `FAILED` | `disconnected` | escrita `status: "FAILED"` no fork |
| `LOGGED_OUT` | `logged_out` | `instance.ts:122,129` |
| outro | `unknown` | nunca adivinhar (docs/04 §5) |

`connecting` não tem equivalente no WA-AKG (nunca persiste "OPENING") — nunca é emitido.

### Mídia (envio)

O port `sendMedia({ mediaUrl, mimeType, … })` fala em URL; o WA-AKG só aceita ficheiro
multipart. **[decisão humana 2026-10-15]**: o adaptador faz `fetch(mediaUrl)` (http/https,
timeout `downloadTimeoutMs`, limite `maxMediaBytes` = 50 MB — `.env.example:12`
`MAX_UPLOAD_SIZE_MB="50"`) e reenvia como multipart `file` + `type` (derivado de `mimeType`:
`image/*`→`image`, `video/*`→`video`, `audio/*`→`audio`, resto→`document`) + `caption`.
Falha de download → `ProviderUnavailableError` (transitório; a outbox tenta mais tarde);
mídia acima do limite → `rejected`.

## Semântica de timeout e idempotência (auditoria §A3/§B7)

- **Idempotência no envio:** o WA-AKG **não** aceita chave de idempotência. A deduplicação por
  `keyId` (`sessionId_keyId`, `store/index.ts:399`) é do lado da **recepção**. A responsabilidade
  de não repetir envios é 100% nossa (outbox + `idempotencyKey` nosso). O `idempotencyKey` do port
  não é enviado ao WA-AKG (não inventar headers).
- **Resposta de envio:** traz sempre o id em `data.key.id` (auditoria A3; `chat.service.ts:168`).
- **Timeouts nossos:** `sendTimeoutMs` (envio), `downloadTimeoutMs` (mídia). Timeout a meio de um
  envio → `outcome: 'unknown'` — **nunca** retry automático (port §5).
- **Retries:** o WA-AKG não faz retry de envio; o webhook de envio é non-blocking
  (`webhook.ts:162-170`); dispatch de webhook tem `AbortSignal.timeout(10000)` sem retry
  (B7). Ordem/duplicação: sem garantias — tratamos tudo como idempotente do nosso lado.

## Classificação de erros (port `MessagingProvider`)

| Situação | Resultado |
|----------|-----------|
| rede/`TypeError` do fetch, timeout de ligação, HTTP 5xx, HTTP 401 (nossa chave), envelope 2xx não-parseável numa **consulta** | `ProviderUnavailableError` (transitório) |
| envio: timeout/abort a meio | `{ providerMessageId: null, outcome: 'unknown' }` (sem retry) |
| envio: 2xx com envelope válido sem `data.key.id` | `{ outcome: 'unknown' }` (nunca inventar id) |
| envio: 4xx (400/403/422…) | `{ outcome: 'rejected', error }` (não repetir) |
| operações de gestão: 4xx | `Error` simples com a `message` do corpo (não transitório) |
| breaker aberto | `CircuitOpenError` (sem chamada de rede) |

**Circuit breaker (por instância):** `cbThreshold` `ProviderUnavailableError`/`unknown`
consecutivos ⇒ `CircuitOpenError` durante `cbCooldownMs`; depois, **uma** chamada de teste
(meia-abertura): sucesso fecha, falha reabre com cooldown novo.

## Regras deste directório

- Nenhum tipo/objeto do WA-AKG sai daqui (docs/04 §5): as respostas são validadas por zod em
  `schemas.ts` e convertidas para os tipos do port.
- Webhook: `verifyAndParseWebhook` implementado na Task 12 (`webhook.ts`).

## Errata vs. auditoria (§A2)

| Auditoria diz | Código real (commit `c7dd01a0`) |
|---------------|--------------------------------|
| enviar texto: `POST /api/messages/{sid}/{jid}/text` | **`POST …/send`** (`send/route.ts`); não existe directoria `text/` |
| QR: `GET /api/qrcode` | **`GET /api/sessions/{sid}/qr`** (`sessions/[sessionId]/qr/route.ts`); não existe `src/app/api/qrcode/` |
| marcar lido: `POST /api/messages/{sid}/{jid}/read` | **`POST /api/chat/{sid}/{jid}/read`** (não existe `read/` em `messages/…/[jid]/`) |
| indicador de escrita: `POST /api/messages/{sid}/{jid}/typing` | **não existe** (nem em `messages/` nem em `chat/`) |
| saúde: (omitida em A2; G21 "Não verificável") | confirmado: **nenhuma** rota de saúde — ping via `GET /api/sessions` **[decisão humana]** |
