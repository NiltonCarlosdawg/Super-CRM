// Ports do orquestrador sobre Postgres (docs/05 §3-§5; plano Fase 1 Task 14).
// Todo o SQL é parametrizado (sql`` — nunca concat, docs/02 §5) e recebe
// $now = deps.now() explícito: o relógio é controlado para os testes e para o
// claim de idempotência (stale re-claim após claimTtlMs).

import { sql } from 'drizzle-orm';
import type { DbClient } from './index.js';
import { normalizeQuestion } from '../../domain/question.js';
import type { NotifyEvent } from '../../ports/notify.js';
import type {
  AiMode,
  CatalogFact,
  ConversationState,
  LineSlug,
  NewHandoff,
  Ports,
  Priority,
  QualificationQuestion,
  RuleDef,
  TraceInput,
  TriggerDef,
  Turn,
} from '../../ports/ai-provider.js';

// Re-export do tipo único (ports/notify.ts): a superfície pública deste módulo
// mantém-se da Task 14; a fonte passou a ser ports (application consome-a).
export type { NotifyEvent };

/** Vocabulário de linhas do domínio (docs/01 §6) — slug fora disto é erro, nunca se adivinha. */
const LINE_SLUGS: readonly string[] = ['software', 'custom', 'telecom', 'cctv'];

function toLineSlug(slug: string): LineSlug {
  if (!LINE_SLUGS.includes(slug)) throw new Error(`slug de linha desconhecido: ${slug}`);
  return slug as LineSlug;
}

export interface OrchestratorPortsDeps {
  db: DbClient;
  notifySink: (e: NotifyEvent) => Promise<void>;
  /** WA_CLAIM_TTL_MS: idade mínima de um claim para re-claim (crash a meio). */
  claimTtlMs: number;
  /** Usado como $now em TODO o SQL (relógio controlado nos testes). */
  now(): Date;
  /** Fase 2/3 ligam searchChunks + embeddings; default nunca inventa fonte. */
  retrieve?: Ports['retrieve'];
  /** Default 20. */
  turnsLimit?: number;
}

export function createOrchestratorPorts(
  deps: OrchestratorPortsDeps,
): Ports & { releaseClaim(eventId: string): Promise<void> } {
  const { db, notifySink, claimTtlMs, now } = deps;
  const retrieve: Ports['retrieve'] = deps.retrieve ?? (async () => []);
  const turnsLimit = deps.turnsLimit ?? 20;

  /** Linha (slug) → id, para os upserts; slug desconhecido → null (contagem global). */
  const lineIdBySlug = async (line: LineSlug | null): Promise<string | null> => {
    if (line === null) return null;
    const res = await db.execute(sql`SELECT id FROM business_lines WHERE slug = ${line}`);
    return (res.rows[0] as { id: string } | undefined)?.id ?? null;
  };

  return {
    /** Idempotência do webhook (docs/01 §6): claim com TTL para sobreviver a crash. */
    async claimMessage(messageId: string): Promise<boolean> {
      const ttlSecs = claimTtlMs / 1000;
      const res = await db.execute(sql`
        UPDATE inbound_events SET ai_claimed_at = ${now()}
        WHERE id = ${messageId}
          AND (ai_claimed_at IS NULL
               OR ai_claimed_at < ${now()}::timestamptz - make_interval(secs => ${ttlSecs}::double precision))
        RETURNING id`);
      return res.rows.length > 0;
    },

    /** Caminho de erro da Task 19: devolve o claim quando o processamento falha. */
    async releaseClaim(eventId: string): Promise<void> {
      await db.execute(sql`UPDATE inbound_events SET ai_claimed_at = NULL WHERE id = ${eventId}`);
    },

    async loadState(conversationId: string): Promise<ConversationState> {
      const rowRes = await db.execute(sql`
        SELECT c.id, c.ai_mode, c.miss_streak, bl.slug AS line_slug, l.qualification
        FROM conversations c
        LEFT JOIN business_lines bl ON bl.id = c.line_id
        LEFT JOIN leads l ON l.id = c.lead_id
        WHERE c.id = ${conversationId}`);
      const row = rowRes.rows[0] as
        | { id: string; ai_mode: AiMode; miss_streak: number; line_slug: string | null; qualification: Record<string, string> | null }
        | undefined;
      if (row === undefined) throw new Error(`conversa não encontrada: ${conversationId}`);

      // A mensagem atual já está guardada antes do orquestrador correr (docs/05 §3):
      // os últimos N em ordem desc, invertidos → asc, com o turno do cliente no fim.
      const turnRes = await db.execute(sql`
        SELECT direction, body FROM messages
        WHERE conversation_id = ${conversationId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${turnsLimit}`);
      const turns = (turnRes.rows as Array<{ direction: string; body: string | null }>)
        .reverse()
        .map((m): Turn => ({ from: m.direction === 'inbound' ? 'customer' : 'ai', text: m.body ?? '' }));

      return {
        id: row.id,
        line: row.line_slug === null ? null : toLineSlug(row.line_slug),
        aiMode: row.ai_mode,
        turns,
        answers: row.qualification ?? {},
        missStreak: row.miss_streak,
      };
    },

    async saveState(
      conversationId: string,
      patch: { aiMode?: AiMode; answers?: Record<string, string>; missStreak?: number },
    ): Promise<void> {
      await db.transaction(async (tx) => {
        if (patch.aiMode !== undefined || patch.missStreak !== undefined) {
          await tx.execute(sql`
            UPDATE conversations SET
              ai_mode = COALESCE(${patch.aiMode ?? null}::ai_mode, ai_mode),
              miss_streak = COALESCE(${patch.missStreak ?? null}::integer, miss_streak),
              updated_at = ${now()}
            WHERE id = ${conversationId}`);
        }
        if (patch.answers !== undefined) {
          // Só se a conversa tiver lead ligado (docs/01 §6): sem lead não há onde gravar.
          await tx.execute(sql`
            UPDATE leads SET qualification = ${JSON.stringify(patch.answers)}::jsonb, updated_at = ${now()}
            WHERE id = (SELECT lead_id FROM conversations WHERE id = ${conversationId})`);
        }
      });
    },

    retrieve,

    async lookupCatalog(query: string, line: LineSlug | null): Promise<CatalogFact[]> {
      if (line === null) return []; // catalog_items.line_id é NOT NULL: sem linha não há itens
      const res = await db.execute(sql`
        SELECT id, name, summary, pricing_mode, price_amount, currency, availability, version
        FROM catalog_items
        WHERE line_id = (SELECT id FROM business_lines WHERE slug = ${line})
          AND status = 'published'
          AND (valid_from IS NULL OR valid_from <= ${now()})
          AND (valid_until IS NULL OR valid_until >= ${now()})
          AND (name ILIKE ${`%${query}%`} OR summary ILIKE ${`%${query}%`})
        ORDER BY name`);
      return (res.rows as Array<Omit<CatalogFact, 'priceAmount'> & { price_amount: string | null }>).map((r) => ({
        id: r.id,
        name: r.name,
        summary: r.summary,
        pricingMode: r.pricingMode,
        priceAmount: r.price_amount,
        currency: r.currency,
        availability: r.availability,
        version: r.version,
      }));
    },

    async rules(line: LineSlug | null): Promise<RuleDef[]> {
      const res = await db.execute(sql`
        SELECT id, kind, title, instruction, params
        FROM rules
        WHERE status = 'published'
          AND (line_id IS NULL
               OR line_id = (SELECT id FROM business_lines WHERE slug = ${line}))
        ORDER BY priority DESC, id`);
      return (res.rows as Array<{ id: string; kind: string; title: string; instruction: string; params: Record<string, unknown> | null }>)
        .map((r) => ({ id: r.id, kind: r.kind, title: r.title, instruction: r.instruction, params: r.params }));
    },

    async questions(line: LineSlug | null): Promise<QualificationQuestion[]> {
      if (line === null) return []; // qualification_questions.line_id é NOT NULL: guião por linha
      const res = await db.execute(sql`
        SELECT key, question, required, position
        FROM qualification_questions
        WHERE active = true
          AND line_id = (SELECT id FROM business_lines WHERE slug = ${line})
        ORDER BY position, key`);
      return (res.rows as Array<{ key: string; question: string; required: boolean; position: number }>)
        .map((q) => ({ key: q.key, question: q.question, required: q.required, position: q.position }));
    },

    async triggers(line: LineSlug | null): Promise<TriggerDef[]> {
      const res = await db.execute(sql`
        SELECT t.id, t.code, t.description, t.detection_hint, t.action, t.priority, bl.slug AS line_slug
        FROM handoff_triggers t
        LEFT JOIN business_lines bl ON bl.id = t.line_id
        WHERE t.active = true
          AND (t.line_id IS NULL
               OR t.line_id = (SELECT id FROM business_lines WHERE slug = ${line}))
        ORDER BY t.code, t.id`);
      return (res.rows as Array<{
        id: string; code: string; description: string; detection_hint: string;
        action: 'handoff_now' | 'handoff_when_qualified' | 'flag_only';
        priority: Priority; line_slug: string | null;
      }>).map((t) => ({
        id: t.id,
        code: t.code,
        lineSlug: t.line_slug === null ? null : toLineSlug(t.line_slug),
        description: t.description,
        detectionHint: t.detection_hint,
        action: t.action,
        priority: t.priority,
      }));
    },

    async findOpenHandoff(conversationId: string): Promise<{ id: string; priority: Priority } | null> {
      const res = await db.execute(sql`
        SELECT id, priority FROM handoffs
        WHERE conversation_id = ${conversationId} AND status = 'pending'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`);
      const row = res.rows[0] as { id: string; priority: Priority } | undefined;
      return row === undefined ? null : { id: row.id, priority: row.priority };
    },

    async createHandoff(h: NewHandoff): Promise<string> {
      const res = await db.execute(sql`
        INSERT INTO handoffs (conversation_id, trigger_id, reason, summary, lead_snapshot, priority)
        VALUES (${h.conversationId}, ${h.triggerId}, ${h.reason}, ${h.summary},
                ${JSON.stringify(h.leadSnapshot)}::jsonb, ${h.priority}::handoff_priority)
        RETURNING id`);
      return (res.rows[0] as { id: string }).id;
    },

    /** Sobe só, por rank normal < high < urgent (nunca desce — docs/05 §4). */
    async bumpHandoffPriority(handoffId: string, priority: Priority): Promise<void> {
      await db.execute(sql`
        UPDATE handoffs SET priority = CASE
          WHEN ${priority}::handoff_priority = 'urgent' THEN 'urgent'::handoff_priority
          WHEN ${priority}::handoff_priority = 'high' AND priority <> 'urgent' THEN 'high'::handoff_priority
          ELSE priority
        END
        WHERE id = ${handoffId}`);
    },

    /** Agrupa repetições por pergunta normalizada + linha (docs/05 §5). */
    async recordGap(g: { question: string; conversationId: string; line: LineSlug | null }): Promise<void> {
      const normalized = normalizeQuestion(g.question);
      const lineId = await lineIdBySlug(g.line);
      const existing = await db.execute(sql`
        SELECT id FROM knowledge_gaps
        WHERE normalized_question = ${normalized} AND line_id IS NOT DISTINCT FROM ${lineId}
        LIMIT 1`);
      const id = (existing.rows[0] as { id: string } | undefined)?.id;
      if (id === undefined) {
        await db.execute(sql`
          INSERT INTO knowledge_gaps (question, normalized_question, conversation_id, line_id)
          VALUES (${g.question}, ${normalized}, ${g.conversationId}, ${lineId})`);
      } else {
        await db.execute(sql`
          UPDATE knowledge_gaps
          SET occurrences = occurrences + 1, conversation_id = ${g.conversationId}, last_seen_at = ${now()}
          WHERE id = ${id}`);
      }
    },

    async saveTrace(t: TraceInput): Promise<void> {
      await db.execute(sql`
        INSERT INTO answer_traces (conversation_id, question, answer, sources, model, handoff_id, latency_ms, is_test)
        VALUES (${t.conversationId}, ${t.question}, ${t.answer}, ${JSON.stringify(t.sources)}::jsonb,
                ${t.model}, ${t.handoffId}, ${t.latencyMs}, ${t.isTest})`);
    },

    /** Pass-through: o sink (realtime, Fase 3) decide o que faz com o evento. */
    async notify(e: Parameters<Ports['notify']>[0]): Promise<void> {
      await notifySink(e);
    },
  };
}
