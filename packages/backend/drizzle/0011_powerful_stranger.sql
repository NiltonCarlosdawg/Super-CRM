-- ADR-0002/A4: embeddings do conhecimento passam a 384 dimensões
-- (multilingual-e5-small). O índice HNSW tem de sair antes do ALTER TYPE e
-- voltar a ser criado depois (a dimensão faz parte da definição do índice).
DROP INDEX "knowledge_chunks_embedding_idx";--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ALTER COLUMN "embedding" SET DATA TYPE vector(384);--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
ALTER TABLE "knowledge_docs" ADD COLUMN "slug" text;--> statement-breakpoint
UPDATE "knowledge_docs" SET "slug" = 'doc-' || "id"::text WHERE "slug" IS NULL;--> statement-breakpoint
ALTER TABLE "knowledge_docs" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "slug" text;--> statement-breakpoint
UPDATE "rules" SET "slug" = 'rule-' || "id"::text WHERE "slug" IS NULL;--> statement-breakpoint
ALTER TABLE "rules" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_docs_tenant_slug_uq" ON "knowledge_docs" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "rules_tenant_slug_uq" ON "rules" USING btree ("tenant_id","slug");
