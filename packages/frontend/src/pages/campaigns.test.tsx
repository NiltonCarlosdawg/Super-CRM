// Página de campanhas reais (Fase 4): só contas purpose=campaigns, acções por
// estado e payloads exactos das mutações (o api é mockado).

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui/Toast";
import { api } from "../lib/api";
import type { AccountRow, Campaign } from "../lib/types";
import CampaignsPage, { campaignAccounts } from "./campaigns";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const mockGet = vi.mocked(api.get);
const mockPost = vi.mocked(api.post);

const CAMPAIGN: Campaign = {
  id: "cmp-1",
  name: "Promo",
  status: "draft",
  messageTemplate: "Olá {{nome}}",
  allowedAccountIds: ["acc-1"],
  dailyLimit: null,
  scheduledAt: null,
  pauseReason: null,
  pausedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const ACCOUNT = (id: string, purpose: AccountRow["purpose"]): AccountRow => ({
  id,
  label: id,
  phoneE164: null,
  providerSessionId: `s-${id}`,
  status: "connected",
  purpose,
});

function renderPage() {
  return render(
    <ToastProvider>
      <CampaignsPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockImplementation((path: string) => {
    if (path === "/v1/campaigns") {
      return Promise.resolve({ items: [CAMPAIGN], nextCursor: null });
    }
    if (path === "/v1/whatsapp-accounts") {
      return Promise.resolve({
        accounts: [ACCOUNT("acc-1", "campaigns"), ACCOUNT("acc-2", "support")],
      });
    }
    return Promise.resolve({
      campaign: CAMPAIGN,
      counts: { pending: 2, sent: 0, failed: 0, replied: 0, optedOut: 0 },
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("campaignAccounts", () => {
  it("só deixa passar contas com purpose campaigns", () => {
    expect(campaignAccounts([ACCOUNT("a", "campaigns"), ACCOUNT("b", "support")])).toHaveLength(1);
  });
});

describe("CampaignsPage", () => {
  it("lista, abre o detalhe e inicia com Idempotency-Key", async () => {
    mockPost.mockResolvedValue({ recipientsCreated: 3 });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /Promo/ }));
    expect(await screen.findByText("Pendentes: 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Iniciar" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const [path, body, opts] = mockPost.mock.calls[0];
    expect(path).toBe("/v1/campaigns/cmp-1/start");
    expect(body).toEqual({ scheduledAt: null });
    expect(typeof opts?.idempotencyKey).toBe("string");
  });

  it("campanha pausada mostra Retomar e chama resume", async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === "/v1/campaigns") {
        return Promise.resolve({
          items: [{ ...CAMPAIGN, status: "paused", pauseReason: "human" }],
          nextCursor: null,
        });
      }
      if (path === "/v1/whatsapp-accounts") {
        return Promise.resolve({ accounts: [ACCOUNT("acc-1", "campaigns")] });
      }
      return Promise.resolve({
        campaign: { ...CAMPAIGN, status: "paused", pauseReason: "human" },
        counts: { pending: 1, sent: 1, failed: 0, replied: 0, optedOut: 0 },
      });
    });
    mockPost.mockResolvedValue({ campaign: { ...CAMPAIGN, status: "running" } });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /Promo/ }));
    expect(await screen.findByText("Pausada por um humano")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retomar" }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/v1/campaigns/cmp-1/resume", {}),
    );
  });

  it("cria com o payload exacto e uma chave nova", async () => {
    mockPost.mockResolvedValue({ campaign: CAMPAIGN, replayed: false });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Nova campanha" }));
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Nova" } });
    fireEvent.change(screen.getByLabelText("Mensagem"), {
      target: { value: "Olá {{nome}}" },
    });
    fireEvent.click(screen.getByLabelText(/acc-1/));
    fireEvent.click(screen.getByRole("button", { name: "Criar" }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const [path, body, opts] = mockPost.mock.calls[0];
    expect(path).toBe("/v1/campaigns");
    expect(body).toEqual({
      name: "Nova",
      messageTemplate: "Olá {{nome}}",
      allowedAccountIds: ["acc-1"],
      dailyLimit: null,
    });
    expect(typeof opts?.idempotencyKey).toBe("string");
  });
});
