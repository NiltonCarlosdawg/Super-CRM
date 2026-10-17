// Sidebar (Onda 1, Task 11): "Contas" só para papel admin (rota /accounts é
// admin-only no cliente — RequireAdmin em main.tsx) e item "Definições" para
// todos os papéis de tenant. A plataforma mantém o menu da Task 10 (só
// "Plataforma"). O useSession é mockado — a autoridade é o backend.

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "../lib/auth";
import type { Role, Scope } from "../lib/types";
import { Sidebar } from "./Sidebar";

vi.mock("../lib/auth", () => ({ useSession: vi.fn() }));

const mockUseSession = vi.mocked(useSession);

function session(role: Role, scope: Scope) {
  return {
    status: "authed" as const,
    user: { id: "u-1", name: "A", email: "a@b.c", role, scope },
    otpauthUrl: null,
    error: null,
    login: vi.fn(),
    register: vi.fn(),
    verifyTotp: vi.fn(),
    logout: vi.fn(),
  };
}

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Sidebar", () => {
  it("admin de tenant vê Contas, Utilizadores e Definições", () => {
    mockUseSession.mockReturnValue(session("admin", "tenant"));
    renderSidebar();

    expect(screen.getByRole("link", { name: "Contas" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Utilizadores" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Definições" })).toBeInTheDocument();
  });

  it("não-admin não vê Contas nem Utilizadores, mas vê Definições", () => {
    mockUseSession.mockReturnValue(session("agent", "tenant"));
    renderSidebar();

    expect(screen.queryByRole("link", { name: "Contas" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Utilizadores" })).toBeNull();
    expect(screen.getByRole("link", { name: "Definições" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Conversas" })).toBeInTheDocument();
  });

  it("plataforma continua a ver só Plataforma (sem Contas nem Definições)", () => {
    mockUseSession.mockReturnValue(session("platform_admin", "platform"));
    renderSidebar();

    expect(screen.getByRole("link", { name: "Plataforma" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Contas" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Definições" })).toBeNull();
  });
});
