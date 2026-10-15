# Adaptador HTTP

> **Responsabilidade** (`docs/02` §1): rotas Fastify com validação (zod), guards e
> serialização — **sem lógica de negócio**: cada handler valida, chama um caso de uso e
> serializa. Erros saem sempre `application/problem+json` (`errors.ts`/`toProblem`);
> `ZodError` → `400 validation_failed`; `DomainError` → mapa `DOMAIN` (códigos próprios).

## Mapa de rotas × papéis

| Método | Rota | Papéis | Notas |
|---|---|---|---|
| GET | `/health/live` | público | `200` enquanto o processo vive |
| GET | `/health/ready` | público | `200 ok` / `503 degraded` (db + redis; 2 s por cheque) |
| POST | `/v1/webhooks/wa-akg` | assinatura HMAC | sem sessão; `x-webhook-signature: sha256=<hex>`; responde `202` rápido e enfileira o ingest |
| POST | `/v1/auth/login` | público | rate limit por IP; devolve cookies `session` + `csrf`; corpo `{email, password}` → `user` \| `mfa: setup\|required` |
| POST | `/v1/auth/logout` | público | `204`, revoga a sessão e apaga cookies |
| GET | `/v1/auth/me` | qualquer sessão | papel completo; garante cookie `csrf` se ausente |
| POST | `/v1/auth/password` | qualquer sessão | `{currentPassword, newPassword}` → `204` |
| POST | `/v1/auth/totp/setup` | sessão com MFA pendente (allowlist) | idempotente; devolve `otpauthUrl` |
| POST | `/v1/auth/totp/verify` | sessão com MFA pendente (allowlist) | `{code}` de 6 dígitos → activa/complete MFA; rate limit 10/min |
| GET | `/v1/openapi.json` | qualquer sessão | spec OpenAPI 3.1 (`app.swagger()`); sem sessão → `401` |
| GET | `/v1/conversations` | qualquer sessão | lista (cursor, filtros de conta/estado) |
| GET | `/v1/conversations/:id` | qualquer sessão | inexistente → `404` |
| GET | `/v1/conversations/:id/messages` | qualquer sessão | cursor keyset (`created_at, id`); cursor mal-formado → `400 invalid_cursor` |
| POST | `/v1/conversations/:id/messages` | qualquer sessão | humano envia; header `Idempotency-Key` obrigatório → `201`; repetida → `409 idempotency_conflict`; texto vazio/longo → `400` |
| POST | `/v1/users` | admin | cria utilizador |
| GET | `/v1/users` | admin | lista |
| PATCH | `/v1/users/:id` | admin | actualiza papel/estado (`cannot_modify_self`, `last_admin`…) |
| POST | `/v1/whatsapp-accounts` | admin | cria conta + sessão no fork (`createSession`) |
| GET | `/v1/whatsapp-accounts` | admin | lista |
| GET | `/v1/whatsapp-accounts/:id` | admin | estado; devolve `qr` enquanto `connecting` |
| POST | `/v1/whatsapp-accounts/:id/logout` | admin | logout no fork; fork em baixo → `503 provider_unavailable` |

O Socket.IO **não** vive aqui — é `src/adapters/realtime/` (eventos em `docs/01` §5).

## Cookies, CSRF e TOTP

1. `POST /v1/auth/login` → `200` com dois cookies: `session` (HttpOnly, SameSite=Lax;
   `Secure` em produção) e `csrf` (legível por JS — é para o cliente o ecoar no header).
2. MFA:
   - primeiro login sem TOTP → `mfa: "setup"` + `otpauthUrl` → `POST /v1/auth/totp/verify`
     com o código da app TOTP → activa;
   - login com TOTP activo → `mfa: "required"` (a sessão nasce `mfaPending`) →
     `POST /v1/auth/totp/verify` com o código → `{ok: true}`;
   - com sessão `mfaPending`, só a allowlist responde `200` (setup, verify, logout);
     as restantes rotas → `403 mfa_required`.
3. **CSRF** (`csrfGuard`, `onRequest` global): ignora GET/HEAD/OPTIONS e pedidos **sem** cookie
   `session`; nas mutações exige header `x-csrf-token` == cookie `csrf` (comparação em tempo
   constante) → ausente/divergente → `403 csrf_invalid`.
4. Sem sessão/inválida nas rotas autenticadas → `401 unauthenticated`.

## Como testar

- `npm test` — unit: `login-limiter`, `password`, `totp`, `config*`, `logger`.
- `npm run test:integration` — rotas reais com BD + Redis de teste (Docker): `auth-routes`,
  `login`, `mfa`, `users-api`, `accounts-api`, `conversations-api`, `http-foundations`,
  `webhook-idempotency`, `send-flow` (fluxo ponta-a-ponta).
- `npm run test:contract` — contrato do WA-AKG (o lado webhook do fork está coberto por
  `webhook-idempotency`; a assinatura/parse em `webhook-verify`, unit).
