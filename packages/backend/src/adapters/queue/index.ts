import type { JobQueue } from '../../ports/job-queue.js';
import { BullMqJobQueue } from './bullmq.js';

// Fábrica do port JobQueue. Por agora devolve o adaptador BullMQ (plano A);
// se o Redis ficar Refutado na verificação A5, troca-se aqui para o plano B
// sem mudar os callers (docs/cpanel-capacidades.md §5).
export function createJobQueue(opts: { redisUrl: string }): JobQueue {
  return new BullMqJobQueue(opts.redisUrl);
}
