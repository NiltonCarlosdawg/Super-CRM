// Fase 4, Task 10: reconciliar o estado dos destinatários 'sent' com a outbox.
// 'unknown' (= entrega desconhecida, docs/04 §5) NUNCA é tratado como falha.

import type { DeliveryProbe, RecipientStatsStore } from '../../ports/campaign-stats.js';
import type { TenantScope } from '../../ports/tenancy.js';

export type ReconcileFailures = (
  scope: TenantScope,
  accountId: string,
  deps: { stats: RecipientStatsStore; probe: DeliveryProbe; now(): Date },
) => Promise<number>;

export const reconcileFailures: ReconcileFailures = async (scope, accountId, deps) => {
  const sent = await deps.stats.sentOutboxKeys(scope, accountId, 200);
  if (sent.length === 0) return 0;
  const states = await deps.probe.outboxStates(
    scope,
    sent.map((r) => r.outboxKey),
  );
  const at = deps.now();
  let marked = 0;
  for (const row of sent) {
    if (states.get(row.outboxKey) !== 'failed') continue;
    await deps.stats.markFailed(scope, row.id, at);
    marked += 1;
  }
  return marked;
};
