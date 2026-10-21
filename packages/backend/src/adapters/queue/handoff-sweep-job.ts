// Fase 3, Task 15: registo do job recorrente da varredura (ADR-0003 A6.1).
// JobId determinístico `handoff-sweep`, a cada 60 s, payload VAZIO por design
// (nada de dados em jobs, docs/02 §6) — o handler valida `{}`. O dedupe por
// nome do `registerRecurring` é o lock: registar duas vezes é no-op.

import { z } from 'zod';

import type { JobQueue } from '../../ports/job-queue.js';
import { runHandoffScheduleSweep, type SweepDeps } from '../../application/schedule-sweep.js';

const emptyPayload = z.object({}).strict();
const EVERY_MS = 60_000;

export async function registerHandoffSweepJob(jobs: JobQueue, deps: SweepDeps): Promise<void> {
  await jobs.registerRecurring(
    'handoff-sweep',
    async (payload) => {
      const parsed = emptyPayload.safeParse(payload);
      if (!parsed.success) throw new Error('handoff-sweep: payload tem de ser vazio');
      // Erro da varredura → rethrow (a fila faz retry; docs/02 §6).
      await runHandoffScheduleSweep(deps, new Date());
    },
    { everyMs: EVERY_MS },
  );
}
