ALTER TABLE "knowledge_train_uploads" ALTER COLUMN "text" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_train_uploads" ADD COLUMN "content" "bytea";