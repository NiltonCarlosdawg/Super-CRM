DROP INDEX "qualification_questions_line_key_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "qualification_questions_tenant_line_key_uq" ON "qualification_questions" USING btree ("tenant_id","line_id","key");
