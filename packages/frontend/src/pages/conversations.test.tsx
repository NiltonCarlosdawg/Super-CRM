// Thread de mensagens (Task 9 do plano do frontend): aplicação pura dos
// eventos realtime (o payload message.created NÃO traz body — docs/02 §9 manda
// recuperar por REST), paginação de antigos em prepend, banner de handoff.
// O api é mockado por path — envelopes reais: {conversation, lastMessage} e
// {messages, nextCursor}.

import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui/Toast";
import { api, ApiError } from "../lib/api";
import { aiModeLabel, handoffPriorityLabel, messageStatusLabel } from "../lib/labels";
import { PanelSocketProvider, type PanelSocket } from "../lib/socket";
import type {
  ConversationDetail,
  ConversationView,
  ConversationsList,
  MessageView,
  MessagesList,
} from "../lib/types";
import ConversationsPage, {
  aiModeTone,
  applyThreadEvent,
  useConversations,
  type ThreadEvent,
  type ThreadState,
} from "./conversations";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const mockGet = vi.mocked(api.get);

function conv(id: string, overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id,
    accountId: "acc-1",
    contactId: "ct-1",
    contactPhone: "+244923000111",
    leadId: null,
    line: null,
    aiMode: "ai_active",
    missStreak: 0,
    lastMessageAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function msg(id: string, overrides: Partial<MessageView> = {}): MessageView {
  return {
    id,
    conversationId: "c1",
    direction: "outbound",
    sender: "ai",
    kind: "text",
    body: `corpo ${id}`,
    status: "sent",
    mediaRef: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function detail(phone = "+244923000111", conversationId = "c1"): ConversationDetail {
  return { conversation: conv(conversationId, { contactPhone: phone }), lastMessage: null };
}

/** Socket falso: guarda handlers e permite emitir eventos como o backend. */
function fakeSocket() {
  const handlers: Record<string, (payload: unknown) => void> = {};
  const socket: PanelSocket = {
    on(name, handler) {
      handlers[name] = handler as (payload: unknown) => void;
      return () => {
        delete handlers[name];
      };
    },
    disconnect() {
      /* nada a desligar */
    },
  };
  return { socket, emit: (name: string, payload: unknown) => handlers[name]?.(payload) };
}

function renderPage(path = "/conversations", socket: PanelSocket | null = null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PanelSocketProvider socket={socket}>
        <ToastProvider>
          <Routes>
            <Route path="/conversations" element={<ConversationsPage />} />
            <Route path="/conversations/:id" element={<ConversationsPage />} />
          </Routes>
        </ToastProvider>
      </PanelSocketProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("aiModeLabel / aiModeTone", () => {
  it("três rótulos PT-AO", () => {
    expect(aiModeLabel("ai_active")).toBe("IA activa");
    expect(aiModeLabel("ai_suggest")).toBe("IA só sugere");
    expect(aiModeLabel("human_only")).toBe("Só humanos");
  });

  it("tons por modo", () => {
    expect(aiModeTone("ai_active")).toBe("info");
    expect(aiModeTone("ai_suggest")).toBe("neutral");
    expect(aiModeTone("human_only")).toBe("warning");
  });
});

describe("useConversations", () => {
  it("loadMore anexa a segunda página (cursor)", async () => {
    const page1: ConversationsList = {
      conversations: [conv("c1"), conv("c2"), conv("c3")],
      nextCursor: "cur1",
    };
    const page2: ConversationsList = {
      conversations: [conv("c4"), conv("c5"), conv("c6")],
      nextCursor: null,
    };
    mockGet.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    const { result } = renderHook(() => useConversations(), { wrapper: ToastProvider });

    await waitFor(() => expect(result.current.items).toHaveLength(3));
    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toHaveLength(6));

    expect(result.current.items.map((item) => item.id)).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
      "c6",
    ]);
    expect(mockGet).toHaveBeenNthCalledWith(1, "/v1/conversations", { limit: "20" });
    expect(mockGet).toHaveBeenNthCalledWith(2, "/v1/conversations", { limit: "20", cursor: "cur1" });
  });

  it("sem cursor seguinte o loadMore não pede nada", async () => {
    mockGet.mockResolvedValue({ conversations: [conv("c1")], nextCursor: null });

    const { result } = renderHook(() => useConversations(), { wrapper: ToastProvider });
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => {
      result.current.loadMore();
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});

describe("ConversationsPage (fila)", () => {
  it("mostra telefone, hora relativa e aviso de falhas da IA", async () => {
    const cincoMin = new Date(Date.now() - 5 * 60_000).toISOString();
    mockGet.mockResolvedValue({
      conversations: [
        conv("c1", { contactPhone: "+244923111222", lastMessageAt: cincoMin }),
        conv("c2", { contactPhone: "+244923333444", missStreak: 4 }),
      ],
      nextCursor: null,
    });
    renderPage();

    expect(await screen.findByText("+244923111222")).toBeInTheDocument();
    expect(screen.getByText("há 5 minutos")).toBeInTheDocument();
    expect(screen.getByText("IA falhou 4 vezes seguidas")).toBeInTheDocument();
  });

  it("linha activa destacada em /conversations/:id", async () => {
    mockGet.mockImplementation((async (path: string) => {
      if (path.endsWith("/messages")) return { messages: [], nextCursor: null } satisfies MessagesList;
      if (path === "/v1/conversations") {
        return {
          conversations: [
            conv("c1", { contactPhone: "+244911111111" }),
            conv("c2", { contactPhone: "+244922222222" }),
          ],
          nextCursor: null,
        } satisfies ConversationsList;
      }
      return detail("+244922222222", "c2");
    }) as never);
    renderPage("/conversations/c2");

    const activa = await screen.findByRole("link", { name: /\+244922222222/ });
    const outra = screen.getByRole("link", { name: /\+244911111111/ });
    const classes = (element: HTMLElement) => element.className.split(/\s+/);
    expect(classes(activa)).toContain("bg-accent-soft");
    expect(classes(outra)).toContain("hover:bg-accent-soft/50");
    expect(classes(outra)).not.toContain("bg-accent-soft");
  });

  it("erro da fila vira toast", async () => {
    mockGet.mockRejectedValue(new ApiError(0, "network", "sem ligação ao servidor"));
    renderPage();

    // findAll por segurança: qualquer outro erro simultâneo não quebra a asserção
    const alertas = await screen.findAllByRole("alert");
    expect(alertas.length).toBeGreaterThan(0);
    expect(alertas[0]).toHaveTextContent("sem ligação ao servidor");
  });
});

describe("messageStatusLabel / handoffPriorityLabel", () => {
  it("cinco estados de mensagem em PT-AO", () => {
    expect(messageStatusLabel("queued")).toBe("Na fila");
    expect(messageStatusLabel("sent")).toBe("Enviada");
    expect(messageStatusLabel("delivered")).toBe("Entregue");
    expect(messageStatusLabel("read")).toBe("Lida");
    expect(messageStatusLabel("failed")).toBe("Falhou");
  });

  it("três prioridades de handoff", () => {
    expect(handoffPriorityLabel("urgent")).toBe("Urgente");
    expect(handoffPriorityLabel("high")).toBe("Alta");
    expect(handoffPriorityLabel("normal")).toBe("Normal");
  });
});

describe("applyThreadEvent", () => {
  const base: ThreadState = {
    conversationId: "c1",
    messages: [msg("m0")],
    handoff: null,
  };

  it("anexa message.created só se conversationId igual", () => {
    const evento: ThreadEvent = {
      name: "message.created",
      payload: {
        v: 1,
        messageId: "m1",
        conversationId: "c2",
        accountId: "a1",
        sender: "customer",
        status: "delivered",
        createdAt: new Date().toISOString(),
      },
    };

    expect(applyThreadEvent(base, evento).messages).toHaveLength(1);

    const daConversa: ThreadEvent = {
      ...evento,
      payload: { ...evento.payload, conversationId: "c1" },
    };
    const depois = applyThreadEvent(base, daConversa);
    expect(depois.messages).toHaveLength(2);
    expect(depois.messages[1]).toMatchObject({
      id: "m1",
      conversationId: "c1",
      direction: "inbound", // sender customer ⇒ inbound
      status: "delivered",
      body: "", // payload sem body — a materialização vem da REST
    });
  });

  it("actualiza status por messageId e ignora desconhecido", () => {
    const lido: ThreadEvent = {
      name: "message.status",
      payload: {
        v: 1,
        messageId: "m0",
        conversationId: "c1",
        accountId: "a1",
        sender: "ai",
        status: "read",
        createdAt: new Date().toISOString(),
      },
    };
    expect(applyThreadEvent(base, lido).messages[0].status).toBe("read");

    const desconhecido: ThreadEvent = {
      ...lido,
      payload: { ...lido.payload, messageId: "zzz" },
    };
    expect(applyThreadEvent(base, desconhecido).messages[0].status).toBe("sent");
  });

  it("handoff actualiza o banner da conversa aberta", () => {
    const evento: ThreadEvent = {
      name: "handoff.updated",
      payload: {
        v: 1,
        handoffId: "h1",
        conversationId: "c1",
        priority: "high",
        reason: "Pagamento falhou",
      },
    };
    expect(applyThreadEvent(base, evento).handoff).toEqual({
      handoffId: "h1",
      priority: "high",
      reason: "Pagamento falhou",
    });

    const deOutra: ThreadEvent = { ...evento, payload: { ...evento.payload, conversationId: "c9" } };
    expect(applyThreadEvent(base, deOutra).handoff).toBeNull();
  });
});

describe("Thread (painel da direita)", () => {
  it("carregar mais antigos prepend a página nova antes", async () => {
    const paginaNova: MessagesList = {
      messages: [msg("m4", { body: "quatro" }), msg("m3", { body: "três" })],
      nextCursor: "old1",
    };
    const antiga: MessagesList = {
      messages: [msg("m2", { body: "dois" }), msg("m1", { body: "um" })],
      nextCursor: null,
    };
    const fila = [paginaNova, antiga];
    mockGet.mockImplementation((async (path: string) => {
      if (path === "/v1/conversations")
        return { conversations: [], nextCursor: null } satisfies ConversationsList;
      if (path.endsWith("/messages")) return fila.shift() as MessagesList;
      return detail("+244911111111");
    }) as never);
    renderPage("/conversations/c1");

    expect(await screen.findByText("três")).toBeInTheDocument();
    expect(screen.getByText("quatro")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ver mensagens anteriores" }));

    expect(await screen.findByText("um")).toBeInTheDocument();
    const ordem = screen
      .getAllByText(/^(um|dois|três|quatro)$/)
      .map((node) => node.textContent);
    expect(ordem).toEqual(["um", "dois", "três", "quatro"]);
  });

  it("message.created em tempo real recupera por REST e mostra a mensagem", async () => {
    let chamadas = 0;
    mockGet.mockImplementation((async (path: string) => {
      if (path === "/v1/conversations")
        return { conversations: [], nextCursor: null } satisfies ConversationsList;
      if (!path.endsWith("/messages")) return detail();
      chamadas += 1;
      return (
        chamadas === 1
          ? { messages: [msg("m1", { body: "olá" })], nextCursor: null }
          : {
              messages: [msg("m2", { body: "boa noite" }), msg("m1", { body: "olá" })],
              nextCursor: null,
            }
      ) satisfies MessagesList;
    }) as never);

    const fake = fakeSocket();
    renderPage("/conversations/c1", fake.socket);
    expect(await screen.findByText("olá")).toBeInTheDocument();

    act(() => {
      fake.emit("message.created", {
        v: 1,
        messageId: "m2",
        conversationId: "c1",
        accountId: "a1",
        sender: "customer",
        status: "delivered",
        createdAt: new Date().toISOString(),
      });
    });

    expect(await screen.findByText("boa noite")).toBeInTheDocument();
    await waitFor(() => expect(chamadas).toBe(2)); // materialização REST (docs/02 §9)
  });

  it("handoff da conversa aberta mostra banner com prioridade e razão", async () => {
    mockGet.mockImplementation((async (path: string) => {
      if (path === "/v1/conversations")
        return { conversations: [], nextCursor: null } satisfies ConversationsList;
      if (path.endsWith("/messages"))
        return { messages: [msg("m1")], nextCursor: null } satisfies MessagesList;
      return detail();
    }) as never);

    const fake = fakeSocket();
    renderPage("/conversations/c1", fake.socket);
    await screen.findByText(/corpo m1/);

    act(() => {
      fake.emit("handoff.created", {
        v: 1,
        handoffId: "h1",
        conversationId: "c1",
        priority: "urgent",
        reason: "Cliente pede factura",
      });
    });

    expect(screen.getByText("Urgente")).toBeInTheDocument();
    expect(screen.getByText(/Cliente pede factura/)).toBeInTheDocument();
  });

  it("detalhe inexistente mostra estado de erro sem spinner preso", async () => {
    mockGet.mockImplementation((async (path: string) => {
      if (path.endsWith("/messages")) return { messages: [], nextCursor: null } satisfies MessagesList;
      throw new ApiError(404, "not_found", "conversa não encontrada");
    }) as never);
    renderPage("/conversations/00000000-0000-4000-8000-000000000000");

    expect(await screen.findByText("Não foi possível abrir a conversa")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull(); // sem spinner eterno
  });
});
