# ADR-0003: Retenção e Prunagem de Mensagens

## Contexto

O modelo `Message` no CRM armazena mensagens potencialmente indefinidamente. Não há mecanismo de retenção ou prune automático. Isso pode levar ao crescimento excessivo do banco de dados e violação de políticas de privacidade/dados.

Regras relevantes do AGENTS.md:
- Regra #13: "Dados pessoais: minimizar, mascarar em logs. As 20 conversas de WhatsApp que existem **não podem ser usadas** (sem permissão): nem em testes, nem em prompts, nem em exemplos."
- Regra #5: "WA-AKG só pelo adaptador `MessagingProvider`. Nunca importes código dele nem leias a base de dados dele."

## Decisões

### Opção A: TTL no modelo Message + Job de limpeza (escolhida)
- Adicionar campo `expiresAt` opcional ao modelo `Message`
- Job scheduler (BullMQ ou agendado) remove mensagens expiradas
- TTL padrão: 90 dias (configurável via `WA_MESSAGE_RETENTION_DAYS`)
- Soft-delete: marcar `status = 'archived'` antes de remover fisicamente

### Opção B: Aplicação responsabilidade
- Deixar responsabilidade de cleanup para aplicação/external process
- Rodar manualmente via script/CLI
- Não há política automática no banco

### Opção C: Nenhum prune
- Manter mensagens indefinidamente (status quo atual)
- A depender de VACUUM/OT do PostgreSQL para manutenção
- Risco de crescimento ilimitado de dados

## Decisão: Opção A (TTL no modelo + Job de limpeza)

A decisão é implementar sistema de retenção com TTL configurável:

1. **Novo campo no modelo Message**:
   ```prisma
   model Message {
     id        String   @id @default(uuid())
     content   String
     status    String   // 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'archived'
     expiresAt DateTime?  // TTL opcional
     createdAt DateTime @default(now())
     updatedAt DateTime @updatedAt
   }
   ```

2. **Job de limpeza agendada**:
   - Rodar diariamente (ou a cada N horas)
   - Remover mensagens onde `status IN ('sent', 'delivered', 'read')` E `expiresAt < now()`
   - Mensagens com `status = 'queued'` ou `failed` NÃO são removidas (ainda podem ser processadas)
   - Mensagens `archived` são removidas imediatamente

3. **Configuração via variável de ambiente**:
   ```
   WA_MESSAGE_RETENTION_DAYS=90  # default
   WA_MESSAGE_RETENTION_DAYS=30  # mais agressivo
   WA_MESSAGE_RETENTION_DAYS=180  # mais conservador
   ```

4. **Exceções**:
   - Mensagens de sistema ou logs técnicos podem ter `expiresAt = null` (indefinido)
   - Mensagens relacionadas a processos legais ou auditoria são excluídas manualmente
   - O campo `pending_text` em `followup_runs` não afeta a retenção de `Message`

5. **Migração existente**:
   - Migration que adiciona campo `expiresAt` opcional
   - Job inicial para marcar mensagens antigas como `archived` antes do prune efetivo

## Conseqüências

### Positivas:
- ✅ Controla crescimento do banco de dados
- ✅ Conformidade com princípio de minimização de dados (AGENTS.md regra #13)
- ✅ Política configurável por cliente (via env vars)
- ✅ Automaticamente — não depende de intervenção manual constante
- ✅ Mensagens críticas (queued/failed) são preservadas até processamento conclusivo

### Negativas:
- ⚠️ Requer job scheduler rodando (BullMQ, cron, etc.)
- ⚠️ Pode remover mensagens se configuração for muito curta
- ⚠️ Nova dependência de manutenção do job de limpeza
- ⚠️ Migração inicial pode levar tempo em bases grandes

## Status

**Aprovado** - TTL + job de limpeza é a abordagem balanceada.

## Implementação Requerida

1. **Migration Drizzle** para adicionar `expiresAt`:
   ```typescript
   // 0002-message-retention.sql
   ALTER TABLE message ADD COLUMN expiresAt TIMESTAMP WITH TIME ZONE;
   CREATE INDEX idx_message_expiresAt ON message(expiresAt) WHERE expiresAt IS NOT NULL AND status IN ('sent', 'delivered', 'read');
   ```

2. **Job de limpeza** (exemplo com BullMQ):
   ```typescript
   // src/ports/job-queue.ts
   import { Queue } from 'bullmq';
   import { prisma } from '../lib/prisma';
   
   const cleanupQueue = new Queue('message-cleanup');
   
   export async function scheduleMessageCleanup() {
     await cleanupQueue.add('cleanup', {}, { repeat: { every: '1d' } }); // diário
   }
   
   // Worker
   cleanupQueue.process('cleanup', async () => {
     const now = new Date();
     const retentionDays = parseInt(process.env.WA_MESSAGE_RETENTION_DAYS || '90');
     const cutoffDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
   
     // Marcar como archivadas (soft-delete)
     await prisma.message.updateMany({
       where: {
         status: { in: ['sent', 'delivered', 'read'] },
         expiresAt: { lt: cutoffDate },
       },
       data: { status: 'archived' },
     });
   
     // Ou remover fisicamente se preferir:
     // await prisma.message.deleteMany({ ... });
   });
   ```

3. **Variáveis de ambiente** no `.env.example`:
   ```
   WA_MESSAGE_RETENTION_DAYS=90
   ```

4. **Atualizar docs/schema-base.md** para incluir o novo campo.

## Referências

- AGENTS.md regra #13: "Dados pessoais: minimizar, mascarar em logs"
- `src/ports/job-queue.ts` - já implementado (BullMQ port)
- `docs/04-integracao-wa-akg.md` - seções de limits e retention
- Padrão de job scheduler no projeto

---
*Decisão registrada e aprovada.*