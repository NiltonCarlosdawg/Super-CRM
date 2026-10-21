// Evento de notificação ao painel (docs/02 §9) — fonte única do tipo,
// consumido por ports/application (orquestrador, ciclo de vida de contas) e
// materializado pelos adaptadores (realtime da Task 15, orquestrador da 14).
// Pass-through dos campos extra (ex.: outsideHours, opensAt, qr, status).
// Onda 1 (fix R31): `tenantId` OBRIGATÓRIO — é o que permite às salas realtime
// serem por tenant (`tenant:<tenantId>:<papel>`); um evento sem tenant não tem
// sala segura e é descartado no adaptador (fail-closed).

export type NotifyEvent = {
  type: 'handoff' | 'flag' | 'alert' | 'message' | 'account';
  phase?: string;
  /** Tenant dono do evento (ruling R31): todo o emitidor tem de o conhecer. */
  tenantId: string;
  [k: string]: unknown;
};
