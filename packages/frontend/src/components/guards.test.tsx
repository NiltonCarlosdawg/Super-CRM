// Guardas de rota (Task 5 do plano do frontend): RequireAuth e RequireAdmin
// sobre o useSession mockado — o redirect é o comportamento a provar.

import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "./ui/Toast";
import { useSession } from "../lib/auth";
import { RequireAdmin, RequireAuth } from "./guards";

vi.mock("../lib/auth", () => ({ useSession: vi.fn() }));

const mockUseSession = vi.mocked(useSession);

function session(overrides: Partial<ReturnType<typeof useSession>> = {}) {
  return {
    status: "authed" as const,
    user: { id: "u1", name: "A", email: "a@b.c", role: "admin" as const, scope: "tenant" as const },
    otpauthUrl: null,
    error: null,
    login: vi.fn(),
    register: vi.fn(),
    verifyTotp: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  };
}

function renderRoutes(element: ReactElement) {
  return render(
    <MemoryRouter initialEntries={["/users"]}>
      <Routes>
        <Route path="/login" element={<div>login-page</div>} />
        <Route path="/" element={<div>home-page</div>} />
        <Route path="/users" element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RequireAuth", () => {
  it("renderiza children em authed", () => {
    mockUseSession.mockReturnValue(session());
    renderRoutes(
      <RequireAuth>
        <div>conteúdo protegido</div>
      </RequireAuth>,
    );
    expect(screen.getByText("conteúdo protegido")).toBeInTheDocument();
  });

  it("redireciona para /login em anon", () => {
    mockUseSession.mockReturnValue(session({ status: "anon", user: null }));
    renderRoutes(
      <RequireAuth>
        <div>conteúdo protegido</div>
      </RequireAuth>,
    );
    expect(screen.getByText("login-page")).toBeInTheDocument();
    expect(screen.queryByText("conteúdo protegido")).toBeNull();
  });

  it("mfa pendente (setup ou required) vai para /login", () => {
    for (const status of ["mfa_setup", "mfa_required"] as const) {
      mockUseSession.mockReturnValue(session({ status, user: null }));
      renderRoutes(
        <RequireAuth>
          <div>conteúdo protegido</div>
        </RequireAuth>,
      );
      expect(screen.getByText("login-page")).toBeInTheDocument();
      expect(screen.queryByText("conteúdo protegido")).toBeNull();
      cleanup();
    }
  });

  it("em loading mostra o spinner e não os filhos", () => {
    mockUseSession.mockReturnValue(session({ status: "loading", user: null }));
    renderRoutes(
      <RequireAuth>
        <div>conteúdo protegido</div>
      </RequireAuth>,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("conteúdo protegido")).toBeNull();
  });
});

describe("RequireAdmin", () => {
  it("redireciona para / se papel não é admin", () => {
    mockUseSession.mockReturnValue(
      session({ user: { id: "u1", name: "A", email: "a@b.c", role: "agent", scope: "tenant" } }),
    );
    renderRoutes(
      <RequireAdmin>
        <div>users-page</div>
      </RequireAdmin>,
    );
    expect(screen.getByText("home-page")).toBeInTheDocument();
    expect(screen.queryByText("users-page")).toBeNull();
  });

  it("deixa admin entrar", () => {
    mockUseSession.mockReturnValue(session());
    renderRoutes(
      <RequireAdmin>
        <div>users-page</div>
      </RequireAdmin>,
    );
    expect(screen.getByText("users-page")).toBeInTheDocument();
  });

  // Onda 1, Task 11: /accounts é admin-only no cliente; quem chega por URL
  // directo é redirecionado com um toast honesto (aviso = notice).
  it("com notice, não-admin é redirecionado para / e vê o toast honesto", () => {
    mockUseSession.mockReturnValue(
      session({ user: { id: "u1", name: "A", email: "a@b.c", role: "agent", scope: "tenant" } }),
    );
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={["/accounts"]}>
          <Routes>
            <Route path="/login" element={<div>login-page</div>} />
            <Route path="/" element={<div>home-page</div>} />
            <Route
              path="/accounts"
              element={
                <RequireAdmin notice="Acesso restrito: só administradores podem abrir as Contas.">
                  <div>accounts-page</div>
                </RequireAdmin>
              }
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    expect(screen.getByText("home-page")).toBeInTheDocument();
    expect(screen.queryByText("accounts-page")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Acesso restrito: só administradores podem abrir as Contas.",
    );
  });
});
