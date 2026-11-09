// Fila de handoffs: ordenação por prioridade, aceitar e o 409 de corrida.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui/Toast";
import { api, ApiError } from "../lib/api";
import type { HandoffRow } from "../lib/types";
import HandoffsPage, { sortHandoffs } from "./handoffs";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const mockGet = vi.mocked(api.get);
const mockPost = vi.mocked(api.post);

const ROW = (id: string, priority: HandoffRow["priority"], createdAt: string): HandoffRow => ({
  id,
  conversationId: `conv-${id}`,
  status: "pending",
  priority,
  createdAt,
  openingAlertedAt: null,
  slaAlertedAt: null,
  summary: `Resumo ${id}`,
  reason: `Motivo ${id}`,
  leadSnapshot: null,
});

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <HandoffsPage />
      </MemoryRouter>
    </ToastProvider>,
  );
}

let rows: HandoffRow[] = [];
let listCalls = 0;

beforeEach(() => {
  vi.clearAllMocks();
  listCalls = 0;
  mockGet.mockImplementation((path: string) => {
    if (path === "/v1/handoffs") {
      listCalls += 1;
      return Promise.resolve({ handoffs: rows });
    }
    const id = path.replace("/v1/handoffs/", "");
    return Promise.resolve({ handoff: rows.find((row) => row.id === id) });
  });
});

describe("sortHandoffs", () => {
  it("urgente primeiro; dentro da prioridade, o mais antigo", () => {
    const sorted = sortHandoffs([
      ROW("n1", "normal", "2026-10-01T00:00:00Z"),
      ROW("u2", "urgent", "2026-10-03T00:00:00Z"),
      ROW("h1", "high", "2026-10-02T00:00:00Z"),
      ROW("u1", "urgent", "2026-10-01T00:00:00Z"),
    ]);
    expect(sorted.map((row) => row.id)).toEqual(["u1", "u2", "h1", "n1"]);
  });
});

describe("HandoffsPage", () => {
  it("aceita e remove da fila depois de recarregar", async () => {
    rows = [ROW("h1", "high", "2026-10-02T00:00:00Z")];
    mockPost.mockImplementation(() => {
      rows = [];
      return Promise.resolve({ status: "claimed" });
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /Resumo h1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Aceitar" }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/v1/handoffs/h1/accept", {}));
    expect(await screen.findByText("Sem handoffs pendentes")).toBeInTheDocument();
  });

  it("409 handoff_taken recarrega a fila", async () => {
    rows = [ROW("h1", "urgent", "2026-10-02T00:00:00Z")];
    mockPost.mockRejectedValue(new ApiError(409, "handoff_taken", "já aceite"));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /Resumo h1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Aceitar" }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  });
});
