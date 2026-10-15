CREATE TYPE "public"."lead_stage" AS ENUM('open', 'won', 'lost');--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "stage" SET DEFAULT 'open'::"public"."lead_stage";--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "stage" SET DATA TYPE "public"."lead_stage" USING "stage"::"public"."lead_stage";--> statement-breakpoint
ALTER TABLE "inbound_events" ADD COLUMN "ai_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_ref" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "mfa_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "status";