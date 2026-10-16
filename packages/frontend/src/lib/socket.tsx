// Eventos em tempo real do painel (Task 3): ligação Socket.IO same-origin
// autenticada pelo cookie de sessão (docs/01 D8; handshake em
// adapters/realtime/socket.ts do backend — recusa sem sessão ou com MFA
// pendente). Só existem os 5 eventos do painel; nunca se adivinha um 6º.

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import type { AccountStatus, MessageSender, MessageStatus } from "./types";

export type PanelEventName =
  | "handoff.created"
  | "handoff.updated"
  | "message.created"
  | "message.status"
  | "account.status";

export type HandoffPriority = "urgent" | "high" | "normal";

/** Payloads `{ v: 1, ... }` — espelho do createSocketNotify do backend. */
export interface PanelEventPayloads {
  // `createdAt` presente nos EMITIDORES reais (handle-inbound.ts:156,
  // outbox.ts:105, message-status.ts:51, outbox-worker.ts:153) — o payload
  // NÃO traz body/direction: o cliente recupera o estado por REST (docs/02 §9).
  "message.created": {
    v: 1;
    messageId: string;
    conversationId: string;
    accountId: string;
    sender: MessageSender;
    status: MessageStatus;
    createdAt: string;
  };
  "message.status": {
    v: 1;
    messageId: string;
    conversationId: string;
    accountId: string;
    sender: MessageSender;
    status: MessageStatus;
    providerMessageId?: string;
    createdAt: string;
  };
  "account.status": {
    v: 1;
    accountId: string;
    status: AccountStatus;
  };
  "handoff.created": {
    v: 1;
    handoffId: string;
    conversationId: string;
    priority: HandoffPriority;
    reason?: string;
  };
  "handoff.updated": {
    v: 1;
    handoffId: string;
    conversationId: string;
    priority: HandoffPriority;
    reason?: string;
  };
}

/** Subconjunto do Socket que a nossa camada usa — injectável para testes. */
export interface SocketLike {
  on(event: string, handler: (payload: unknown) => void): unknown;
  off(event: string, handler: (payload: unknown) => void): unknown;
  disconnect(): unknown;
}

export interface PanelSocket {
  on<N extends PanelEventName>(name: N, handler: (payload: PanelEventPayloads[N]) => void): () => void;
  disconnect(): void;
}

export function createPanelSocket(ioFactory: () => SocketLike): PanelSocket {
  const socket = ioFactory();
  return {
    on(name, handler) {
      const wrapped = handler as (payload: unknown) => void;
      socket.on(name, wrapped);
      return () => socket.off(name, wrapped);
    },
    disconnect() {
      socket.disconnect();
    },
  };
}

/** Ligação real: mesma origem (proxy do Vite) + cookie de sessão. */
export function defaultIoFactory(): SocketLike {
  const socket: Socket = io({
    withCredentials: true,
    autoConnect: true,
  });
  return {
    on: (event, handler) => socket.on(event, handler as never),
    off: (event, handler) => socket.off(event, handler as never),
    disconnect: () => socket.disconnect(),
  };
}

const PanelSocketContext = createContext<PanelSocket | null>(null);

export function PanelSocketProvider({
  socket,
  children,
}: {
  socket: PanelSocket | null;
  children: ReactNode;
}) {
  return <PanelSocketContext.Provider value={socket}>{children}</PanelSocketContext.Provider>;
}

/** null quando ainda não há ligação (app anónima ou socket a reconectar). */
export function usePanelSocket(): PanelSocket | null {
  return useContext(PanelSocketContext);
}

/** Subscreve o evento e limpa no unmount; o handler mais recente fica numa ref. */
export function useEvent<N extends PanelEventName>(
  name: N,
  handler: (payload: PanelEventPayloads[N]) => void,
): void {
  const socket = usePanelSocket();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (socket === null) return;
    const off = socket.on(name, (payload) => handlerRef.current(payload));
    return off;
  }, [socket, name]);
}
