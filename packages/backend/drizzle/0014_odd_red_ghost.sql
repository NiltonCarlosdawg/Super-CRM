ALTER TABLE "knowledge_suggestions" ADD COLUMN "created_by_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_suggestions" ADD COLUMN "proposed_line_slug" text;--> statement-breakpoint
ALTER TABLE "knowledge_suggestions" ADD COLUMN "proposed_doc_type" "doc_type";--> statement-breakpoint
ALTER TABLE "knowledge_suggestions" ADD COLUMN "staged_item_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_suggestions" ADD CONSTRAINT "knowledge_suggestions_staged_item_id_knowledge_draft_items_id_fk" FOREIGN KEY ("staged_item_id") REFERENCES "public"."knowledge_draft_items"("id") ON DELETE no action ON UPDATE no action;