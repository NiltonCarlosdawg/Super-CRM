// Evento de notificação ao painel (docs/02 §9) — fonte única do tipo,
// consumido por ports/application (orquestrador, ciclo de vida de contas) e
// materializado pelos adaptadores (realtime da Task 15, orquestrador da 14).
// Pass-through dos campos extra (ex.: outsideHours, opensAt, qr, status).

export type NotifyEvent = {
  type: 'handoff' | 'flag' | 'alert' | 'message' | 'account';
  phase?: string;
  [k: string]: unknown;
};
