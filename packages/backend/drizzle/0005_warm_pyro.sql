-- Onda 1, Task 2: valor 'platform_admin' do enum user_role (spec multitenant §4.3).
--
-- PORQUÊ ESTE FICHEIRO TERMINA EM COMMIT (trap da migração): o PostgreSQL proíbe
-- USAR um valor novo de enum na mesma transação que o ADD VALUE ("unsafe use of
-- new value") e o CHECK da migração seguinte usa 'platform_admin'. O migrator do
-- Drizzle (drizzle-orm `migrate` E `drizzle-kit migrate`) aplica TODAS as
-- migrações pendentes numa única transação — o split em 0005/0006 só cumpre o
-- seu propósito se o ADD VALUE ficar commitado antes de o CHECK correr, por isso
-- esta migração fecha a transação. O `commit` final do migrator sobre uma
-- transação vazia é só WARNING (nunca erro) — verificado em PG16.
ALTER TYPE "public"."user_role" ADD VALUE 'platform_admin';
--> statement-breakpoint
COMMIT;
