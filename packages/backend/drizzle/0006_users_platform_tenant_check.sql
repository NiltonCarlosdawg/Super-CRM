-- Onda 1, Task 2: invariante do isolamento (spec multitenant §4.3) —
-- (role = 'platform_admin') = (tenant_id IS NULL): o platform admin não pertence
-- a nenhum tenant; todos os outros papéis têm tenant obrigatório.
-- BEGIN explícito: como 0005 fecha a transação, estas instruções correm numa
-- transação própria (fechada pelo `commit` final do migrator) — o valor
-- 'platform_admin' do enum tem de estar commitado antes de o CHECK o usar.
BEGIN;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "tenant_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_platform_tenant_check" CHECK (((role = 'platform_admin') = (tenant_id IS NULL)));
