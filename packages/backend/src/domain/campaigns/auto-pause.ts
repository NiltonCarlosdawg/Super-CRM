// Fase 4, Task 10: regra pura de pausa automática por volume. A decisão vive
// aqui (nunca no tick nem no prompt); `null` = não pausa.

import type { PauseReason } from './types.js';
import type { CampaignConfig } from '../../modules/campaigns/config.js';

export interface VolumeWindow {
  /** Últimos `failWindow` resultados CONHECIDOS ('sent' | 'failed'). */
  knownOutcomes: readonly ('sent' | 'failed')[];
  /** Destinatários com opted_out_at entre as últimas `optOutWindow` mensagens enfileiradas desde `since`. */
  optOutsInWindow: number;
}

/** Ordem das regras: failure_rate primeiro, depois opt_out_spike. null = não pausa. */
export function evaluateVolumePause(
  window: VolumeWindow,
  cfg: CampaignConfig['pause'],
): PauseReason | null {
  const failed = window.knownOutcomes.filter((o) => o === 'failed').length;
  if (window.knownOutcomes.length === cfg.failWindow && failed / cfg.failWindow >= cfg.failRatio) {
    return 'failure_rate';
  }
  if (window.optOutsInWindow >= cfg.optOutCount) return 'opt_out_spike';
  return null;
}
