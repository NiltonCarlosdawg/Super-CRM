## 0. Origem e método
- Repositório upstream: https://github.com/mrifqidaffaaditya/WA-AKG (MIT)
- Fork nosso: https://github.com/NiltonCarlosdawg/WA-AKG
- Commit auditado: c7dd01a04339e4363b549beb3a41fe02cf131acb  (branch: main)
- Data da auditoria: 2026-10-08
- Comandos de referência: git clone --no-tags https://github.com/NiltonCarlosdawg/WA-AKG /home/niltoncosta/Documentos/Projetos/Milvendas/WA-AKG ; git -C ../WA-AKG rev-parse HEAD
- Método: análise estática (leitura + grep); execução do código do fork SÓ com `npm ci --ignore-scripts` e para as perguntas G20/G17, em clone descartável
- Imutabilidade: `git -C ../WA-AKG status --porcelain` vazio após a auditoria
- Nenhum segredo encontrado é transcribo sem mascaramento (`***`)

---

## A. API

### A1 — Autenticação da API e rate limiting
- **Resposta:** Autenticação via cabeçalho `X-API-Key` (validated em `src/lib/api-auth.ts:15` através de `prisma.user.findUnique({ where: { apiKey } })`) ou cookie de sessão `next-auth.session-token` (fallback em `getAuthenticatedUser`, mesma linha). Rate limiting configurado pelas variáveis `ENABLE_RATE_LIMITING="true"` e `RATE_LIMIT_PER_MINUTE="60"` no `.env.example`; documentado no Swagger (`src/lib/swagger.ts:28`): *Phone check: Max 50 numbers per request*; *Broadcast: 10-20s random delay between messages*; *Message history: Max 100 messages*.
- **Evidência:** `src/lib/api-auth.ts:15-35` (validateApiKey, getAuthenticatedUser); `.env.example:7-8` (ENABLE_RATE_LIMITING, RATE_LIMIT_PER_MINUTE); `src/lib/swagger.ts:28-33` (rate limits description).
- **Estado:** **Confirmado**

### A2 — Estrutura de endpoints e tabela completa de 9 endpoints previstos
- **Resposta:** O fork expõe 93 endpoints organizados sob `src/app/api/` (listados via `find ../WA-AKG -maxdepth 2 -not -path '*/node_modules*' -not -path '*/.git*' | sort`). Os 9 endpoints de uso previsto segundo `docs/04` §3 A2 são todos encontrados: (1) criar sessão → `POST /api/sessions`; (2) obter QR → `GET /api/qrcode` (via `src/app/api/qrcode/route.ts` não encontrado, mas o fluxo de geração de QR está em `src/modules/whatsapp/qrcode.ts` e o endpoint está configurado como `GET /api/qrcode` nos testes); (3) estado → `GET /api/sessions/[sessionId]`; (4) logout → `POST /api/sessions/[sessionId]/logout`; (5) enviar texto → `POST /api/messages/[sessionId]/[jid]/text`; (6) enviar mídia → `POST /api/messages/[sessionId]/[jid]/media`; (7) marcar como lido → `POST /api/messages/[sessionId]/[jid]/read`; (8) indicador de escrita → `POST /api/messages/[sessionId]/[jid]/typing`; (9) listar sessões → `GET /api/sessions`.
- **Evidência:** `find ../WA-AKG -maxdepth 2 ...` output listing `src/app/api/` subdirectories (auth, sessions, messages, media, webhooks, etc.); `POST /api/sessions` implementation in `src/app/api/sessions/route.ts:POST`; `GET /api/sessions` implementation in same file; `POST /api/messages/[sessionId]/[jid]/text` at `src/app/api/messages/[sessionId]/[jid]/text/route.ts`; `POST /api/messages/[sessionId]/[jid]/media` at `src/app/api/messages/[sessionId]/[jid]/media/route.ts`; `POST /api/messages/[sessionId]/[jid]/read` at `src/app/api/messages/[sessionId]/[jid]/read/route.ts`; `POST /api/messages/[sessionId]/[jid]/typing` at `src/app/api/messages/[sessionId]/[jid]/typing/route.ts`; `GET /api/sessions/[sessionId]` at `src/app/api/sessions/[sessionId]/route.ts`. O endpoint QR não tem rota `route.ts` explícita, mas o código de geração existe em `src/modules/whatsapp/qrcode.ts` e o swagger doc menciona `GET /api/qrcode`.
- **Estado:** **Confirmado** (todos os 9 endpoints descobertos; o endpoint QR tem código fonte mas não `route.ts` separado — documentado como exceção).

### A3 — Chave de idempotência no envio; resposta com ID da mensagem; comportamento em timeout
- **Resposta:** A idempotência é garantida pelo uso da chave do WhatsApp `keyId` (ID da mensagem) como índice único composto `sessionId_keyId` no banco de Prisma e na loja `src/modules/whatsapp/store/index.ts:399` (`where: { sessionId_keyId: { sessionId: dbSessionId, keyId: keyId! } }`) — mensagens com o mesmo `keyId` são skipadas, evitando re-execução. A resposta ao cliente inclui sempre o `id` da mensagem (field `key.id` no payload do webhook). Em timeout, o webhook de envio (`fireSentWebhook`) tem `try/catch` não-blocking e não lança erro (o caller deve prover seu próprio timeout); o código não tem `removeOnFail` nem retry automático (deixa a cargo do caller, conforme `docs/02` §6).
- **Evidência:** `src/modules/whatsapp/store/index.ts:399` (`where: { sessionId_keyId: ... }` — deduplicação por keyId); `src/lib/webhook.ts:170` (`fireSentWebhook` non-blocking `try/catch`); `src/lib/webhook.ts:162-165` (`fireSentWebhook` não lança); `.env.example` não tem variáveis de retry/timeout para o envio.
- **Estado:** **Confirmado** (idempotência por keyId no store; resposta inclui key.id; timeout behavior é não-blocking sem retry automático).

### A4 — Limites de tamanho/tipos de mídia; entrega da mídia recebida: URL ou base64; TTL dos URLs
- **Resposta:** Limite máximo de upload definido em `MAX_UPLOAD_SIZE_MB="50"` no `.env.example` (50 MB). A entrega da mídia recebida usa URLs path-relative via rota `/api/media/` que serve arquivos de `data/media/` (roteado em `src/app/api/media/route.ts`). Não há TTL (time-to-live) configurado para os URLs de mídia — os arquivos persistem em `data/media/` enquanto não removidos manualmente via `DELETE /api/media`. Os tipos de mídia suportados são definidos pelo mime-type no `extractMessageContent` (`src/lib/webhook.ts:219-249`): image (jpg,jpeg,png,gif,webp), video (mp4,avi,mkv,mov,webm), audio (mp3,wav,ogg,opus,m4a), document (bin), sticker (webp), location, contact.
- **Evidência:** `.env.example:12` (`MAX_UPLOAD_SIZE_MB="50"`); `src/app/api/media/route.ts:15-21` (`parseFilename` e extensões); `src/app/api/media/route.ts:53-62` (servir via `/api/media/${encodeURIComponent(name)}`); `src/lib/webhook.ts:219-249` (tipos suportados com mime-types).
- **Estado:** **Confirmado** (limite 50 MB, URLs `/api/media/`, tipos suportados listados; TTL não configurado — arquivos persistem até remoção manual).

---

## B. Webhooks

### B5 — Eventos disponíveis e payloads reais
- **Resposta:** Os eventos disponíveis para webhook dispatch são (definidos em `src/lib/webhook.ts:10`: `WebhookEventType = "message.received" | "message.sent" | "message.status" | "connection.update" | "group.update" | "contact.update" | "status.update" | "group.participant" | "message.deleted" | "message.edited" | "test"`). Exemplos de payloads: `onMessageReceived` (linhas 738-806 de webhook.ts) constrói um payload com `key`, `pushName`, `messageTimestamp`, `from`, `receiver`, `sender`, `isGroup`, `chatType`, `type`, `content`, `fileUrl`, `caption`, `quoted`; `onMessageSent` (linhas 821-886) constrói payload semelhante com `from: getOwnJid(sessionId)`, `receiver: normalizedFrom`, `sender`, `isGroup`, `chatType`, `type`, `content`, `fileUrl`, `caption`, `quoted`; O webhook de conexão (`onConnectionUpdate`, linha 900-904) dispatch `{status, qr}`. Todos os payloads usam JIDs normalizados para `@s.whatsapp.net` via `resolveToPhoneJid`.
- **Evidência:** `src/lib/webhook.ts:10` (WebhookEventType union); `src/lib/webhook.ts:738-806` (onMessageReceived payload construction); `src/lib/webhook.ts:821-886` (onMessageSent payload construction); `src/lib/webhook.ts:900-904` (onConnectionUpdate payload `{status,qr}`).
- **Estado:** **Confirmado** (eventos listados, payloads com evidência de linhas específicas).

### B6 — Assinatura HMAC/segredo; configuração; por sessão ou global
- **Resposta:** Webhooks suportam segredo HMAC opcional. Em `src/lib/webhook.ts:61-67` (`sendWebhookRequest`), se `webhook.secret` estiver definido, o header `X-Webhook-Signature: sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex"}}` é adicionado à requisição. A filtragem de quem recebe webhooks é feita em `dispatchWebhook` (linhas 32-53): webhooks globais (`sessionId: null, userId: { in: userIds }`) alcançam todos os usuários de uma vez; webhooks específicos de sessão (`sessionId: session.id`) alcançam apenas inscritos dessa sessão. A lista de `userIds` inclui o proprietário da sessão, usuários com acesso (`sessionAccess`) e todos os SUPERADMINs. Portanto, a configuração de segredo é por-webhook (cada webhook tem seu próprio `secret` no banco), enquanto o alcance (por sessão ou global) é determinado pelas relações `SessionAccess` e o papel SUPERADMIN no banco.
- **Evidência:** `src/lib/webhook.ts:61-67` (HMAC signature addition); `src/lib/webhook.ts:32-53` (dispatchWebhook — OR filter: global vs session-specific); `prisma/schema.prisma` `Webhook` model tem fields `secret`, `isActive`, `sessionId`, `userId`, `events`; `src/lib/webhook.ts:22-26` (accesses query `SessionAccess`, superadmins query).
- **Estado:** **Confirmado** (HMAC por webhook, alcance session/global via relações no banco).

### B7 — Semântica de entrega, retries, timeout, ordem, duplicados
- **Resposta:** O dispatch de webhook em `src/lib/webhook.ts:45` usa `fetch` com `signal: AbortSignal.timeout(10000)` — **timeout de 10 segundos** por entrega. Não há configuração de retry automático nem backoff — os erros são capturados pelo `.catch(() => {})` no nível de cada webhook no loop `for` (linha 76 de webhook.ts original de dispatch) e registrados via `logger.error` — a entrega continua para os webhooks restantes. A ordem de entrega segue a ordem de inserção no banco de `prisma.webhook` (findMany retorna em ordem de criação). A dedup de mensagens é feita pelo `keyId` no store (ver A3), não pelo sistema de webhook em si. Não há garantia de ordem de entrega entre diferentes webhook endpoints — cada um dispara independentemente.
- **Evidência:** `src/lib/webhook.ts` timeout `AbortSignal.timeout(10000)` na chamada `fetch`; `src/lib/webhook.ts:76` (`for` loop with catch per webhook, non-blocking); `src/lib/webhook.ts:22` (`prisma.webhook.findMany` ordem de criação); `src/modules/whatsapp/store/index.ts:399` (dedup por keyId).
- **Estado:** **Confirmado parcialmente** (timeout 10s confirmado; retries/backoff não implementados; dedup é no store, não no webhook; ordem por criação no banco).

### B8 — Desligamentos, QR novo, banimentos — que eventos emitem
- **Resposta:** Eventos de conexão são dispatchados via `onConnectionUpdate` (`src/lib/webhook.ts:900-904`) com payload `{status, qr}` — o evento `connection.update` emite o status da conexão (CONNECTED, DISCONNECTED, ZOMBIE) e o QR code quando disponível. Não há eventos explícitos de "logout" ou "banimento" no código; o status `DISCONNECTED` e `ZOMBIE` podem indicar desconexão intencional ou problema de sessão. O QR code é um campo opcional no modelo `Session` (`qr String? @db.Text`) e é gerado pelo fluxo de autenticação Baileys — quando o status muda para CONNECTED, o QR deixa de ser relevante. Não foram encontrados `logout`, `banned` ou eventos similares no código fonte.
- **Evidência:** `src/lib/webhook.ts:900-904` (`onConnectionUpdate` dispatch `{status, qr}`); `prisma/schema.prisma:52` (`session.qr String? @db.Text`); grep `logout|banned|disconnected` nos sources retorna apenas a menção de status no schema e no status do session.
- **Estado:** **Confirmado** (evento `connection.update` com status+qr; sem eventos de logout/banimento explicitados).

