CREATE TYPE "public"."ai_mode" AS ENUM('ai_active', 'ai_suggest', 'human_only');--> statement-breakpoint
CREATE TYPE "public"."answer_type" AS ENUM('text', 'number', 'choice', 'boolean');--> statement-breakpoint
CREATE TYPE "public"."availability" AS ENUM('available', 'limited', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."catalog_kind" AS ENUM('product', 'service', 'plan', 'package');--> statement-breakpoint
CREATE TYPE "public"."chunk_source" AS ENUM('doc', 'catalog');--> statement-breakpoint
CREATE TYPE "public"."conversion_goal" AS ENUM('purchase', 'demo_request', 'proposal_request', 'installation_booking', 'quote_visit');--> statement-breakpoint
CREATE TYPE "public"."doc_type" AS ENUM('faq', 'policy', 'process', 'company_info', 'objection');--> statement-breakpoint
CREATE TYPE "public"."gap_status" AS ENUM('open', 'resolved', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."handoff_action" AS ENUM('handoff_now', 'handoff_when_qualified', 'flag_only');--> statement-breakpoint
CREATE TYPE "public"."handoff_priority" AS ENUM('urgent', 'high', 'normal');--> statement-breakpoint
CREATE TYPE "public"."handoff_status" AS ENUM('pending', 'accepted', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."knowledge_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."pricing_mode" AS ENUM('fixed', 'from', 'quote_only');--> statement-breakpoint
CREATE TYPE "public"."rule_kind" AS ENUM('may_promise', 'must_not_claim', 'discount_limit', 'payment_terms', 'tone');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."campaign_recipient_status" AS ENUM('pending', 'sent', 'failed', 'replied', 'opted_out');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text', 'audio', 'image', 'video', 'document', 'other');--> statement-breakpoint
CREATE TYPE "public"."message_sender" AS ENUM('customer', 'ai', 'human', 'campaign');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'delivered', 'read', 'failed');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'unknown_delivery');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'editor', 'agent');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_account_status" AS ENUM('connecting', 'connected', 'disconnected', 'suspected_ban');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_purpose" AS ENUM('support', 'sales', 'campaigns');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_id" uuid,
	"ip" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"step" integer DEFAULT 1 NOT NULL,
	"status" "campaign_recipient_status" DEFAULT 'pending' NOT NULL,
	"outbox_key" text,
	"enqueued_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"message_template" text NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"daily_limit" integer,
	"scheduled_at" timestamp with time zone,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"name" text,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"consent_at" timestamp with time zone,
	"consent_source" text,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_phone_e164_unique" UNIQUE("phone_e164")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"lead_id" uuid,
	"line_id" uuid,
	"ai_mode" "ai_mode" DEFAULT 'ai_suggest' NOT NULL,
	"miss_streak" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "followup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text NOT NULL,
	"stop_reason" text,
	"current_step" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone,
	"pending_text" text,
	"pending_trace_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "followup_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "followup_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"delay_hours" integer NOT NULL,
	"condition" text NOT NULL,
	"content_mode" text NOT NULL,
	"template_text" text,
	"ai_prompt" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "followup_steps_delay_ck" CHECK (delay_hours > 0)
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "inbound_events_provider_event_id_unique" UNIQUE("provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"line_id" uuid,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"owner_id" uuid,
	"qualification" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"sender" "message_sender" NOT NULL,
	"kind" "message_kind" DEFAULT 'text' NOT NULL,
	"body" text,
	"provider_message_id" text,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" "outbox_status" DEFAULT 'queued' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_messages_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"phone_e164" text NOT NULL,
	"provider" text DEFAULT 'wa-akg' NOT NULL,
	"provider_session_id" text NOT NULL,
	"status" "whatsapp_account_status" DEFAULT 'connecting' NOT NULL,
	"purpose" "whatsapp_purpose" NOT NULL,
	"daily_send_cap" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_accounts_phone_e164_unique" UNIQUE("phone_e164"),
	CONSTRAINT "whatsapp_accounts_provider_session_id_unique" UNIQUE("provider_session_id")
);
--> statement-breakpoint
CREATE TABLE "answer_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"is_test" boolean DEFAULT false NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"sources" jsonb NOT NULL,
	"model" text NOT NULL,
	"handoff_id" uuid,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"conversion_goal" "conversion_goal" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "business_lines_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_id" uuid NOT NULL,
	"kind" "catalog_kind" NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text NOT NULL,
	"details" jsonb,
	"pricing_mode" "pricing_mode" NOT NULL,
	"price_amount" numeric(14, 2),
	"currency" text DEFAULT 'AOA' NOT NULL,
	"price_note" text,
	"availability" "availability" DEFAULT 'available' NOT NULL,
	"status" "knowledge_status" DEFAULT 'draft' NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"owner_id" uuid NOT NULL,
	"reviewed_at" timestamp with time zone,
	"review_every_days" integer DEFAULT 90 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_items_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "handoff_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_id" uuid,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"detection_hint" text NOT NULL,
	"action" "handoff_action" DEFAULT 'handoff_now' NOT NULL,
	"priority" "handoff_priority" DEFAULT 'normal' NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_id" uuid,
	"reason" text NOT NULL,
	"summary" text NOT NULL,
	"lead_snapshot" jsonb,
	"priority" "handoff_priority" DEFAULT 'normal' NOT NULL,
	"status" "handoff_status" DEFAULT 'pending' NOT NULL,
	"accepted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "chunk_source" NOT NULL,
	"doc_id" uuid,
	"catalog_item_id" uuid,
	"position" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_id" uuid,
	"type" "doc_type" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "knowledge_status" DEFAULT 'draft' NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"owner_id" uuid NOT NULL,
	"reviewed_at" timestamp with time zone,
	"review_every_days" integer DEFAULT 90 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question" text NOT NULL,
	"normalized_question" text NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"conversation_id" uuid,
	"line_id" uuid,
	"status" "gap_status" DEFAULT 'open' NOT NULL,
	"resolved_by_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changed_by_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"gap_id" uuid,
	"ai_answer" text,
	"human_answer" text NOT NULL,
	"proposed_title" text NOT NULL,
	"proposed_body" text NOT NULL,
	"target_doc_id" uuid,
	"status" "suggestion_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qualification_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_id" uuid NOT NULL,
	"key" text NOT NULL,
	"question" text NOT NULL,
	"answer_type" "answer_type" DEFAULT 'text' NOT NULL,
	"choices" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_id" uuid,
	"kind" "rule_kind" NOT NULL,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"params" jsonb,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" "knowledge_status" DEFAULT 'draft' NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_accounts" ADD CONSTRAINT "campaign_accounts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_accounts" ADD CONSTRAINT "campaign_accounts_account_id_whatsapp_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."whatsapp_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_account_id_whatsapp_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."whatsapp_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_whatsapp_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."whatsapp_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_line_id_business_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."business_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_runs" ADD CONSTRAINT "followup_runs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_runs" ADD CONSTRAINT "followup_runs_sequence_id_followup_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."followup_sequences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_runs" ADD CONSTRAINT "followup_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_runs" ADD CONSTRAINT "followup_runs_account_id_whatsapp_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."whatsapp_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_runs" ADD CONSTRAINT "followup_runs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_sequences" ADD CONSTRAINT "followup_sequences_line_id_business_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."business_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_sequences" ADD CONSTRAINT "followup_sequences_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_steps" ADD CONSTRAINT "followup_steps_sequence_id_followup_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."followup_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_line_id_business_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."business_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_whatsapp_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."whatsapp_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_account_id_whatsapp_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."whatsapp_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_traces" ADD CONSTRAINT "answer_traces_handoff_id_handoffs_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."handoffs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_line_id_business_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."business_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_triggers" ADD CONSTRAINT "handoff_triggers_line_id_business_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."business_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_trigger_id_handoff_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."handoff_triggers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_doc_id_knowledge_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."knowledge_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_docs" ADD CONSTRAINT "knowledge_docs_line_id_business_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."business_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_line_id_business_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."business_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_suggestions" ADD CONSTRAINT "knowledge_suggestions_gap_id_knowledge_gaps_id_fk" FOREIGN KEY ("gap_id") REFERENCES "public"."knowledge_gaps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_suggestions" ADD CONSTRAINT "knowledge_suggestions_target_doc_id_knowledge_docs_id_fk" FOREIGN KEY ("target_doc_id") REFERENCES "public"."knowledge_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_questions" ADD CONSTRAINT "qualification_questions_line_id_business_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."business_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_line_id_business_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."business_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_accounts_uq" ON "campaign_accounts" USING btree ("campaign_id","account_id");--> statement-breakpoint
CREATE INDEX "campaign_accounts_account_idx" ON "campaign_accounts" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_delivery_uq" ON "campaign_recipients" USING btree ("campaign_id","contact_id","step");--> statement-breakpoint
CREATE INDEX "campaign_recipients_account_status_idx" ON "campaign_recipients" USING btree ("account_id","status","enqueued_at");--> statement-breakpoint
CREATE INDEX "campaign_recipients_campaign_status_idx" ON "campaign_recipients" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "contacts_consent_optout_idx" ON "contacts" USING btree ("marketing_consent","opted_out_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_account_contact_uq" ON "conversations" USING btree ("account_id","contact_id");--> statement-breakpoint
CREATE INDEX "conversations_lastmsg_idx" ON "conversations" USING btree ("last_message_at","id");--> statement-breakpoint
CREATE INDEX "conversations_account_lastmsg_idx" ON "conversations" USING btree ("account_id","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "followup_runs_due_idx" ON "followup_runs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "followup_runs_lead_idx" ON "followup_runs" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "followup_runs_conversation_idx" ON "followup_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "followup_runs_account_idx" ON "followup_runs" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "followup_sequences_line_name_uq" ON "followup_sequences" USING btree ("line_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "followup_steps_sequence_position_uq" ON "followup_steps" USING btree ("sequence_id","position");--> statement-breakpoint
CREATE INDEX "inbound_events_pending_idx" ON "inbound_events" USING btree ("received_at") WHERE "inbound_events"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "leads_contact_idx" ON "leads" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "leads_line_idx" ON "leads" USING btree ("line_id");--> statement-breakpoint
CREATE INDEX "leads_owner_idx" ON "leads" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_account_provider_uq" ON "messages" USING btree ("account_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at","id");--> statement-breakpoint
CREATE INDEX "outbox_messages_claim_idx" ON "outbox_messages" USING btree ("status","priority","scheduled_at");--> statement-breakpoint
CREATE INDEX "outbox_messages_account_status_idx" ON "outbox_messages" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "whatsapp_accounts_status_idx" ON "whatsapp_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "whatsapp_accounts_purpose_idx" ON "whatsapp_accounts" USING btree ("purpose");--> statement-breakpoint
CREATE INDEX "answer_traces_conversation_idx" ON "answer_traces" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "answer_traces_test_created_idx" ON "answer_traces" USING btree ("is_test","created_at");--> statement-breakpoint
CREATE INDEX "catalog_items_status_valid_idx" ON "catalog_items" USING btree ("status","valid_until");--> statement-breakpoint
CREATE INDEX "catalog_items_line_idx" ON "catalog_items" USING btree ("line_id");--> statement-breakpoint
CREATE INDEX "handoff_triggers_line_active_idx" ON "handoff_triggers" USING btree ("line_id","active");--> statement-breakpoint
CREATE INDEX "handoffs_queue_idx" ON "handoffs" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE INDEX "handoffs_conversation_idx" ON "handoffs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_chunks_active_idx" ON "knowledge_chunks" USING btree ("active");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_doc_idx" ON "knowledge_chunks" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_catalog_idx" ON "knowledge_chunks" USING btree ("catalog_item_id");--> statement-breakpoint
CREATE INDEX "knowledge_docs_status_valid_idx" ON "knowledge_docs" USING btree ("status","valid_until");--> statement-breakpoint
CREATE INDEX "knowledge_docs_line_type_idx" ON "knowledge_docs" USING btree ("line_id","type");--> statement-breakpoint
CREATE INDEX "knowledge_gaps_status_occ_idx" ON "knowledge_gaps" USING btree ("status","occurrences");--> statement-breakpoint
CREATE INDEX "knowledge_gaps_normalized_idx" ON "knowledge_gaps" USING btree ("normalized_question");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_revisions_entity_version_uq" ON "knowledge_revisions" USING btree ("entity_type","entity_id","version");--> statement-breakpoint
CREATE INDEX "knowledge_revisions_entity_idx" ON "knowledge_revisions" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "knowledge_suggestions_status_idx" ON "knowledge_suggestions" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "qualification_questions_line_key_uq" ON "qualification_questions" USING btree ("line_id","key");--> statement-breakpoint
CREATE INDEX "rules_status_line_idx" ON "rules" USING btree ("status","line_id");