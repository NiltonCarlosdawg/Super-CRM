import { io, Socket } from "socket.io-client";

export type SocketEvent =
  | "new_message"
  | "campaign_status_change"
  | "limit_warning"
  | "account_status";

export type NewMessageEvent = {
  conversationId: string;
  message: {
    id: string;
    from: "client" | "agent" | "ai";
    text: string;
    timestamp: string;
  };
  type?: "inbound" | "outbound";
};

export type CampaignStatusEvent = {
  campaignId: string;
  status: "running" | "paused" | "finished";
  messagesSent: number;
};

export type AccountStatusEvent = {
  accountId: string;
  status: "online" | "offline" | "limited";
  messagesSent: number;
};

/**
 * Conecta ao Socket.IO do backend
 * @param onMessageCallback - callback para mensagens novas
 * @param onCampaignCallback - callback para status de campanhas
 * @param onAccountCallback - callback para status de contas
 */
export function connectSocket(
  onMessageCallback: (msg: NewMessageEvent) => void,
  onCampaignCallback?: (ev: CampaignStatusEvent) => void,
  onAccountCallback?: (ev: AccountStatusEvent) => void
) {
  const baseUrl =
    process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

  // Conecta sem auto-Auth; o backend definirá a sala/namespace baseado no token
  const socket = io(baseUrl, {
    transports: ["websocket"],
    autoConnect: true,
    reconnect: true,
    reconnectDelay: 1000,
    reconnectTimeout: 5000,
  });

  socket.on("connect", () => {
    console.log("Socket.IO conectado:", socket.id);
  });

  socket.on("connect_error", (err) => {
    console.error("Socket.IO connection error:", err);
  });

  // Event: nova mensagem recebida
  socket.on("new_message", (data: any) => {
    if (onMessageCallback && data.message) {
      onMessageCallback({
        conversationId: data.conversationId || data.conversation?.id || "",
        message: {
          id: data.message.id || "",
          from: data.message.from || "client",
          text: data.message.text || "",
          timestamp: data.message.timestamp || new Date().toISOString(),
        },
        type: data.type || "inbound",
      });
    }
  });

  // Event: status de campanha alterado
  if (onCampaignCallback) {
    socket.on("campaign_status_change", (data: any) => {
      onCampaignCallback({
        campaignId: data.campaignId || data.campaign?.id || "",
        status: data.status || "running",
        messagesSent: data.messagesSent || 0,
      });
    });
  }

  // Event: status de conta alterado
  if (onAccountCallback) {
    socket.on("account_status", (data: any) => {
      onAccountCallback({
        accountId: data.accountId || data.account?.id || "",
        status: data.status || "online",
        messagesSent: data.messagesSent || 0,
      });
    });
  }

  return socket;
}

/**
 * Remove todos os listeners e desconecta
 * @param socket - socket a ser desconectado
 */
export function disconnectSocket(socket: Socket) => {
  if (socket) {
    socket.disconnect();
    socket.close();
  }
}