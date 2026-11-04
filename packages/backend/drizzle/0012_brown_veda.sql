ALTER TABLE "rules" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "review_every_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
CREATE INDEX "rules_status_valid_idx" ON "rules" USING btree ("status","valid_until");