CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
INSERT INTO "tenants" ("id", "name", "status") VALUES ('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'MilVendas', 'active');--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "audit_log" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_tenant_idx" ON "audit_log" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_created_idx" ON "audit_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "campaign_accounts" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "campaign_accounts" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "campaign_accounts" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_accounts" ADD CONSTRAINT "campaign_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "campaign_recipients" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "campaign_recipients" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "campaigns" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "contacts" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_tenant_idx" ON "contacts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "contacts_tenant_created_idx" ON "contacts" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "conversations" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_tenant_idx" ON "conversations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "conversations_tenant_created_idx" ON "conversations" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "followup_runs" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "followup_runs" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "followup_runs" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "followup_runs" ADD CONSTRAINT "followup_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_sequences" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "followup_sequences" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "followup_sequences" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "followup_sequences" ADD CONSTRAINT "followup_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_steps" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "followup_steps" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "followup_steps" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "followup_steps" ADD CONSTRAINT "followup_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_events_tenant_idx" ON "inbound_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "inbound_events_tenant_received_idx" ON "inbound_events" USING btree ("tenant_id","received_at");--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "leads" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_tenant_idx" ON "leads" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "leads_tenant_created_idx" ON "leads" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "messages" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_tenant_idx" ON "messages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "messages_tenant_created_idx" ON "messages" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "outbox_messages" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "outbox_messages" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_messages_tenant_idx" ON "outbox_messages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "outbox_messages_tenant_created_idx" ON "outbox_messages" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "users" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "whatsapp_accounts" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD CONSTRAINT "whatsapp_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_traces" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "answer_traces" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "answer_traces" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "answer_traces" ADD CONSTRAINT "answer_traces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "catalog_items" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "catalog_items" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_triggers" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "handoff_triggers" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "handoff_triggers" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "handoff_triggers" ADD CONSTRAINT "handoff_triggers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "handoffs" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "handoffs" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "knowledge_chunks" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_docs" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "knowledge_docs" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "knowledge_docs" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_docs" ADD CONSTRAINT "knowledge_docs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "knowledge_gaps" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "knowledge_revisions" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_suggestions" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "knowledge_suggestions" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "knowledge_suggestions" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_suggestions" ADD CONSTRAINT "knowledge_suggestions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_questions" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "qualification_questions" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "qualification_questions" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "qualification_questions" ADD CONSTRAINT "qualification_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "rules" SET "tenant_id" = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';--> statement-breakpoint
ALTER TABLE "rules" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
