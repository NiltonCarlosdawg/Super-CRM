// Treinar agente, Tasks 4 e 5: upload de documentos, fluxo guiado e rascunho.
// editor|admin (o `agent` não escreve conhecimento — spec §9), tenant da sessão
// em todas as queries, zod em todas as entradas e erros pela fronteira HTTP.
// O upload (documento ou passo a passo) é só a porta de entrada: extração e
// staging correm no job `knowledge.extract` (payload com o id do upload).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  deleteDraftItem,
  formatGuidedTranscript,
  listDraftItems,
  patchDraftItem,
  queueExtraction,
  TrainServiceError,
  type TrainDeps,
} from '../../../modules/knowledge/train-service.js';
import { diffDraft, validateDraft } from '../../../modules/knowledge/publish-service.js';
import { UnsupportedFormatError } from '../../../modules/knowledge/parsers.js';
import type { TenantScope } from '../../../ports/tenancy.js';
import type { HttpDeps } from '../app.js';
import { HttpError } from '../errors.js';
import { authenticate, requireAnyRole, requireTenant } from '../guards.js';

/** Limite da rota: 8 MiB de corpo JSON (o conteúdo vai em base64). */
const MAX_UPLOAD_BODY_BYTES = 36 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = Number(process.env.DOCUMENT_MAX_BYTES ?? 10 * 1024 * 1024);
const MAX_TOTAL_BYTES = Number(process.env.DOCUMENT_MAX_TOTAL_BYTES ?? 25 * 1024 * 1024);
const SUPPORTED_MEDIA = new Set(['text/plain', 'text/markdown', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

/** Base64 padrão com padding opcional (sem dependência nova). */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const lineSlugSchema = z.enum(['software', 'custom', 'telecom', 'cctv']);

const documentSchema = z
  .object({
    filename: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(100),
    contentBase64: z.string(),
  })
  .strict();

const uploadBodySchema = z
  .object({
    documents: z.array(documentSchema).min(1).max(10),
    lineSlug: lineSlugSchema.optional(),
  })
  .strict();

// Passo a passo (T5): cada resposta vira texto e entra no mesmo pipeline da T4.
const guidedAnswerSchema = z
  .object({
    question: z.string().min(1).max(300),
    answer: z.string().min(1).max(4000),
  })
  .strict();

const guidedBodySchema = z
  .object({
    lineSlug: lineSlugSchema,
    answers: z.array(guidedAnswerSchema).min(1),
  })
  .strict();

const idSchema = z.object({ id: z.uuid() });

const patchBodySchema = z
  .object({
    payload: z.record(z.string(), z.unknown()).optional(),
    lineSlug: lineSlugSchema.optional(),
    confirmLine: z.boolean().optional(),
  })
  .strict();

// Validação da carga: o diff já foi mostrado; aqui só chegam os conflitos que
// o utilizador decidiu aceitar explicitamente (nunca merge silencioso).
const validateBodySchema = z
  .object({
    acceptConflicts: z.array(z.string().min(1)).optional(),
  })
  .strict();

export async function knowledgeTrainRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  // Registo condicional em app.ts; `!` seguro por isso.
  const knowledge = deps.knowledge!;
  const db = knowledge.db;

  const scope = (request: FastifyRequest): TenantScope => {
    const tenantId = request.auth?.tenantId ?? null;
    if (tenantId === null) {
      throw new Error('scope de tenant ausente: rota de treino alcançada sem requireTenant?');
    }
    return { tenantId };
  };

  const mkDeps = (request: FastifyRequest): TrainDeps => ({
    db,
    scope: scope(request),
    audit: knowledge.audit,
    now: knowledge.now,
    ...(knowledge.embedder !== undefined ? { embedder: knowledge.embedder } : {}),
  });

  /** Converte erros do domínio de treino na resposta HTTP certa. */
  const mapTrainError = (error: unknown): never => {
    if (error instanceof TrainServiceError) {
      throw new HttpError(error.status, error.code, error.message);
    }
    if (error instanceof UnsupportedFormatError) {
      throw new HttpError(
        415,
        'unsupported_media_type',
        'PDF/OCR chegam com ADR pendente; nesta entrega só text/plain e text/markdown',
      );
    }
    throw error;
  };

  const guard = [
    authenticate({ sessions: deps.sessions, users: deps.users, tenancy: deps.tenancy }),
    requireTenant(),
    requireAnyRole('editor', 'admin'),
  ];

  app.post(
    '/v1/knowledge/train/documents',
    { preHandler: guard, bodyLimit: MAX_UPLOAD_BODY_BYTES },
    async (request, reply) => {
      const body = uploadBodySchema.parse(request.body);

      // Duas fases: descodificar/validar TODOS os documentos antes de criar o
      // primeiro upload (um documento inválido não deixa uploads parciais).
      let totalBytes = 0;
      const prepared = body.documents.map((doc) => {
        if (!SUPPORTED_MEDIA.has(doc.mediaType)) throw new HttpError(415, 'unsupported_format', `formato não suportado: ${doc.mediaType}`);
        if (!BASE64_PATTERN.test(doc.contentBase64)) {
          throw new HttpError(
            400,
            'invalid_content_base64',
            `documento '${doc.filename}': contentBase64 inválido`,
          );
        }
        try {
          const content = Buffer.from(doc.contentBase64, 'base64');
          if (content.length > MAX_DOCUMENT_BYTES) throw new HttpError(413, 'document_too_large', 'documento excede 10 MiB');
          totalBytes += content.length;
          if (totalBytes > MAX_TOTAL_BYTES) throw new HttpError(413, 'document_too_large', 'pedido excede 25 MiB');
          return { doc, content };
        } catch (error) {
          return mapTrainError(error);
        }
      });

      const tenantScope = scope(request);
      const changedById = request.auth!.userId;
      const uploadIds: string[] = [];
      try {
        for (const preparedDoc of prepared) {
          uploadIds.push(
            await queueExtraction(
              { db, scope: tenantScope, jobs: knowledge.jobs, now: knowledge.now },
              {
                filename: preparedDoc.doc.filename,
                mediaType: preparedDoc.doc.mediaType,
                content: preparedDoc.content,
                lineSlug: body.lineSlug ?? null,
                lineConfirmed: body.lineSlug !== undefined,
                changedById,
              },
              { correlationId: String(request.id) },
            ),
          );
        }
      } catch (error) {
        return mapTrainError(error);
      }

      return reply.status(202).send({ uploadIds });
    },
  );

  app.post('/v1/knowledge/train/guided', { preHandler: guard }, async (request, reply) => {
    const body = guidedBodySchema.parse(request.body);
    const tenantScope = scope(request);
    const changedById = request.auth!.userId;

    // `queueExtraction` valida a linha em `business_lines` antes de criar o
    // upload (linha em falta ⇒ 404 `line_not_found`, sem efeitos parciais).
    let uploadId: string;
    try {
      uploadId = await queueExtraction(
        { db, scope: tenantScope, jobs: knowledge.jobs, now: knowledge.now },
        {
          filename: 'passo-a-passo',
          mediaType: 'text/plain',
          text: formatGuidedTranscript(body.answers),
          lineSlug: body.lineSlug,
          lineConfirmed: true,
          changedById,
        },
        { correlationId: String(request.id) },
      );
    } catch (error) {
      return mapTrainError(error);
    }

    return reply.status(202).send({ uploadIds: [uploadId] });
  });

  app.get('/v1/knowledge/train/draft', { preHandler: guard }, async (request, reply) => {
    const items = await listDraftItems(mkDeps(request));
    return reply.send({ items });
  });

  // Diff de mesclagem (added/updated/unchanged/conflict/archived) para o painel
  // mostrar antes da confirmação única. Não escreve nada.
  app.get('/v1/knowledge/train/diff', { preHandler: guard }, async (request, reply) => {
    const result = await diffDraft(mkDeps(request));
    return reply.send(result);
  });

  // Publicação atómica aditiva. Linhas por confirmar ⇒ 422; conflitos não
  // aceites ⇒ 409 com as entradas no payload (ambos mapeados em `HttpError`).
  app.post('/v1/knowledge/train/validate', { preHandler: guard }, async (request, reply) => {
    const body = validateBodySchema.parse(request.body ?? {});
    try {
      const result = await validateDraft(mkDeps(request), {
        changedById: request.auth!.userId,
        ...(body.acceptConflicts !== undefined ? { acceptConflicts: body.acceptConflicts } : {}),
      });
      return reply.send(result);
    } catch (error) {
      return mapTrainError(error);
    }
  });

  app.patch('/v1/knowledge/train/draft/:id', { preHandler: guard }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const body = patchBodySchema.parse(request.body);
    try {
      const item = await patchDraftItem(mkDeps(request), id, body);
      return reply.send({ item });
    } catch (error) {
      return mapTrainError(error);
    }
  });

  app.delete('/v1/knowledge/train/draft/:id', { preHandler: guard }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    await deleteDraftItem(mkDeps(request), id);
    return reply.status(204).send();
  });
}
