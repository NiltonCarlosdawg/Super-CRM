// Socket.IO (Task 15; D8 de docs/01, docs/02 §9): handshake autenticado por
// cookie de sessão, salas por papel e mapeamento dos 5 eventos ao painel.
// O servidor é a fonte de verdade: o cliente nunca decide permissões.
// Onda 1 (Task 4, ruling R14): o papel vem da linha `users` POR LIGAÇÃO (nunca
// do snapshot da sessão) e tenants suspensos são rejeitados no handshake
// (spec multitenant §4.3) — a mesma autoridade do guard HTTP (Task 3).
// Onda 1 (fix R31): salas por TENANT — `tenant:<tenantId>:<papel>`; nenhuma
// sala é global, pelo que um evento de um tenant nunca chega aos sockets de
// outro tenant. Sessões de plataforma (tenantId null, só platform_admin) não
// entram em salas de tenant: eventos de tenant são de tenant; a plataforma
// audita por HTTP (/v1/platform/*), que tem o seu próprio controlo de acesso.

import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { NotifyEvent } from '../../ports/notify.js';
import type { AuthUserRepo, Role, SessionStore } from '../../ports/auth.js';
import type { TenancyPort } from '../../ports/tenancy.js';

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

/**
 * Nome de sala SEMPRE com o tenant embutido (fix R31): o sufixo é o papel
 * (agent/editor/admin/handoffs). Nenhuma sala é partilhada entre tenants.
 */
export function tenantRoom(tenantId: string, suffix: string): string {
  return `tenant:${tenantId}:${suffix}`;
}

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
 * Traduz um NotifyEvent nos 5 eventos do painel e emite pela sala DO TENANT.
 * Payload: `{ v: 1, ...resto }` sem `type`/`phase`/`tenantId` — pass-through
 * dos restantes campos (ex.: `outsideHours`, `opensAt`): é o contrato que a
 * Fase 3 usa. `tenantId` é metadado de roteamento e não viaja ao cliente.
 * Fail-closed (R31): evento sem `tenantId` (dados inválidos/JS sem tipos) é
 * DESCARTADO — nunca há sala global para onde emitir.
 */
export function createSocketNotify(io: SocketIoLike, log?: NotifyLog): (e: NotifyEvent) => Promise<void> {
  return async (e: NotifyEvent): Promise<void> => {
    const event = mapNotifyEvent(e);
    if (event === null) {
      // Só campos sem PII (docs/02 §10): tipo/fase, nunca o corpo do evento.
      log?.warn({ type: e.type, phase: e.phase }, 'notify.event.ignored');
      return;
    }
    const tenantId = typeof e.tenantId === 'string' && e.tenantId.length > 0 ? e.tenantId : null;
    if (tenantId === null) {
      // Só campos sem PII (docs/02 §10): tipo/fase, nunca o corpo do evento.
      log?.warn({ type: e.type, phase: e.phase }, 'notify.event.no_tenant');
      return;
    }
    const payload: Record<string, unknown> = { v: 1 };
    for (const [key, value] of Object.entries(e)) {
      if (key !== 'type' && key !== 'phase' && key !== 'tenantId') payload[key] = value;
    }
    for (const room of ROOMS[event]) io.to(tenantRoom(tenantId, room)).emit(event, payload);
  };
}

interface SocketData {
  role: Role;
  /** null só para platform_admin (CHECK de users): sem salas de tenant (R31). */
  tenantId: string | null;
}

type EventMap = { [event: string]: (...args: unknown[]) => void };

export interface RealtimeHandle {
  io: Server<EventMap, EventMap, EventMap, SocketData>;
  close(): Promise<void>;
}

/**
 * Liga o Socket.IO ao HTTP server (o httpServer de dentro do Fastify).
 * Handshake: cookie `session=<id>` → sessions.get (sem sessão, expirada ou
 * MFA pendente ⇒ `unauthorized`) → linha `users` (papel ACTUAL; inativo ou
 * apagado ⇒ `unauthorized`) → tenant suspenso ⇒ `tenant_suspended`. Conexões
 * entram na sala `tenant:<tenantId>:<papel>` + `tenant:<tenantId>:handoffs`
 * para agent/admin (docs/02 §9; salas por tenant desde o fix R31). Sessões de
 * plataforma (tenantId null) NÃO entram em nenhuma sala de tenant.
 */
export function attachRealtime(deps: {
  server: HttpServer;
  sessions: SessionStore;
  /** Onda 1 (Task 4, R14): autoridade do papel por ligação. */
  users: AuthUserRepo;
  /** Onda 1 (Task 4, R14): suspensão do tenant rejeita o socket. */
  tenancy: TenancyPort;
  now(): Date;
}): RealtimeHandle {
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
      // Autoridade por pedido (R14): a linha `users` manda — papel, estado e
      // tenant; o papel gravado na sessão é só snapshot de criação.
      const user = await deps.users.findById(record.userId);
      if (user === null || !user.active) return next(new Error('unauthorized'));
      if (user.tenantId !== null && (await deps.tenancy.getStatus(user.tenantId)) === 'suspended') {
        return next(new Error('tenant_suspended'));
      }
      socket.data.role = user.role;
      socket.data.tenantId = user.tenantId;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { role, tenantId } = socket.data;
    // R31: plataforma não tem salas de tenant — eventos ao vivo são do tenant;
    // a plataforma audita por HTTP (/v1/platform/*).
    if (tenantId === null) return;
    void socket.join(tenantRoom(tenantId, role));
    if (role === 'agent' || role === 'admin') void socket.join(tenantRoom(tenantId, 'handoffs'));
  });

  return {
    io,
    close: async () => {
      await io.close(); // fecha clientes e o httpServer (Fastify tolera o 2º fecho)
    },
  };
}
