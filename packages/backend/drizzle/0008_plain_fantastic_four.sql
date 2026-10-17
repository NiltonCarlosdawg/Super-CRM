ALTER TABLE "contacts" DROP CONSTRAINT "contacts_phone_e164_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_tenant_phone_unique" ON "contacts" USING btree ("tenant_id","phone_e164");