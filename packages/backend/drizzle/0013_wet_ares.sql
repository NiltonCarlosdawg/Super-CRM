ALTER TABLE "handoff_triggers" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "qualification_questions" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_triggers_tenant_line_code_uq" ON "handoff_triggers" USING btree ("tenant_id", "line_id", "code") WHERE "line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_triggers_tenant_global_code_uq" ON "handoff_triggers" USING btree ("tenant_id", "code") WHERE "line_id" IS NULL;
