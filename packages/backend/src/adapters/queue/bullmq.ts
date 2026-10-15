// Adaptador BullMQ do port JobQueue (docs/02 §6). `bullmq` só é importado daqui
// (a regra de camadas do lint cobre src/domain/** e src/application/**, docs/02 §1).

import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { z } from 'zod';
import type { EnqueueOptions, JobContext, JobQueue } from '../../ports/job-queue.js';

// Envelope guardado no Redis: o payload (só IDs) mais o correlationId do enqueue.
const envelopeSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  correlationId: z.string(),
});

type JobEnvelope = z.infer<typeof envelopeSchema>;

// Retenção dos jobs concluídos: enquanto o registo existir, o jobId (chave de
// idempotência) não reentra. Sem retenção, um enqueue repetido depois de o job
// estar concluído voltaria a correr o handler.
const KEEP_COMPLETED_JOBS = { count: 1000 };

export class BullMqJobQueue implements JobQueue {
  private readonly connection: { url: string };
  private readonly queues = new Map<string, Queue<JobEnvelope>>();
  private readonly workers = new Map<string, Worker<unknown>>();
  // Workers que JÁ ligaram ao Redis: os que nunca ligaram (arranque degradado,
  // porta sem servidor) fecham em força — ver close().
  private readonly everReady = new Set<Worker<unknown>>();

  constructor(redisUrl: string) {
    this.connection = { url: redisUrl };
  }

  private queueFor(name: string): Queue<JobEnvelope> {
    const existing = this.queues.get(name);
    if (existing !== undefined) return existing;
    // Uma fila por nome, com a retenção de concluídos por omissão.
    const queue = new Queue<JobEnvelope>(name, {
      connection: this.connection,
      defaultJobOptions: { removeOnComplete: KEEP_COMPLETED_JOBS },
    });
    this.queues.set(name, queue);
    return queue;
  }

  async enqueue(
    name: string,
    payload: Record<string, unknown>,
    opts: EnqueueOptions,
  ): Promise<void> {
    const envelope: JobEnvelope = { payload, correlationId: opts.correlationId };
    // jobId determinístico: se já existe em qualquer estado, o BullMQ não recria o job.
    // O BullMQ proíbe ':' em custom jobIds (separador interno de chaves), mas as
    // chaves reais de idempotência contêm ':' (`inbound-event:...`, `rest:...`):
    // codifica-se em base64url — bijectivo, logo a dedupe mantém-se.
    await this.queueFor(name).add(name, envelope, {
      jobId: Buffer.from(opts.idempotencyKey).toString('base64url'),
      delay: opts.delayMs,
    });
  }

  async register(
    name: string,
    handler: (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>,
  ): Promise<void> {
    // Registo idempotente: nunca dois workers concorrentes na mesma fila.
    if (this.workers.has(name)) return;
    const worker = new Worker<unknown>(
      name,
      async (job) => {
        // O job chega do Redis: valida-se o envelope na fronteira (docs/02 §3).
        const parsed = envelopeSchema.safeParse(job.data);
        if (!parsed.success) {
          throw new UnrecoverableError(`invalid job envelope on queue "${name}"`);
        }
        const jobId = job.id;
        if (jobId === undefined) {
          throw new UnrecoverableError(`job without id on queue "${name}"`);
        }
        const ctx: JobContext = {
          correlationId: parsed.data.correlationId,
          jobId,
          attempt: job.attemptsMade,
        };
        // O payload é validado pelo handler (docs/02 §6).
        await handler(parsed.data.payload, ctx);
      },
      { connection: this.connection, concurrency: 1 },
    );
    worker.once('ready', () => this.everReady.add(worker));
    this.workers.set(name, worker);
  }

  async registerRecurring(
    name: string,
    handler: (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>,
    opts: { everyMs: number },
  ): Promise<void> {
    // Dedupe em memória por nome (Map de workers): 2.ª chamada = no-op.
    if (this.workers.has(name)) return;
    // BullMQ v6: repetição via Job Scheduler (o `add(..., {repeat})` foi
    // removido). `override` substitui a instância adiada anterior — sem
    // restos entre arranques. Envelope com payload vazio (nada de dados);
    // ticks nunca acumulam no Redis.
    const envelope: JobEnvelope = { payload: {}, correlationId: `repeat:${name}` };
    await this.queueFor(name).upsertJobScheduler(name, { every: opts.everyMs }, {
      name,
      data: envelope,
      opts: { removeOnComplete: true, removeOnFail: true },
    });
    const worker = new Worker<unknown>(
      name,
      async (job) => {
        // Fronteira: valida-se o mesmo envelope dos jobs normais (docs/02 §3).
        const parsed = envelopeSchema.safeParse(job.data);
        if (!parsed.success) {
          throw new UnrecoverableError(`invalid job envelope on queue "${name}"`);
        }
        const jobId = job.id;
        if (jobId === undefined) {
          throw new UnrecoverableError(`job without id on queue "${name}"`);
        }
        const ctx: JobContext = {
          correlationId: parsed.data.correlationId,
          jobId,
          attempt: job.attemptsMade,
        };
        // O payload do tick é `{}` validado pelo handler (docs/02 §6).
        await handler(parsed.data.payload, ctx);
      },
      { connection: this.connection, concurrency: 1 },
    );
    worker.once('ready', () => this.everReady.add(worker));
    this.workers.set(name, worker);
  }

  async close(): Promise<void> {
    // Primeiro os workers (param de consumir), depois as filas.
    // Redis inacessível: o close() gracioso espera pelo quit() do ioredis, que
    // fica na offline queue para sempre → shutdown pendurado (o teste de
    // arranque com porta sem servidor falhava por sinal, sem exit 0). Um worker
    // que nunca ligou fecha em força (disconnect imediato); um worker pronto
    // mantém o dreno normal dos jobs em curso.
    await Promise.all(
      [...this.workers.values()].map((worker) =>
        this.everReady.has(worker) ? worker.close() : worker.close(true),
      ),
    );
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.workers.clear();
    this.queues.clear();
    this.everReady.clear();
  }
}
