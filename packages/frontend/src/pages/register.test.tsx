// Página de registo público (Onda 1, Task 9): os 4 campos, a transição
// directa para o setup TOTP (a resposta do /v1/auth/register é a do login),
// a tradução de erros e o link a partir do login. O useSession é mockado —
// o register() em si está testado em lib/auth.test.tsx.

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "../lib/auth";
import LoginPage from "./login";
import RegisterPage from "./register";

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

// A página tem um Link para /login — Link exige Router em qualquer estado.
function renderRegister() {
  return render(
    <MemoryRouter initialEntries={["/register"]}>
      <RegisterPage />
    </MemoryRouter>,
  );
}

function fillForm() {
  fireEvent.change(screen.getByLabelText("Nome da empresa"), { target: { value: "ACME" } });
  fireEvent.change(screen.getByLabelText("O teu nome"), { target: { value: "Ana" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ana@acme.ao" } });
  fireEvent.change(screen.getByLabelText("Palavra-passe"), {
    target: { value: "uma-palavra-passe-comprida" },
  });
}

describe("RegisterPage", () => {
  it("submissão happy chama register com os 4 campos", () => {
    const register = vi.fn();
    mockUseSession.mockReturnValue(session({ register }));
    renderRegister();

    expect(screen.getByRole("heading", { name: "Cria a tua empresa" })).toBeInTheDocument();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Criar conta" }));

    expect(register).toHaveBeenCalledWith({
      tenantName: "ACME",
      name: "Ana",
      email: "ana@acme.ao",
      password: "uma-palavra-passe-comprida",
    });
  });

  it("mfa_setup mostra o QR, o campo de código e o aviso de administrador", () => {
    mockUseSession.mockReturnValue(
      session({ status: "mfa_setup", otpauthUrl: "otpauth://totp/MilVendas:ana@acme.ao" }),
    );
    const { container } = renderRegister();

    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getByLabelText("Código de confirmação")).toBeInTheDocument();
    expect(screen.getByText(/administrador/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Nome da empresa")).toBeNull();
  });

  it("mfa_required no boot mostra só o código (sem QR) com o aviso de admin", () => {
    mockUseSession.mockReturnValue(session({ status: "mfa_required" }));
    const { container } = renderRegister();

    expect(screen.getByLabelText("Código de confirmação")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByLabelText("Nome da empresa")).toBeNull();
    expect(
      screen.getByText(/falta activar o TOTP na tua conta de administrador/),
    ).toBeInTheDocument();
  });

  it("409 email_already_exists aparece como erro inline", () => {
    mockUseSession.mockReturnValue(
      session({ error: { title: "email_already_exists", detail: "email já registado" } }),
    );
    renderRegister();

    expect(screen.getByRole("alert")).toHaveTextContent(/email já registado/i);
  });

  it("weak_password (400 do servidor) é traduzido", () => {
    mockUseSession.mockReturnValue(
      session({
        error: {
          title: "weak_password",
          detail: "password rejeitada pela política (12–100 caracteres, sem só espaços)",
        },
      }),
    );
    renderRegister();

    expect(screen.getByRole("alert")).toHaveTextContent("A palavra-passe é demasiado fraca");
  });

  it("mostra a dica mínima de palavra-passe", () => {
    mockUseSession.mockReturnValue(session());
    renderRegister();

    expect(
      screen.getByText("Mínimo de 12 caracteres (a validação é feita no servidor)"),
    ).toBeInTheDocument();
  });

  it("link no login navega para /register", () => {
    mockUseSession.mockReturnValue(session());
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<div>registo-page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Ainda não tens conta? Cria a tua empresa" }));
    expect(screen.getByText("registo-page")).toBeInTheDocument();
  });

  it("sem sessão (anon) mostra o form de registo — não está autenticado", () => {
    mockUseSession.mockReturnValue(session());
    renderRegister();

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByLabelText("Código de confirmação")).toBeNull();
  });

  it("authed redireciona para /", () => {
    mockUseSession.mockReturnValue(session({ status: "authed" }));
    render(
      <MemoryRouter initialEntries={["/register"]}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/" element={<div>dashboard</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  it("submit do código chama verifyTotp('123456')", () => {
    const verifyTotp = vi.fn();
    mockUseSession.mockReturnValue(
      session({ status: "mfa_setup", otpauthUrl: "otpauth://totp/X", verifyTotp }),
    );
    renderRegister();

    fireEvent.change(screen.getByLabelText("Código de confirmação"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    expect(verifyTotp).toHaveBeenCalledWith("123456");
  });

  it("link de volta ao login", () => {
    mockUseSession.mockReturnValue(session());
    render(
      <MemoryRouter initialEntries={["/register"]}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/login" element={<div>login-page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Já tens conta? Entra" }));
    expect(screen.getByText("login-page")).toBeInTheDocument();
  });
});
