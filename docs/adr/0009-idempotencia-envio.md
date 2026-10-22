# ADR-0001: Idempotência no Envio de Mensagens WhatsApp

## Contexto

O CRM MilVendas deve garantir idempotência nos envios de WhatsApp, conforme regras do AGENTS.md:
- Regra #6: "WhatsApp só sai pela outbox + fila, com limites"
- Regra #9: "Idempotência em webhooks, jobs, envios e processamento de mensagens"

Atualmente, não há garantia de que o re-enviom com a mesma chave não duplique a mensagem.

## Decisões

### Opção A: Idempotência via Outbox (escolhida)
- O `idempotency_key` já existe no modelo `outbox_messages` como `unique`
- Implementação: re-enviar com a mesma `idempotencyKey` executa o handler uma só vez
- Mecanismo: no adaptador WA-AKG, antes de enviar, verificar se `outbox_messages` já existe com essa chave
- Se existir: ignorar/envio já processado
- Se não existir: criar outbox entry + enviar

### Opção B: Idempotência via retry count
- Contar `retryCount` no outbox entry
- Limitar re-envios a N tentativas
- Marcar como `failed` após exceder limite

### Opção C: Idempotência via database constraint
- `UNIQUE constraint` no nivel de banco na tabela de mensagens enviadas
- Aplicar apenas em modo produção com tráfego alto

## Decisão: Opção A (Idempotência via Outbox)

O CRM já possui a estrutura de `outbox_messages` com `idempotency_key` única. A decisão é:

1. **Garantir que o handler de envio verifique o idempotency_key antes de enviar**
2. **Se `outbox_messages` já existir com a mesma chave**: pular envio, marcar como `already_sent`  
3. **Se não existir**: criar novo entry na outbox, enviar via WA-AKG, marcar como `sent``
4. **Isso se aplica a todos os envios**: campanhas, follow-ups, mensagens individuais**

## Conseqüências

### Positivas:
- ✅ Não há mensagens duplicadas no WhatsApp para o mesmo usuário
- ✅ Conformidade com a regra #9 do AGENTS.md (idempotência)
- ✅ Funciona com o padrão existente de outbox + fila
- ✅ Backward compatible - mensagens sem chave seguem flow normal

### Negativas:
- ⚠️ Requer que todos os handlers verificarem o idempotency_key
- ⚠️ Se a chave for gerada aleatoriamente sem persistência, não funciona
- ⚠️ Tabela `outbox_messages` pode crescer se chaves não forem reutilizadas

## Status

**Aprovado provisoriamente** - depende de implementação no adaptador WA-AKG e verificação nos handlers.

## Implementação Requerida

1. No `src/whatsapp/adapter.ts` (ou novo adaptador), adicionar verificação:
   ```typescript
   // Antes de enviar, verificar idempotency
   const existing = await prisma.outbox_messages.findFirst({
     where: { idempotency_key: data.idempotency_key }
   });
   if (existing) {
     // Já foi enviado, não enviar novamente
     return existing.message_id;
   }
   ```

2. Garantir que todos os pontos de entrada de envio (campanhas, follow-ups, API) passem `idempotency_key`

3. Migration para adicionar índice único se ainda não existir:
   ```sql
   CREATE UNIQUE INDEX outbox_messages_idempotency_key_idx ON outbox_messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
   ```

## Referências

- AGENTS.md regra #9: "Idempotência em webhooks, jobs, envios e processamento de mensagens"
- AGENTS.md regra #6: "WhatsApp só sai pela outbox + fila, com limites"
- `src/lib/webhook.ts` - existing pattern
- `src/whatsapp/adapter.ts` - WA-AKG adapter implementation

---
*Decisão registrada para aprovação humana antes da ativação em produção.*