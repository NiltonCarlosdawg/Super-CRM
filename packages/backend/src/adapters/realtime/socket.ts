// Socket.IO (Task 15; D8 de docs/01, docs/02 §9): handshake autenticado por
// cookie de sessão, salas por papel e mapeamento dos 5 eventos ao painel.
// O servidor é a fonte de verdade: o cliente nunca decide permissões.

import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { NotifyEvent } from '../../ports/notify.js';
import type { Role, SessionStore } from '../../ports/auth.js';

// Fonte única do tipo (ports/notify.ts, definido na Task 14): aqui só se
// re-exporta para que a Fase 3 consume o adaptador realtime sem alcançar ports.
export type { NotifyEvent };

/** Os 5 eventos mínimos do painel (docs/02 §9). Nada disto sai por outro nome. */
export const NOTIFY_EVENTS = [
  'handoff.created',
  'handoff.updated',
  'message.created',
  'message.status',
  'account.status',
] as const;

export type NotifyEventName = (typeof NOTIFY_EVENTS)[number];

/** Mínimo do que o notify precisa do io (permite espião nos testes). */
export interface SocketIoLike {
  to(room: string): { emit(event: string, payload: unknown): unknown };
}

/** Salas por evento (docs/02 §9): handoffs só agent/admin, account só admin. */
const ROOMS: Record<NotifyEventName, readonly string[]> = {
  'handoff.created': ['handoffs'],
  'handoff.updated': ['handoffs'],
  'message.created': ['agent', 'editor', 'admin'],
  'message.status': ['agent', 'editor', 'admin'],
  'account.status': ['admin'],
};

/** Tipo/fase fora do mapa → null: nunca se adivinha um 6º evento. */
function mapNotifyEvent(e: NotifyEvent): NotifyEventName | null {
  switch (e.type) {
    case 'handoff':
      if (e.phase === undefined) return 'handoff.created';
      if (e.phase === 'updated') return 'handoff.updated';
      return null;
    case 'flag':
      return 'handoff.created';
    case 'alert':
      return 'handoff.updated'; // levanta o reason; o payload é pass-through
    case 'message':
      if (e.phase === 'created') return 'message.created';
      if (e.phase === 'status') return 'message.status';
      return null;
    case 'account':
      return 'account.status';
    default:
      return null;
  }
}

export interface NotifyLog {
  warn(obj: unknown, msg: string): void;
}

/**
 * Traduz um NotifyEvent nos 5 eventos do painel e emite por sala.
 * Payload: `{ v: 1, ...resto }` sem `type`/`phase` — pass-through dos restantes
 * campos (ex.: `outsideHours`, `opensAt`): é o contrato que a Fase 3 usa.
 */
export function createSocketNotify(io: SocketIoLike, log?: NotifyLog): (e: NotifyEvent) => Promise<void> {
  return async (e: NotifyEvent): Promise<void> => {
    const event = mapNotifyEvent(e);
    if (event === null) {
      // Só campos sem PII (docs/02 §10): tipo/fase, nunca o corpo do evento.
      log?.warn({ type: e.type, phase: e.phase }, 'notify.event.ignored');
      return;
    }
    const payload: Record<string, unknown> = { v: 1 };
    for (const [key, value] of Object.entries(e)) {
      if (key !== 'type' && key !== 'phase') payload[key] = value;
    }
    for (const room of ROOMS[event]) io.to(room).emit(event, payload);
  };
}

interface SocketData {
  role: Role;
}

type EventMap = { [event: string]: (...args: unknown[]) => void };

export interface RealtimeHandle {
  io: Server<EventMap, EventMap, EventMap, SocketData>;
  close(): Promise<void>;
}

/**
 * Liga o Socket.IO ao HTTP server (o httpServer de dentro do Fastify).
 * Handshake: cookie `session=<id>` → sessions.get (sem sessão, expirada ou
 * MFA pendente ⇒ `unauthorized`). Conexões entram na sala do papel + `handoffs`
 * para agent/admin (docs/02 §9).
 */
export function attachRealtime(deps: { server: HttpServer; sessions: SessionStore; now(): Date }): RealtimeHandle {
  const io = new Server<EventMap, EventMap, EventMap, SocketData>(deps.server);

  const parseSessionId = (header: string | undefined): string | undefined => {
    if (header === undefined) return undefined;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === 'session') return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return undefined;
  };

  io.use(async (socket, next) => {
    try {
      const sessionId = parseSessionId(socket.handshake.headers.cookie);
      const record = sessionId === undefined ? null : await deps.sessions.get(sessionId, deps.now());
      // Sem sessão, expirada ou MFA pendente: a sessão não está autenticada.
      if (record === null || record.mfaPending) return next(new Error('unauthorized'));
      socket.data.role = record.role;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { role } = socket.data;
    void socket.join(role);
    if (role === 'agent' || role === 'admin') void socket.join('handoffs');
  });

  return {
    io,
    close: async () => {
      await io.close(); // fecha clientes e o httpServer (Fastify tolera o 2º fecho)
    },
  };
}
