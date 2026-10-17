// Página de plataforma (Onda 1, Task 10): lista de tenants do GET
// /v1/platform/tenants (ARRAY directo — ruling R23, contrário das outras
// listagens), suspender/activar com modal de confirmação (204 sem corpo) e
// drill read-only (users, contas, conversas + thread). Sidebar: sessão de
// plataforma vê SÓ "Plataforma"; RequirePlatform manda tenant para /.
// O api é mockado — contratos reais em backend routes/platform.ts.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequirePlatform } from "../components/guards";
import { Sidebar } from "../components/Sidebar";
import { ToastProvider } from "../components/ui/Toast";
import { api, ApiError } from "../lib/api";
import { useSession } from "../lib/auth";
import type { Scope } from "../lib/types";
import PlatformPage from "./platform";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

vi.mock("../lib/auth", () => ({ useSession: vi.fn() }));

const mockGet = vi.mocked(api.get);
const mockPost = vi.mocked(api.post);
const mockUseSession = vi.mocked(useSession);

function session(scope: Scope) {
  return {
    status: "authed" as const,
    user: {
      id: scope === "platform" ? "p-1" : "u-1",
      name: scope === "platform" ? "Plataforma" : "Admin Validação",
      email: scope === "platform" ? "platform@milvendas.local" : "admin@milvendas.local",
      role: (scope === "platform" ? "platform_admin" : "admin") as
        | "platform_admin"
        | "admin",
      scope,
    },
    otpauthUrl: null,
    error: null,
    login: vi.fn(),
    register: vi.fn(),
    verifyTotp: vi.fn(),
    logout: vi.fn(),
  };
}

// Linhas do array directo de GET /v1/platform/tenants (6 chaves do contrato).
const ACME = {
  id: "t-1",
  name: "ACME Lda",
  status: "active" as const,
  usersCount: 3,
  accountsCount: 1,
  createdAt: "2026-01-15T10:00:00.000Z",
};
const BETA = {
  id: "t-2",
  name: "Beta Comércio",
  status: "suspended" as const,
  usersCount: 1,
  accountsCount: 0,
  createdAt: "2026-02-20T10:00:00.000Z",
};

const DRILL_USER = {
  id: "u-9",
  name: "Agente Um",
  email: "agente@acme.ao",
  role: "agent" as const,
  active: true,
};
const DRILL_ACCOUNT = {
  id: "a-9",
  label: "Suporte ACME",
  phoneE164: "+244923000111",
  providerSessionId: "sess-9",
  status: "connected" as const,
  purpose: "support" as const,
};
const DRILL_CONVERSATION = {
  id: "c-9",
  accountId: "a-9",
  contactId: "ct-9",
  contactPhone: "+244923000999",
  leadId: null,
  line: null,
  aiMode: "ai_suggest" as const,
  missStreak: 0,
  lastMessageAt: "2026-03-01T12:00:00.000Z",
  createdAt: "2026-02-01T10:00:00.000Z",
};
const DRILL_LAST_MESSAGE = {
  id: "m-9",
  conversationId: "c-9",
  direction: "inbound" as const,
  sender: "customer" as const,
  kind: "text",
  body: "Bom dia, preciso de ajuda",
  status: "read" as const,
  mediaRef: null,
  createdAt: "2026-03-01T12:00:00.000Z",
};

function renderPage() {
  return render(
    <ToastProvider>
      <PlatformPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSession.mockReturnValue(session("platform"));
  mockGet.mockResolvedValue([ACME, BETA]);
});

describe("PlatformPage", () => {
  it("lista os tenants do GET /v1/platform/tenants (array directo)", async () => {
    renderPage();

    const acmeRow = (await screen.findByText("ACME Lda")).closest("tr");
    expect(acmeRow).not.toBeNull();
    expect(within(acmeRow!).getByText("Activo")).toBeInTheDocument();
    expect(within(acmeRow!).getByText("3")).toBeInTheDocument();
    expect(within(acmeRow!).getByText("1")).toBeInTheDocument();
    expect(within(acmeRow!).getByText(/15/)).toBeInTheDocument(); // criado em

    const betaRow = screen.getByText("Beta Comércio").closest("tr")!;
    expect(within(betaRow).getByText("Suspenso")).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("/v1/platform/tenants");
  });

  it("suspender: modal confirma, POST 204, toast e linha passa a Suspenso", async () => {
    mockPost.mockResolvedValue(undefined); // 204 sem corpo (contrato Task 7)
    renderPage();
    await screen.findByText("ACME Lda");

    fireEvent.click(screen.getByRole("button", { name: "Suspender ACME Lda" }));
    const dialog = await screen.findByRole("dialog", { name: "Suspender ACME Lda" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Suspender" }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith("/v1/platform/tenants/t-1/suspend");
    });
    expect(await screen.findByText("Empresa suspensa")).toBeInTheDocument();
    const acmeRow = screen.getByText("ACME Lda").closest("tr")!;
    expect(within(acmeRow).getByText("Suspenso")).toBeInTheDocument();
  });

  it("cancelar no modal não faz nenhum POST", async () => {
    renderPage();
    await screen.findByText("ACME Lda");

    fireEvent.click(screen.getByRole("button", { name: "Suspender ACME Lda" }));
    const dialog = await screen.findByRole("dialog", { name: "Suspender ACME Lda" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("activar: modal confirma, POST 204 e linha passa a Activo", async () => {
    mockPost.mockResolvedValue(undefined);
    renderPage();
    await screen.findByText("ACME Lda");

    fireEvent.click(screen.getByRole("button", { name: "Activar Beta Comércio" }));
    const dialog = await screen.findByRole("dialog", { name: "Activar Beta Comércio" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Activar" }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith("/v1/platform/tenants/t-2/activate");
    });
    expect(await screen.findByText("Empresa activada")).toBeInTheDocument();
    const betaRow = screen.getByText("Beta Comércio").closest("tr")!;
    expect(within(betaRow).getByText("Activo")).toBeInTheDocument();
  });

  it("falha do servidor no suspend mostra toast de erro e re-fetcha a verdade do servidor", async () => {
    // 1.ª chamada: lista normal; 2.ª (o re-fetch do erro): ACME já suspenso noutro
    // sítio — a linha tem de passar a "Suspenso", só assim se prova o re-fetch.
    let listCalls = 0;
    mockGet.mockImplementation(() => {
      listCalls += 1;
      return Promise.resolve(listCalls === 1 ? [ACME, BETA] : [{ ...ACME, status: "suspended" }]);
    });
    mockPost.mockRejectedValue(new ApiError(404, "not_found", "tenant não encontrado"));
    renderPage();
    await screen.findByText("ACME Lda");

    fireEvent.click(screen.getByRole("button", { name: "Suspender ACME Lda" }));
    const dialog = await screen.findByRole("dialog", { name: "Suspender ACME Lda" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Suspender" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("tenant não encontrado");
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    const acmeRow = screen.getByText("ACME Lda").closest("tr")!;
    expect(within(acmeRow).getByText("Suspenso")).toBeInTheDocument();
  });

  it("confirmar duas vezes com o POST em voo só faz um POST e desactiva o botão", async () => {
    let resolvePost: (() => void) | undefined;
    mockPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = () => resolve(undefined);
        }),
    );
    renderPage();
    await screen.findByText("ACME Lda");

    fireEvent.click(screen.getByRole("button", { name: "Suspender ACME Lda" }));
    const dialog = await screen.findByRole("dialog", { name: "Suspender ACME Lda" });
    const confirm = within(dialog).getByRole("button", { name: "Suspender" });
    fireEvent.click(confirm);
    fireEvent.click(confirm); // segundo clique: o POST ainda está em voo

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith("/v1/platform/tenants/t-1/suspend");
    expect(confirm).toBeDisabled();

    resolvePost!();
    expect(await screen.findByText("Empresa suspensa")).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledTimes(1);
    const acmeRow = screen.getByText("ACME Lda").closest("tr")!;
    expect(within(acmeRow).getByText("Suspenso")).toBeInTheDocument();
  });

  it("falha no GET da lista mostra erro com Tentar de novo (sem spinner infinito)", async () => {
    mockGet
      .mockRejectedValueOnce(new ApiError(500, "internal", "erro no servidor"))
      .mockResolvedValueOnce([ACME]);
    renderPage();

    expect(
      await screen.findByText("Não foi possível carregar as empresas"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "A carregar empresas" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("ACME Lda")).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("drill lista users, contas e conversas do tenant", async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === "/v1/platform/tenants") return Promise.resolve([ACME]);
      if (path === "/v1/platform/tenants/t-1/users") return Promise.resolve({ users: [DRILL_USER] });
      if (path === "/v1/platform/tenants/t-1/accounts")
        return Promise.resolve({ accounts: [DRILL_ACCOUNT] });
      if (path === "/v1/platform/tenants/t-1/conversations")
        return Promise.resolve({ conversations: [DRILL_CONVERSATION], nextCursor: null });
      return Promise.reject(new Error(`path inesperado: ${path}`));
    });
    renderPage();
    await screen.findByText("ACME Lda");

    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes de ACME Lda" }));

    expect(await screen.findByText("Agente Um")).toBeInTheDocument();
    expect(screen.getByText("Suporte ACME")).toBeInTheDocument();
    expect(screen.getByText("+244923000999")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("/v1/platform/tenants/t-1/users");
      expect(mockGet).toHaveBeenCalledWith("/v1/platform/tenants/t-1/accounts");
      expect(mockGet).toHaveBeenCalledWith("/v1/platform/tenants/t-1/conversations");
    });
  });

  it("drill: conversa abre a thread read-only com a última mensagem (sem composer)", async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === "/v1/platform/tenants") return Promise.resolve([ACME]);
      if (path === "/v1/platform/tenants/t-1/users") return Promise.resolve({ users: [] });
      if (path === "/v1/platform/tenants/t-1/accounts") return Promise.resolve({ accounts: [] });
      if (path === "/v1/platform/tenants/t-1/conversations")
        return Promise.resolve({ conversations: [DRILL_CONVERSATION], nextCursor: null });
      if (path === "/v1/platform/tenants/t-1/conversations/c-9")
        return Promise.resolve({
          conversation: DRILL_CONVERSATION,
          lastMessage: DRILL_LAST_MESSAGE,
        });
      return Promise.reject(new Error(`path inesperado: ${path}`));
    });
    renderPage();
    await screen.findByText("ACME Lda");
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes de ACME Lda" }));

    fireEvent.click(await screen.findByRole("button", { name: "+244923000999" }));

    expect(await screen.findByText("Bom dia, preciso de ajuda")).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("/v1/platform/tenants/t-1/conversations/c-9");
    expect(screen.queryByLabelText("Mensagem")).toBeNull(); // read-only: sem composer
  });

  it("drill: falha no GET de users mostra erro com Tentar de novo (sem spinner infinito)", async () => {
    let usersCalls = 0;
    mockGet.mockImplementation((path: string) => {
      if (path === "/v1/platform/tenants") return Promise.resolve([ACME]);
      if (path === "/v1/platform/tenants/t-1/users") {
        usersCalls += 1;
        return usersCalls === 1
          ? Promise.reject(new ApiError(500, "internal", "falhou"))
          : Promise.resolve({ users: [DRILL_USER] });
      }
      if (path === "/v1/platform/tenants/t-1/accounts") return Promise.resolve({ accounts: [] });
      if (path === "/v1/platform/tenants/t-1/conversations")
        return Promise.resolve({ conversations: [], nextCursor: null });
      return Promise.reject(new Error(`path inesperado: ${path}`));
    });
    renderPage();
    await screen.findByText("ACME Lda");
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes de ACME Lda" }));

    expect(await screen.findByText("Não foi possível carregar os utilizadores")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "A carregar utilizadores" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("Agente Um")).toBeInTheDocument();
  });

  it("drill: falha no GET de contas mostra erro com Tentar de novo (sem spinner infinito)", async () => {
    let accountsCalls = 0;
    mockGet.mockImplementation((path: string) => {
      if (path === "/v1/platform/tenants") return Promise.resolve([ACME]);
      if (path === "/v1/platform/tenants/t-1/users") return Promise.resolve({ users: [] });
      if (path === "/v1/platform/tenants/t-1/accounts") {
        accountsCalls += 1;
        return accountsCalls === 1
          ? Promise.reject(new ApiError(500, "internal", "falhou"))
          : Promise.resolve({ accounts: [DRILL_ACCOUNT] });
      }
      if (path === "/v1/platform/tenants/t-1/conversations")
        return Promise.resolve({ conversations: [], nextCursor: null });
      return Promise.reject(new Error(`path inesperado: ${path}`));
    });
    renderPage();
    await screen.findByText("ACME Lda");
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes de ACME Lda" }));

    expect(await screen.findByText("Não foi possível carregar as contas")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "A carregar contas" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("Suporte ACME")).toBeInTheDocument();
  });

  it("drill: falha no GET de conversas mostra erro com Tentar de novo (sem spinner infinito)", async () => {
    let convCalls = 0;
    mockGet.mockImplementation((path: string) => {
      if (path === "/v1/platform/tenants") return Promise.resolve([ACME]);
      if (path === "/v1/platform/tenants/t-1/users") return Promise.resolve({ users: [] });
      if (path === "/v1/platform/tenants/t-1/accounts") return Promise.resolve({ accounts: [] });
      if (path === "/v1/platform/tenants/t-1/conversations") {
        convCalls += 1;
        return convCalls === 1
          ? Promise.reject(new ApiError(500, "internal", "falhou"))
          : Promise.resolve({ conversations: [DRILL_CONVERSATION], nextCursor: null });
      }
      return Promise.reject(new Error(`path inesperado: ${path}`));
    });
    renderPage();
    await screen.findByText("ACME Lda");
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes de ACME Lda" }));

    expect(await screen.findByText("Não foi possível carregar as conversas")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "A carregar conversas" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("+244923000999")).toBeInTheDocument();
  });
});

describe("Sidebar por âmbito", () => {
  function renderSidebar() {
    return render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
  }

  it("plataforma vê só Plataforma (sem itens de tenant)", async () => {
    mockUseSession.mockReturnValue(session("platform"));
    renderSidebar();

    expect(await screen.findByRole("link", { name: "Plataforma" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Conversas" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Utilizadores" })).toBeNull();
  });

  it("tenant vê o menu normal sem link de plataforma", async () => {
    mockUseSession.mockReturnValue(session("tenant"));
    renderSidebar();

    expect(await screen.findByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Plataforma" })).toBeNull();
  });
});

describe("RequirePlatform", () => {
  function renderRoute(scope: Scope) {
    mockUseSession.mockReturnValue(session(scope));
    return render(
      <MemoryRouter initialEntries={["/platform"]}>
        <Routes>
          <Route path="/" element={<div>home-page</div>} />
          <Route
            path="/platform"
            element={
              <RequirePlatform>
                <div>platform-page</div>
              </RequirePlatform>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("deixa a plataforma aceder", () => {
    renderRoute("platform");
    expect(screen.getByText("platform-page")).toBeInTheDocument();
  });

  it("utilizador de tenant é redirecionado para /", () => {
    renderRoute("tenant");
    expect(screen.getByText("home-page")).toBeInTheDocument();
    expect(screen.queryByText("platform-page")).toBeNull();
  });
});
