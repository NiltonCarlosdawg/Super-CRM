import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateVolumePause } from '../../../src/domain/campaigns/auto-pause.js';

const cfg = { failWindow: 20, failRatio: 0.3, optOutWindow: 50, optOutCount: 5 };
const outcomes = (sent: number, failed: number): ('sent' | 'failed')[] => [
  ...Array.from({ length: sent }, () => 'sent' as const),
  ...Array.from({ length: failed }, () => 'failed' as const),
];

describe('evaluateVolumePause', () => {
  it('pausa a failure_rate com ≥30% de falhas nas últimas 20 mensagens', () => {
    assert.equal(evaluateVolumePause({ knownOutcomes: outcomes(14, 6), optOutsInWindow: 0 }, cfg), 'failure_rate'); // 6/20 = 30%
    assert.equal(evaluateVolumePause({ knownOutcomes: outcomes(15, 5), optOutsInWindow: 0 }, cfg), null); // 5/20 = 25%
    assert.equal(evaluateVolumePause({ knownOutcomes: outcomes(0, 19), optOutsInWindow: 0 }, cfg), null); // janela incompleta (<20)
  });

  it('pausa opt_out_spike com ≥5 opt-outs em 50 mensagens, mesmo com janela parcial', () => {
    assert.equal(evaluateVolumePause({ knownOutcomes: outcomes(7, 0), optOutsInWindow: 5 }, cfg), 'opt_out_spike');
    assert.equal(evaluateVolumePause({ knownOutcomes: outcomes(7, 0), optOutsInWindow: 4 }, cfg), null);
  });

  it('falhas avaliadas primeiro quando ambos os limiares falham', () => {
    assert.equal(evaluateVolumePause({ knownOutcomes: outcomes(0, 20), optOutsInWindow: 6 }, cfg), 'failure_rate');
  });
});
