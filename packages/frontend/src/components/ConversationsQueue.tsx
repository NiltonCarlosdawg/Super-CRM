import { useState } from "react";

type Conversation = {
  id: string;
  cliente: string;
  ultimaMensagem: string;
  hora: string;
  conta: string;
  status: "nova" | "ia" | "humano" | "erro";
};

export function ConversationsQueue() {
  const [conversas, setConversas] = useState<Conversation[]>([
    {
      id: "conv-1",
      cliente: "Empresa Tech Ltda",
      ultimaMensagem: "Olá, gostaria de saber sobre o plano CCTV",
      hora: "14:32",
      conta: "Conta WhatsApp 1",
      status: "ia",
    },
    {
      id: "conv-2",
      cliente: "Comercio ABC",
      ultimaMensagem: "Confirmando entrega do pedido #123",
      hora: "14:20",
      conta: "Conta WhatsApp 1",
      status: "humano",
    },
    {
      id: "conv-3",
      cliente: "Telecom XYZ",
      ultimaMensagem: "Problema de sinal na região",
      hora: "14:05",
      conta: "Conta WhatsApp 2",
      status: "erro",
    },
    {
      id: "conv-4",
      cliente: "Imobiliadora 123",
      ultimaMensagem: "Interessado no imóvel 456",
      hora: "13:50",
      conta: "Conta WhatsApp 2",
      status: "ia",
    },
  ]);

  const [newMessage, setNewMessage] = useState<any>(null);

  const socket = new EventSource("/api/sse");

  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    setNewMessage(msg);
  };

  if (newMessage) {
    const updated: Conversation[] = [
      ...conversas.slice(0, 1),
      {
        id: `new-${Date.now()}`,
        cliente: "Novo cliente",
        ultimaMensagem: newMessage.message.text.substring(0, 30) + (newMessage.message.text.length > 30 ? "..." : ""),
        hora: newMessage.message.timestamp ? new Date(newMessage.message.timestamp).toLocaleTimeString() : "now",
        conta: "Conta Padrão",
        status: "nova" as "nova",
      },
      ...conversas.slice(1),
    ];
    setConversas(updated);
    setNewMessage(null);
  }

  return (
    <div className="bg-card rounded-lg shadow-sm p-4">
      <h3 className="font-serif font-medium text-sm mb-4">Fila de Conversas</h3>

      <div className="space-y-3 max-h-80 overflow-y-auto">
        <span className="text-xs text-muted-foreground">
          {conversas.length} conversas ativas
        </span>

        {conversas.map((conv) => (
          <div
            onClick={() => console.log("Abrir conversa:", conv.id)}
            className="flex items-start gap-3 rounded-lg p-3 hover:bg-muted/50 cursor-pointer transition-colors"
            aria-label="Conversa com {conv.cliente}"
          >
            <span
              className={`w-2 rounded-full h-2 mt-1 mr-2 ${conv.status === "ia"
                ? "bg-green-500"
                : conv.status === "humano"
                  ? "bg-blue-500"
                  : conv.status === "erro"
                    ? "bg-red-500"
                    : "gray-300" }`}
            />
            <div className="flex-overflow flex flex-col gap-1">
              <span className="font-serif font-medium text-sm">{conv.cliente}</span>
              <span className="text-xs text-muted-foreground">{conv.ultimaMensagem}</span>
            </div>
            <div className="text-xs text-muted-foreground flex flex-col">
              <span>{conv.hora}</span>
              <span>{conv.conta}</span>
            </div>
          </div>
        ))}

        {conversas.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            Nenhuma conversa encontrada
          </div>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <button className="flex items-center gap-2 px-3 py-1 rounded-sm border border-border hover:bg-focus-visible/20">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path d="M9 5l-4 4 1.41 1.41L11 9l4-4-1.41-1.41z" />
            <path d="M15 5l-4 4 1.41 1.41L16 9l4-4-1.41-1.41z" />
          </svg>
          Filtrar
        </button>

        <button
          className="btn btn-primary flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium"
          aria-label="Passar conversa para humano"
        >
          <svg
            className="w-4 h-4"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M9 5l-4 4 1.41 1.41L11 9l4-4-1.41-1.41z" />
            <path d="M15 5l-4 4 1.41 1.41L16 9l4-4-1.41-1.41z" />
          </svg>
          Passar para humano
        </button>
      </div>
    </div>
  );
}