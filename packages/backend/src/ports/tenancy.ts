// Âmbito de tenant (Onda 1, multitenancy — spec
// docs/superpowers/specs/2026-10-16-multitenant-design.md §4.3): todo o acesso
// a dados de negócio leva o âmbito do utilizador autenticado; a plataforma
// (platform_admin, sem tenant) usa as rotas próprias (Task 7).

/** Âmbito com que os repositórios operam: o tenant do utilizador autenticado. */
export type TenantScope = { tenantId: string };

/** Estado do tenant, consultado pelo guard de auth por pedido (Task 3). */
export interface TenancyPort {
  getStatus(tenantId: string): Promise<'active' | 'suspended' | null>;
}
