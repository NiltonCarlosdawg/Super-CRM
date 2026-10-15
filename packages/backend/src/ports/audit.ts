// Port de auditoria (docs/01 §6): quem fez o quê e quando — ações humanas E
// da IA. Assinatura EXATA citada pelas Fases 2 e 4 (CampaignAudit).

export interface Audit {
  record(input: {
    actorId: string | null; // null = ação de sistema (webhook, job)
    action: string; // ex.: 'auth.login', 'account.status_changed'
    entity: string;
    entityId: string;
    detail?: Record<string, unknown>;
    at: Date; // relógio controlado nos testes
    ip?: string | null;
  }): Promise<void>;
}
