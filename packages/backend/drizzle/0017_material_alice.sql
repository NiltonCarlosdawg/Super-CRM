CREATE TYPE "public"."pause_reason" AS ENUM('failure_rate', 'session_down', 'opt_out_spike', 'human');--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "pause_reason" "pause_reason";--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "paused_by_id" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "resumed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "resumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "create_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "create_request_hash" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "start_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "start_request_hash" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_paused_by_id_users_id_fk" FOREIGN KEY ("paused_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_resumed_by_id_users_id_fk" FOREIGN KEY ("resumed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_create_idempotency_key_uq" ON "campaigns" USING btree ("create_idempotency_key") WHERE "campaigns"."create_idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_start_idempotency_key_uq" ON "campaigns" USING btree ("start_idempotency_key") WHERE "campaigns"."start_idempotency_key" is not null;