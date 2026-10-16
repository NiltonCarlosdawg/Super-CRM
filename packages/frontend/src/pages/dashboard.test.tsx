// Dashboard (Task 12 do plano do frontend): métricas DERIVADAS dos endpoints
// reais (nada de números inventados como o antigo TopCards) — deriveMetrics é
// puro e testado; a página lê /v1/whatsapp-accounts + /v1/conversations?limit=50
// e refaz o GET quando o tempo real muda uma conta (account.status).

import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui/Toast";
import { api } from "../lib/api";
import { PanelSocketProvider, type PanelSocket } from "../lib/socket";
import type { AccountRow, ConversationView } from "../lib/types";
import DashboardPage, { deriveMetrics } from "./dashboard";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const mockGet = vi.mocked(api.get);

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "acc-1",
    label: "Suporte Luanda",
    phoneE164: "+244923000111",
    providerSessionId: "p1",
    status: "connected",
    purpose: "support",
    ...overrides,
  };
}

function conv(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id: "c1",
    accountId: "acc-1",
    contactId: "ct-1",
    contactPhone: "+244923456789",
    leadId: null,
    line: null,
    aiMode: "ai_active",
    missStreak: 0,
    lastMessageAt: "2026-10-16T10:00:00.000Z",
    createdAt: "2026-10-15T10:00:00.000Z",
    ...overrides,
  };
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

function renderPage(socket: PanelSocket | null = null) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <PanelSocketProvider socket={socket}>
        <ToastProvider>
          <DashboardPage />
        </ToastProvider>
      </PanelSocketProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deriveMetrics", () => {
  it("conta as contas por estado (todos os chaves do Record)", () => {
    const accounts = [
      account({ id: "a1", status: "connected" }),
      account({ id: "a2", status: "connected" }),
      account({ id: "a3", status: "connecting" }),
      account({ id: "a4", status: "disconnected" }),
      account({ id: "a5", status: "suspected_ban" }),
    ];

    const metrics = deriveMetrics(accounts, []);

    expect(metrics.porEstado).toEqual({
      connected: 2,
      connecting: 1,
      disconnected: 1,
      suspected_ban: 1,
    });
    expect(metrics.totalConversas).toBe(0);
  });

  it("estado sem contas conta 0 (Record completo, sem undefined)", () => {
    const metrics = deriveMetrics([], []);
    expect(metrics.porEstado).toEqual({
      connected: 0,
      connecting: 0,
      disconnected: 0,
      suspected_ban: 0,
    });
  });

  it("últimas 5 por lastMessageAt desc com nulos no fim", () => {
    const conversations = [
      conv({ id: "c-sem-data", lastMessageAt: null }),
      conv({ id: "c-antiga", lastMessageAt: "2026-10-10T10:00:00.000Z" }),
      conv({ id: "c-mais-reciente", lastMessageAt: "2026-10-16T12:00:00.000Z" }),
      conv({ id: "c-media", lastMessageAt: "2026-10-14T10:00:00.000Z" }),
      conv({ id: "c-outra-sem-dados", lastMessageAt: null }),
      conv({ id: "c-2a-reciente", lastMessageAt: "2026-10-16T11:00:00.000Z" }),
      conv({ id: "c-6a", lastMessageAt: "2026-10-12T10:00:00.000Z" }),
    ];

    const { ultimas, totalConversas } = deriveMetrics([], conversations);

    expect(totalConversas).toBe(7);
    expect(ultimas.map((c) => c.id)).toEqual([
      "c-mais-reciente",
      "c-2a-reciente",
      "c-media",
      "c-6a",
      "c-antiga",
    ]);
  });
});

describe("DashboardPage", () => {
  it("mostra os 4 cartões com contagens reais e o total de conversas", async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === "/v1/whatsapp-accounts") {
        return Promise.resolve({
          accounts: [
            account({ id: "a1", status: "connected" }),
            account({ id: "a2", status: "connecting" }),
            account({ id: "a3", status: "disconnected" }),
            account({ id: "a4", status: "suspected_ban" }),
          ],
        });
      }
      return Promise.resolve({ conversations: [conv(), conv({ id: "c2" })], nextCursor: null });
    });
    renderPage();

    expect(await screen.findByText("Contas ligadas")).toBeInTheDocument();
    expect(screen.getByText("A ligar")).toBeInTheDocument();
    expect(screen.getByText("Desligadas")).toBeInTheDocument();
    expect(screen.getByText("Suspeitas")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // total de conversas
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });

  it("lista as últimas conversas com link para a thread", async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === "/v1/whatsapp-accounts") return Promise.resolve({ accounts: [] });
      return Promise.resolve({
        conversations: [conv({ id: "c1", contactPhone: "+244923000111" })],
        nextCursor: null,
      });
    });
    renderPage();

    const link = await screen.findByRole("link", { name: /\+244923000111/ });
    expect(link).toHaveAttribute("href", "/conversations/c1");
  });

  it("evento account.status refaz o GET das contas", async () => {
    const { socket, emit } = fakeSocket();
    mockGet.mockImplementation((path: string) => {
      if (path === "/v1/whatsapp-accounts") {
        return Promise.resolve({ accounts: [account({ status: "connecting" })] });
      }
      return Promise.resolve({ conversations: [], nextCursor: null });
    });
    renderPage(socket);

    await screen.findByText("Contas ligadas");
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));

    emit("account.status", { v: 1, accountId: "acc-1", status: "connected" });

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(3));
  });
});
