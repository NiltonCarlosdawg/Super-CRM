CREATE TYPE "public"."upload_status" AS ENUM('pending', 'processing', 'done', 'error');--> statement-breakpoint
CREATE TABLE "knowledge_draft_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"entity_type" text NOT NULL,
	"op" text NOT NULL,
	"line_slug" text,
	"line_confirmed" boolean DEFAULT false NOT NULL,
	"payload" jsonb NOT NULL,
	"chunks" jsonb,
	"base_version" integer,
	"changed_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"applied" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_train_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"text" text NOT NULL,
	"status" "upload_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"line_slug" text,
	"line_confirmed" boolean DEFAULT false NOT NULL,
	"changed_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_items" DROP CONSTRAINT "catalog_items_slug_unique";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD COLUMN "publication_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_draft_items" ADD CONSTRAINT "knowledge_draft_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_publications" ADD CONSTRAINT "knowledge_publications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_train_uploads" ADD CONSTRAINT "knowledge_train_uploads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_items_tenant_slug_uq" ON "knowledge_draft_items" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "publications_tenant_key_uq" ON "knowledge_publications" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "train_uploads_tenant_status_idx" ON "knowledge_train_uploads" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_publication_id_knowledge_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."knowledge_publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_items_tenant_slug_uq" ON "catalog_items" USING btree ("tenant_id","slug");