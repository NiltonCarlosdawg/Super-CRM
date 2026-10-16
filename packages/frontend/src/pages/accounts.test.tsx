// Página de contas WhatsApp (Task 7 do plano do frontend): vocabulário de
// estados, poll do QR que pára quando a conta liga, formulário de criação e
// toast quando o provider cai. O api é mockado — contratos reais no backend.

import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui/Toast";
import { api, ApiError } from "../lib/api";
import { accountPurposeLabel, accountStatusLabel } from "../lib/labels";
import type { AccountStatus } from "../lib/types";
import AccountsPage, { accountTone, useAccountQr } from "./accounts";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const mockGet = vi.mocked(api.get);
const mockPost = vi.mocked(api.post);

const ROW = {
  id: "acc-1",
  label: "Suporte Luanda",
  phoneE164: "+244923000111",
  providerSessionId: "p1",
  status: "connecting" as AccountStatus,
  purpose: "support" as const,
};

function renderPage() {
  return render(
    <ToastProvider>
      <AccountsPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("accountStatusLabel / accountTone / accountPurposeLabel", () => {
  it("cobre os quatro estados com PT-AO", () => {
    expect(accountStatusLabel("connecting")).toBe("A ligar");
    expect(accountStatusLabel("connected")).toBe("Ligada");
    expect(accountStatusLabel("disconnected")).toBe("Desligada");
    expect(accountStatusLabel("suspected_ban")).toBe("Suspeita de bloqueio");
  });

  it("accountTone mapeia os quatro estados para tons do Badge", () => {
    expect(accountTone("connecting")).toBe("info");
    expect(accountTone("connected")).toBe("success");
    expect(accountTone("disconnected")).toBe("neutral");
    expect(accountTone("suspected_ban")).toBe("danger");
  });

  it("accountPurposeLabel traduz os três objectivos", () => {
    expect(accountPurposeLabel("support")).toBe("Atendimento");
    expect(accountPurposeLabel("sales")).toBe("Vendas");
    expect(accountPurposeLabel("campaigns")).toBe("Campanhas");
  });
});

describe("useAccountQr", () => {
  it("poll de 4s enquanto connecting e pára quando a conta liga", async () => {
    vi.useFakeTimers();
    mockGet.mockResolvedValue({ account: ROW, qr: "otpauth://totp/novo" });

    const { result, rerender } = renderHook(
      ({ status }: { status: AccountStatus }) => useAccountQr("acc-1", status),
      { initialProps: { status: "connecting" as AccountStatus } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGet).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(result.current.qr).toBe("otpauth://totp/novo");

    rerender({ status: "connected" });
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(mockGet).toHaveBeenCalledTimes(2); // nenhum poll novo
  });

  it("sem conta seleccionada não pede nada", async () => {
    renderHook(() => useAccountQr(null, null));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe("AccountsPage", () => {
  it("lista com badge de estado e telefone", async () => {
    mockGet.mockResolvedValue({ accounts: [ROW] });
    renderPage();

    expect(await screen.findByText("Suporte Luanda")).toBeInTheDocument();
    expect(screen.getByText("A ligar")).toBeInTheDocument();
    expect(screen.getByText(/\+244923000111/)).toBeInTheDocument();
  });

  it("criar conta envia {label, purpose} e o select tem os 3 rótulos PT", async () => {
    mockGet.mockResolvedValue({ accounts: [] });
    mockPost.mockResolvedValue({ account: { ...ROW, id: "novo-1", purpose: "campaigns" } });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Criar conta" }));
    fireEvent.change(screen.getByLabelText("Nome da conta"), {
      target: { value: "Suporte Luanda" },
    });
    const select = screen.getByLabelText("Objectivo da conta");
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Atendimento", "Vendas", "Campanhas"]);
    fireEvent.change(select, { target: { value: "campaigns" } });

    fireEvent.click(screen.getByRole("button", { name: "Criar" }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/v1/whatsapp-accounts", {
        label: "Suporte Luanda",
        purpose: "campaigns",
      }),
    );
  });

  it("provider_unavailable vira toast com o detail do backend", async () => {
    mockGet.mockResolvedValue({ accounts: [] });
    mockPost.mockRejectedValue(
      new ApiError(503, "provider_unavailable", "WA-AKG indisponível: tente novamente"),
    );
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Criar conta" }));
    fireEvent.change(screen.getByLabelText("Nome da conta"), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "WA-AKG indisponível: tente novamente",
    );
  });
});
