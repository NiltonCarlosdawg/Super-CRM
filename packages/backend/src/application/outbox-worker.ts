// Worker de envio da outbox (Task 18B; docs/04 §7): o ÚNICO ponto onde se
// chama `provider.sendText` (docs/04 §7 — WhatsApp sai sempre pela outbox).
// Um tick = sweep + claim (SKIP LOCKED) + processamento SEQUENCIAL por linha
// (concorrência 1 ⇒ serialização por conta). Regras de resultado:
//  - accepted → outbox 'sent', mensagem 'sent' + provider_message_id;
//  - rejected → outbox 'failed', mensagem 'failed', dead-letter;
//  - unknown  → outbox 'unknown_delivery', mensagem CONTINUA 'queued' e
//    NUNCA é reenviada automaticamente (docs/04 §5 — reconciliação humana);
//  - CircuitOpenError → requeue SEM gastar tentativa (restaura attempts);
//  - ProviderUnavailableError transitório → backoff exponencial até
//    maxAttempts; depois failed + dead-letter;
//  - erro não-transiente (bug, payload inválido) → repropagar (dead-letter
//    do job na fila).

import {
  incrementAttempts,
  loadSendContext,
  setMessageState,
  setOutboxState,
  sweepAndClaim,
} from '../adapters/db/outbox.js';
import type { DbClient } from '../adapters/db/index.js';
import { maskPhone } from '../domain/phone.js';
import type { AccountLifecycle } from '../ports/accounts.js';
import type { Audit } from '../ports/audit.js';
import {
  CircuitOpenError,
  ProviderUnavailableError,
  type MessagingProvider,
} from '../ports/messaging-provider.js';
import type { NotifyEvent } from '../ports/notify.js';

export interface OutboxWorkerDeps {
  db: DbClient;
  provider: MessagingProvider;
  accounts: AccountLifecycle;
  notifySink: (e: NotifyEvent) => Promise<void>;
  /** Reservado (plano inclui-o no deps): auditoria do envio — usar em T20+. */
  audit: Audit;
  now(): Date;
  random(): number; // injetável (jitter; testes usam 0)
  logger: {
    info(obj: object, msg?: string): void;
    warn(obj: object, msg?: string): void;
    error(obj: object, msg?: string): void;
  };
  cfg: { sendTimeoutMs: number; maxAttempts: number; retryDelayMs: number };
}

export async function runOutboxTick(
  deps: OutboxWorkerDeps,
): Promise<{ claimed: number; sent: number }> {
  const { db, provider, accounts, notifySink, logger, cfg } = deps;
  const at = deps.now();

  // Sweep: 'sending' mais velho que o timeout + folga = órfã de crash.
  const { stale, rows } = await sweepAndClaim(db, {
    now: at,
    staleBefore: new Date(at.getTime() - (cfg.sendTimeoutMs + 10_000)),
    limit: 10,
  });
  if (stale > 0) logger.warn({ reason: 'stale_sending', stale }, 'outbox.sweep');

  let sent = 0;
  // Processamento sequencial: ordem do claim (priority, scheduledAt).
  for (const row of rows) {
    const ctx = await loadSendContext(db, { accountId: row.accountId, messageId: row.messageId });
    if (ctx.msg === null) {
      // Impossível com as FKs (dado corrompido): não-transiente → repropagar.
      throw new Error(`outbox ${row.id}: mensagem ${row.messageId} sem contexto de envio`);
    }
    if (ctx.msg.body === null) {
      // Mídia sem legenda não tem texto para sendText (nenhum caminho a cria
      // em Fase 1: o enqueue exige texto) → não-transiente → repropagar.
      throw new Error(`outbox ${row.id}: mensagem ${row.messageId} sem corpo de texto`);
    }
    if (ctx.account === null || ctx.account.status !== 'connected') {
      // Conta ausente/não-connected: adia SEM gastar tentativa — as mensagens
      // saem da cabeça e não bloqueiam as outras (docs/04 §7).
      await setOutboxState(
        db,
        row.id,
        { status: 'queued', scheduledAt: new Date(at.getTime() + cfg.retryDelayMs) },
        at,
      );
      continue;
    }

    // Claim de envio: attempts++ SÓ quando se chama o provider (docs/04 §7).
    const attemptsNow = await incrementAttempts(db, row.id, at);

    let outcome: 'accepted' | 'rejected' | 'unknown';
    let providerMessageId: string | null;
    try {
      const result = await provider.sendText({
        sessionId: ctx.account.providerSessionId,
        to: ctx.msg.to,
        text: ctx.msg.body,
        idempotencyKey: row.idempotencyKey, // chave do chamador: estável entre tentativas
      });
      outcome = result.outcome;
      providerMessageId = result.providerMessageId;
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        // Breaker aberto: adia como o defer, RESTAURANDO a tentativa do claim.
        await setOutboxState(
          db,
          row.id,
          {
            status: 'queued',
            scheduledAt: new Date(at.getTime() + cfg.retryDelayMs),
            attempts: row.attempts,
          },
          at,
        );
        continue;
      }
      if (error instanceof ProviderUnavailableError) {
        if (attemptsNow < cfg.maxAttempts) {
          const backoff = cfg.retryDelayMs * 2 ** attemptsNow + Math.floor(deps.random() * 251);
          await setOutboxState(
            db,
            row.id,
            { status: 'queued', scheduledAt: new Date(at.getTime() + backoff) },
            at,
          );
        } else {
          await setOutboxState(db, row.id, { status: 'failed' }, at);
          await setMessageState(db, row.messageId, 'failed', at);
          logger.error(
            { deadLetter: true, outboxId: row.id, attempts: attemptsNow },
            'outbox.dead_letter',
          );
        }
        continue;
      }
      throw error; // não-transiente (zod do adapter, bug) → dead-letter do job
    }

    if (outcome === 'accepted') {
      await setOutboxState(db, row.id, { status: 'sent' }, at);
      await setMessageState(db, row.messageId, 'sent', at, providerMessageId ?? undefined);
      await accounts.recordSendResult({ accountId: row.accountId, ok: true, at });
      await notifySink({
        type: 'message',
        phase: 'status',
        messageId: row.messageId,
        conversationId: ctx.msg.conversationId,
        accountId: row.accountId,
        sender: ctx.msg.sender,
        status: 'sent',
        providerMessageId,
        createdAt: at,
      });
      logger.info({ phone: maskPhone(ctx.msg.to), outboxId: row.id }, 'outbox.sent');
      sent += 1;
    } else if (outcome === 'rejected') {
      await setOutboxState(db, row.id, { status: 'failed' }, at);
      await setMessageState(db, row.messageId, 'failed', at);
      await accounts.recordSendResult({ accountId: row.accountId, ok: false, at });
      logger.error({ deadLetter: true, outboxId: row.id }, 'outbox.rejected');
    } else {
      // Timeout/desconhecido: mensagem continua 'queued' e NUNCA reenvia
      // automaticamente (docs/04 §5) — humano reconcilia.
      await setOutboxState(db, row.id, { status: 'unknown_delivery' }, at);
      await accounts.recordSendResult({ accountId: row.accountId, ok: false, at });
      logger.error({ reason: 'send_unknown', outboxId: row.id }, 'outbox.unknown');
    }
  }

  return { claimed: rows.length, sent };
}
