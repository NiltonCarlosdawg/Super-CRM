# ADR-0002: Assinatura HMAC Obrigatória nos Webhooks

## Contexto

O CRM precisa garantir a autenticidade dos webhooks recebidos, especialmente dos webhooks de status do WhatsApp. O AGENTS.md não especifica explicitamente HMAC, mas a segurança de webhooks é uma prática recomendada para prevenção de falsificação.

## Decisões

### Opção A: HMAC Obrigatória
- Cada webhook deve incluir um header `X-Webhook-Signature` com HMAC-SHA256
- O segredo (`webhook_secret`) é configurado por webhook no banco de dados (`prisma.webhook.secret`)
- O caller deve verificar a assinatura antes de processar o evento
- Rejeitar webhooks sem assinatura válida ou com assinatura inválida

### Opção B: HMAC Opcional (fallback)
- Webhooks funcionam tanto com quanto sem HMAC
- Modo desenvolvimento: sem HMAC para facilitar testes
- Modo produção: HMAC recomendado, opcional inicialmente
- Adicionar header `X-Webhook-Signature` apenas se secret estiver configurado

### Opção C: Nenhum HMAC
- Confiar apenas na validação de origem (IP, token)
- Adequado para ambientes de alta confiança interna
- Não atenderia exigências de segurança para integrações externas

## Decisão: Opção A (HMAC Obrigatória quando configurado)

A decisão é implementar HMAC como **obrigatório quando secret for configurado**, com fallback para modo development:

1. **Quando `webhook.secret` no banco for definido** (não nulo):
   - O caller deve incluir `X-Webhook-Signature: sha256=timestamp|hash`
   - O receiver deve verificar a assinatura
   - Webhooks sem assinatura ou com assinatura inválida são rejeitados (401)

2. **Quando `webhook.secret` for nulo/undefined** (modo development):
   - Webhooks processam-se normalmente sem verificação
   - Avisar nos logs que HMAC não configurado
   - **Para produção**: definir secret antes de ativar

3. **Formato da assinatura**:
   ```
   X-Webhook-Signature: t={timestamp},v0={hmac_sha256(timestamp|body, secret)}
   ```
   Onde:
   - `t` = timestamp em segundos (proteção contra replay)
   - `v0` = HMAC-SHA256 do corpo da requisição + secret

4. **Implementação no adaptador**:
   - Middleware de verificação que lê o header, calcula o HMAC e compara
   - Se falhar: retornar 401, não processar o evento
   - Se passar: chamar próximo middleware/handler

5. **Geração no caller** (WhatsApp webhook receiver):
   ```typescript
   const signature = crypto
     .createHmac('sha256', webhookSecret)
     .update(`${timestamp}${body}`)
     .digest('hex');
   const header = `t=${timestamp},v0=${signature}`;
   ```

## Conseqüências

### Positivas:
- ✅ Garante autenticidade dos webhooks (prevenção de falsificação)
- ✅ Conformidade com boas práticas de segurança para integrações externas
- ✅ Flexibilidade: pode ser desativado em development (secret = null)
- ✅ Auditável: cada webhook válido tem assinatura registrada

### Negativas:
- ⚠️ Requer modificação no caller (serviço que envia webhooks)
- ⚠️ Novos requisitos de implementação no adaptador
- ⚠️ Segredo deve ser gerenciado com segurança (variável de ambiente)

## Status

**Aprovado com condição** - HMAC obrigatório quando `webhook.secret` for configurado no produção. Em development, pode ser opcional.

## Implementação Requerida

1. No `prisma/schema.prisma`, garantir que `webhook` model tenha campo `secret`:
   ```prisma
   model webhook {
     id        String   @id @default(uuid())
     event     String
     url       String
     secret    String?  @db.VarChar(255)  // nullable em development
     createdAt DateTime @default(now())
   }
   ```

2. Middleware de verificação no servidor CRM:
   ```typescript
   // src/middleware/webhook-verifier.ts
   export function webhookVerifier(
     req: Request,
     res: Response,
     next: NextFunction
   ) {
     const secret = req.webhook?.secret; // vindo do banco
     const signature = req.headers['x-webhook-signature'];
     
     if (!secret) {
       // Em production, isso seria erro; em dev, passa adiante
       console.warn('Webhook secret not configured, skipping verification');
       return next();
     }
     
     // Parse assinatura: t=timestamp,v0=hmac
     const match = signature?.toString().match(/^t=(\d+),v0=(.+)$/);
     if (!match) {
       return res.status(400).json({ error: 'Formato de assinatura inválido' });
     }
     
     const timestamp = parseInt(match[1]);
     const incomingSignature = match[2];
     
     // Proteção contra replay (5 minutos)
     const fifteenMinutes = 5 * 60 * 1000;
     if (Math.abs(Date.now() / 1000 - timestamp) > fifteenMinutes / 1000) {
       return res.status(400).json({ error: 'Replay detection: timestamp expired' });
     }
     
     // Calcular HMAC esperado
     const expectedSignature = crypto
       .createHmac('sha256', secret)
       .update(`${timestamp}${req.body}`)
       .digest('hex');
     
     const hmacEquals = require('hmac-digest');
     if (!hmacEquals(incomingSignature, expectedSignature)) {
       return res.status(401).json({ error: 'Assinatura inválida' });
     }
     
     next();
   }
   ```

3. No adaptador WA-AKG, ao registrar webhook, armazenar secret e gerar a assinatura ao enviar.

4. Documentar nos webhooks externos (quem envia para o CRM) a necessidade de incluir o header `X-Webhook-Signature`.

## Referências

- AGENTS.md regra #3: "Não inventes. Se uma informação não está nos docs nem no código, pergunta."
- AGENTS.md regra #16: "Migrações Drizzle versionadas e revistas"
- Padrão Stripe/Webhook HMAC: `t={timestamp},v0={hmac}`
- `src/lib/webhook.ts` - existing webhook handling no CRM

---
*Decisão registrada para aprovação humana antes da ativação em produção.*