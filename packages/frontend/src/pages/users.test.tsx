// Página de utilizadores (Task 11 do plano do frontend): lista com papel e
// estado, criação em modal (política de password no servidor, dica no campo),
// acções desactivadas na linha do próprio (o backend recusa cannot_modify_self)
// e 409 (last_admin, email_already_exists) em toast. O api é mockado —
// contratos reais em routes/users.ts + db/users.ts:11-17 (UserSummary).

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui/Toast";
import { api, ApiError } from "../lib/api";
import { useSession } from "../lib/auth";
import { userStatusLabel } from "../lib/labels";
import type { UserSummary } from "../lib/types";
import UsersPage from "./users";

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
const mockPatch = vi.mocked(api.patch);
const mockUseSession = vi.mocked(useSession);

// O ME é o utilizador da sessão — a linha dele nasce sem controlos.
const ME: UserSummary = {
  id: "u-1",
  name: "Admin Validação",
  email: "admin@milvendas.local",
  role: "admin",
  active: true,
};
const OTHER: UserSummary = {
  id: "u-2",
  name: "Editor Um",
  email: "editor@milvendas.local",
  role: "editor",
  active: true,
};

function session() {
  return {
    status: "authed" as const,
    user: { id: ME.id, name: ME.name, email: ME.email, role: ME.role, scope: "tenant" as const },
    otpauthUrl: null,
    error: null,
    login: vi.fn(),
    register: vi.fn(),
    verifyTotp: vi.fn(),
    logout: vi.fn(),
  };
}

function renderPage() {
  return render(
    <ToastProvider>
      <UsersPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSession.mockReturnValue(session());
  mockGet.mockResolvedValue({ users: [ME, OTHER] });
});

describe("userStatusLabel", () => {
  it("traduz activo e inactivo", () => {
    expect(userStatusLabel(true)).toBe("Activo");
    expect(userStatusLabel(false)).toBe("Inactivo");
  });
});

describe("UsersPage", () => {
  it("lista os utilizadores de GET /v1/users", async () => {
    renderPage();

    expect(await screen.findByText("Editor Um")).toBeInTheDocument();
    expect(screen.getByText("admin@milvendas.local")).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("/v1/users");
  });

  it("criação envia payload exacto {name,email,role,password}", async () => {
    mockPost.mockResolvedValue({
      user: { id: "u-3", name: "Nova", email: "nova@milvendas.local", role: "agent", active: true },
    });
    renderPage();
    await screen.findByText("Editor Um");

    fireEvent.click(screen.getByRole("button", { name: "Novo utilizador" }));
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Nova" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "nova@milvendas.local" } });
    fireEvent.change(screen.getByLabelText("Papel"), { target: { value: "agent" } });
    fireEvent.change(screen.getByLabelText("Palavra-passe"), {
      target: { value: "senha-super-longa" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Criar" }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith("/v1/users", {
        name: "Nova",
        email: "nova@milvendas.local",
        role: "agent",
        password: "senha-super-longa",
      });
    });
    expect(await screen.findByText("nova@milvendas.local")).toBeInTheDocument();
  });

  it("linha do próprio utilizador não tem controlos de papel/estado", async () => {
    renderPage();
    await screen.findByText("Editor Um");

    expect(screen.getByLabelText(`Papel de ${ME.name}`)).toBeDisabled();
    expect(screen.queryByRole("button", { name: `Desactivar ${ME.name}` })).toBeNull();

    expect(screen.getByLabelText(`Papel de ${OTHER.name}`)).not.toBeDisabled();
    expect(screen.getByRole("button", { name: `Desactivar ${OTHER.name}` })).toBeInTheDocument();
  });

  it("alterar papel envia {role:'agent'}", async () => {
    mockPatch.mockResolvedValue({ user: { ...OTHER, role: "agent" } });
    renderPage();
    await screen.findByText("Editor Um");

    fireEvent.change(screen.getByLabelText(`Papel de ${OTHER.name}`), {
      target: { value: "agent" },
    });

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith("/v1/users/u-2", { role: "agent" });
    });
  });

  it("desactivar envia {active:false} e a linha passa a Inactivo", async () => {
    mockPatch.mockResolvedValue({ user: { ...OTHER, active: false } });
    renderPage();
    await screen.findByText("Editor Um");

    fireEvent.click(screen.getByRole("button", { name: `Desactivar ${OTHER.name}` }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith("/v1/users/u-2", { active: false });
    });
    expect(await screen.findByText("Inactivo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Activar ${OTHER.name}` })).toBeInTheDocument();
  });

  it("last_admin (409) no estado mostra toast com o detalhe", async () => {
    mockPatch.mockRejectedValue(
      new ApiError(409, "last_admin", "não é possível remover o último administrador ativo"),
    );
    renderPage();
    await screen.findByText("Editor Um");

    fireEvent.click(screen.getByRole("button", { name: `Desactivar ${OTHER.name}` }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("não é possível remover o último administrador ativo");
  });

  // Reposição de password (Onda 1, Task 11): PATCH /v1/users/:id {password}
  // (routes/users.ts:89-140 — revoga TODAS as sessões do alvo e audita
  // user.password_reset); admin só, e a linha do próprio continua sem acções
  // (ruling T11 — cannot_modify_self do backend).

  it("repo de password: visível só em admin e nunca na linha do próprio", async () => {
    renderPage();
    await screen.findByText("Editor Um");

    expect(
      screen.getByRole("button", { name: `Repor palavra-passe de ${OTHER.name}` }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Repor palavra-passe de ${ME.name}` })).toBeNull();
  });

  it("sem papel admin o controlo de repo não aparece", async () => {
    mockUseSession.mockReturnValue({
      ...session(),
      user: { id: "u-9", name: "Agente", email: "agente@milvendas.local", role: "agent", scope: "tenant" },
    });
    renderPage();
    await screen.findByText("Editor Um");

    expect(screen.queryByRole("button", { name: /Repor palavra-passe/ })).toBeNull();
  });

  it("repo: modal com aviso de sessões → PATCH {password} → toast e campo limpo", async () => {
    mockPatch.mockResolvedValue({ user: OTHER });
    renderPage();
    await screen.findByText("Editor Um");

    fireEvent.click(screen.getByRole("button", { name: `Repor palavra-passe de ${OTHER.name}` }));
    // aviso de revogação ANTES do envio (o backend revoga todas as sessões)
    expect(screen.getByRole("dialog")).toHaveTextContent(/sessões/);

    fireEvent.change(screen.getByLabelText("Nova palavra-passe"), {
      target: { value: "senha-reposta-1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Repor" }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith("/v1/users/u-2", { password: "senha-reposta-1234" });
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Palavra-passe reposta");
    expect(screen.queryByRole("dialog")).toBeNull();

    // a password nunca fica no DOM: reabrir o modal mostra o campo vazio
    fireEvent.click(screen.getByRole("button", { name: `Repor palavra-passe de ${OTHER.name}` }));
    expect(screen.getByLabelText("Nova palavra-passe")).toHaveValue("");
  });

  it("erro no repo mostra toast com o detail e mantém o modal aberto", async () => {
    mockPatch.mockRejectedValue(new ApiError(400, "weak_password", "mínimo de 12 caracteres"));
    renderPage();
    await screen.findByText("Editor Um");

    fireEvent.click(screen.getByRole("button", { name: `Repor palavra-passe de ${OTHER.name}` }));
    fireEvent.change(screen.getByLabelText("Nova palavra-passe"), {
      target: { value: "senha-reposta-1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Repor" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("mínimo de 12 caracteres");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("email já registado (409) na criação mostra toast e mantém o modal aberto", async () => {
    mockPost.mockRejectedValue(new ApiError(409, "email_already_exists", "email já registado"));
    renderPage();
    await screen.findByText("Editor Um");

    fireEvent.click(screen.getByRole("button", { name: "Novo utilizador" }));
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Repetida" } });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "editor@milvendas.local" },
    });
    fireEvent.change(screen.getByLabelText("Papel"), { target: { value: "agent" } });
    fireEvent.change(screen.getByLabelText("Palavra-passe"), {
      target: { value: "senha-super-longa" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Criar" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("email já registado");
    expect(screen.getByRole("dialog", { name: "Novo utilizador" })).toBeInTheDocument();
  });
});
