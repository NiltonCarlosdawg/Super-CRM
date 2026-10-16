// Fila de conversas (Task 8 do plano do frontend): paginação por cursor que
// anexa páginas, vocabulário de modos de IA, hora relativa pt-AO e linha
// activa. O api é mockado — envelope real no backend: {conversations, nextCursor}.

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui/Toast";
import { api, ApiError } from "../lib/api";
import { aiModeLabel } from "../lib/labels";
import type { ConversationView, ConversationsList } from "../lib/types";
import ConversationsPage, { aiModeTone, useConversations } from "./conversations";

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

function renderPage(path = "/conversations") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Routes>
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/conversations/:id" element={<ConversationsPage />} />
        </Routes>
      </ToastProvider>
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
    mockGet.mockResolvedValue({
      conversations: [
        conv("c1", { contactPhone: "+244911111111" }),
        conv("c2", { contactPhone: "+244922222222" }),
      ],
      nextCursor: null,
    });
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

    expect(await screen.findByRole("alert")).toHaveTextContent("sem ligação ao servidor");
  });
});
