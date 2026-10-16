// Port de auditoria (docs/01 §6): quem fez o quê e quando — ações humanas E
// da IA. Assinatura EXATA citada pelas Fases 2 e 4 (CampaignAudit).

export interface Audit {
  record(input: {
    /** Onda 1 (Task 4): dono do registo. NULL só para ações de plataforma/
     *  sistema sem tenant (ex.: login de platform_admin; spec §4.2). */
    tenantId: string | null;
    actorId: string | null; // null = ação de sistema (webhook, job)
    action: string; // ex.: 'auth.login', 'account.status_changed'
    entity: string;
    entityId: string;
    detail?: Record<string, unknown>;
    at: Date; // relógio controlado nos testes
    ip?: string | null;
  }): Promise<void>;
}
