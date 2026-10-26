// Fila de jobs falsa para testes de integração (Task 4): captura o que foi
// enfileirado e os handlers registados, e deixa o teste correr os jobs quando
// quiser (determinístico, sem Redis/BullMQ). Implementa `JobQueue` por inteiro.

import type {
  EnqueueOptions,
  JobContext,
  JobQueue,
} from '../../src/ports/job-queue.js';

export interface EnqueuedJob {
  name: string;
  payload: Record<string, unknown>;
  opts: EnqueueOptions;
}

export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>;

export interface CapturingJobQueue extends JobQueue {
  /** Jobs enfileirados, pela ordem de `enqueue`. */
  enqueued: EnqueuedJob[];
  /** Handlers registados por nome (os `registerRecurring` são no-op). */
  handlers: Map<string, JobHandler>;
  /** Corre todos os jobs enfileirados com `name` (uma passagem, por ordem). */
  run(name: string): Promise<void>;
  /** Corre uma passagem sobre todos os nomes enfileirados. */
  runAll(): Promise<void>;
}

export function createCapturingJobQueue(): CapturingJobQueue {
  const enqueued: EnqueuedJob[] = [];
  const handlers = new Map<string, JobHandler>();

  const queue: CapturingJobQueue = {
    enqueued,
    handlers,

    async enqueue(name, payload, opts) {
      enqueued.push({ name, payload, opts });
    },

    async register(name, handler) {
      handlers.set(name, handler);
    },

    async registerRecurring() {
      // Sem relógio nos testes: jobs recorrentes não são disparados.
    },

    async close() {},

    async run(name) {
      const jobs = enqueued.filter((job) => job.name === name);
      const handler = handlers.get(name);
      if (handler === undefined) {
        if (jobs.length === 0) return;
        throw new Error(`fake-jobs: sem handler registado para '${name}'`);
      }
      for (const [index, job] of jobs.entries()) {
        await handler(job.payload, {
          correlationId: job.opts.correlationId,
          jobId: `${name}:${index}`,
          attempt: 1,
        });
      }
    },

    async runAll() {
      const names = [...new Set(enqueued.map((job) => job.name))];
      for (const name of names) await queue.run(name);
    },
  };

  return queue;
}
