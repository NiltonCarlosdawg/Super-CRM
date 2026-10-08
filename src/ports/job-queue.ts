// Port de jobs — CRM MilVendas
// Só tipos: quem fala com a fila é um adaptador (docs/02 §1).
// Todo o job é idempotente (docs/02 §6): re-enfileirar a mesma chave não repete o efeito.

export interface EnqueueOptions {
  /** Chave determinística: re-enviar a mesma chave NÃO repete o efeito. */
  idempotencyKey: string;
  correlationId: string;
  delayMs?: number;
}

export interface JobContext {
  correlationId: string;
  jobId: string;
  attempt: number;
}

export interface JobQueue {
  /** O payload leva IDs, nunca dados de conversa (docs/02 §6). O handler valida o payload. */
  enqueue(name: string, payload: Record<string, unknown>, opts: EnqueueOptions): Promise<void>;
  register(
    name: string,
    handler: (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
}
