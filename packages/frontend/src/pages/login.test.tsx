// Página de login (Task 6 do plano do frontend): os3 estados da máquina de
// sessão (anon / mfa_setup / mfa_required), submissão e erro mapeado.
// O useSession é mockado — o fluxo de estados já está testado na Task 2.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "../lib/auth";
import LoginPage from "./login";

vi.mock("../lib/auth", () => ({ useSession: vi.fn() }));

const mockUseSession = vi.mocked(useSession);

function session(overrides: Partial<ReturnType<typeof useSession>> = {}) {
  return {
    status: "anon" as const,
    user: null,
    otpauthUrl: null,
    error: null,
    login: vi.fn(),
    register: vi.fn(),
    verifyTotp: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// O login ganhou o Link para /register (Task 9) — Link exige Router, por isso
// as renderizações passam por aqui. Asserções unchanged.
function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  it("anon mostra email/palavra-passe e submete login", () => {
    const login = vi.fn();
    mockUseSession.mockReturnValue(session({ login }));
    renderLogin();

    expect(screen.getByRole("heading", { name: "Painel MilVendas" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.c" } });
    fireEvent.change(screen.getByLabelText("Palavra-passe"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));

    expect(login).toHaveBeenCalledWith("a@b.c", "pw");
  });

  it("mfa_setup mostra o QR e o campo de código", () => {
    mockUseSession.mockReturnValue(
      session({ status: "mfa_setup", otpauthUrl: "otpauth://totp/MilVendas:a@b.c" }),
    );
    const { container } = renderLogin();

    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getByLabelText("Código de confirmação")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeInTheDocument();
  });

  it("mfa_required só mostra o código", () => {
    mockUseSession.mockReturnValue(session({ status: "mfa_required" }));
    const { container } = renderLogin();

    expect(screen.getByLabelText("Código de confirmação")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByLabelText("Palavra-passe")).toBeNull();
  });

  it("submit do código chama verifyTotp('123456')", () => {
    const verifyTotp = vi.fn();
    mockUseSession.mockReturnValue(session({ status: "mfa_required", verifyTotp }));
    renderLogin();

    fireEvent.change(screen.getByLabelText("Código de confirmação"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    expect(verifyTotp).toHaveBeenCalledWith("123456");
  });

  it("erro do contexto aparece mapeado", () => {
    mockUseSession.mockReturnValue(
      session({ error: { title: "invalid_credentials", detail: "credenciais inválidas" } }),
    );
    renderLogin();

    expect(screen.getByRole("alert")).toHaveTextContent("Email ou palavra-passe incorrectos");
  });

  it("authed redireciona para / (o login bem-sucedido não fica no form)", () => {
    mockUseSession.mockReturnValue(session({ status: "authed" }));
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>dashboard</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Painel MilVendas" })).toBeNull();
  });

  it("loading do boot não mostra o form de credenciais (sem flash)", () => {
    mockUseSession.mockReturnValue(session({ status: "loading" }));
    renderLogin();

    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByLabelText("Palavra-passe")).toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("estados de TOTP oferecem Usar outra conta (logout)", () => {
    for (const status of ["mfa_setup", "mfa_required"] as const) {
      const logout = vi.fn();
      mockUseSession.mockReturnValue(session({ status, logout }));
      renderLogin();

      fireEvent.click(screen.getByRole("button", { name: "Usar outra conta" }));
      expect(logout).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });
});
