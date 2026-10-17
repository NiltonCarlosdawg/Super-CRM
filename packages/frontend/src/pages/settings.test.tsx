// Página de Definições (Onda 1, Task 11): mudança da própria password com
// confirmação de revogação de sessões (POST /v1/auth/password → 204; mantém a
// sessão actual, revoga as outras — backend login.ts:112) e activação de TOTP
// com o MESMO fluxo do login (POST /v1/auth/totp/setup → {otpauthUrl};
// POST /v1/auth/totp/verify {code} → {ok:true} — routes/auth.ts:169-199).
// Nota honesta: não existe rota para desactivar TOTP. O api é mockado.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui/Toast";
import { api, ApiError } from "../lib/api";
import SettingsPage from "./settings";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const mockPost = vi.mocked(api.post);

const OTPAUTH = "otpauth://totp/MilVendas:admin@milvendas.local?secret=JBSWY3DPEHPK3PXP&issuer=MilVendas";

function renderPage() {
  return render(
    <ToastProvider>
      <SettingsPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SettingsPage — palavra-passe", () => {
  it("mudança: submissão confirma no modal e envia POST exacto {currentPassword,newPassword}", async () => {
    mockPost.mockResolvedValue(undefined); // 204 sem corpo (api devolve undefined)
    renderPage();

    fireEvent.change(screen.getByLabelText("Palavra-passe actual"), {
      target: { value: "senha-actual-123" },
    });
    fireEvent.change(screen.getByLabelText("Nova palavra-passe"), {
      target: { value: "senha-nova-super-forte" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mudar palavra-passe" }));

    // o aviso de revogação aparece ANTES do envio (confirmação)
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/sessões/);
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith("/v1/auth/password", {
        currentPassword: "senha-actual-123",
        newPassword: "senha-nova-super-forte",
      });
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Palavra-passe alterada");
    expect(screen.queryByRole("dialog")).toBeNull();
    // os campos não retêm a password
    expect(screen.getByLabelText("Palavra-passe actual")).toHaveValue("");
    expect(screen.getByLabelText("Nova palavra-passe")).toHaveValue("");
  });

  it("actual incorrecta (401) mostra o erro mapeado e mantém o modal aberto", async () => {
    mockPost.mockRejectedValue(
      new ApiError(401, "invalid_credentials", "credenciais inválidas"),
    );
    renderPage();

    fireEvent.change(screen.getByLabelText("Palavra-passe actual"), {
      target: { value: "errada" },
    });
    fireEvent.change(screen.getByLabelText("Nova palavra-passe"), {
      target: { value: "senha-nova-super-forte" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mudar palavra-passe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirmar" }));

    expect(await screen.findByText("A palavra-passe actual está incorrecta")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("SettingsPage — TOTP", () => {
  it("activar mostra o QR (setup) e o código submete verify {code}", async () => {
    mockPost
      .mockResolvedValueOnce({ otpauthUrl: OTPAUTH })
      .mockResolvedValueOnce({ ok: true });
    const { container } = renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Activar TOTP" }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenNthCalledWith(1, "/v1/auth/totp/setup");
    });
    expect(await screen.findByLabelText("Código de confirmação")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull(); // QR

    fireEvent.change(screen.getByLabelText("Código de confirmação"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenNthCalledWith(2, "/v1/auth/totp/verify", { code: "123456" });
    });
    expect(await screen.findByRole("status")).toHaveTextContent("TOTP activado");
  });

  it("falha no setup mostra o erro e não mostra o QR", async () => {
    mockPost.mockRejectedValueOnce(new ApiError(503, "provider_unavailable", "servidor em baixo"));
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Activar TOTP" }));

    expect(await screen.findByText("servidor em baixo")).toBeInTheDocument();
    expect(screen.queryByLabelText("Código de confirmação")).toBeNull();
  });

  it("código inválido (400) mostra o erro e não activa", async () => {
    mockPost
      .mockResolvedValueOnce({ otpauthUrl: OTPAUTH })
      .mockRejectedValueOnce(new ApiError(400, "invalid_code", "código TOTP inválido"));
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Activar TOTP" }));
    fireEvent.change(await screen.findByLabelText("Código de confirmação"), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    expect(await screen.findByText("Código inválido — tenta de novo")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("mostra a nota honesta: desactivar o TOTP não está disponível", () => {
    renderPage();
    expect(
      screen.getByText(/desactivar o TOTP não está disponível — contacte o suporte/i),
    ).toBeInTheDocument();
  });
});
