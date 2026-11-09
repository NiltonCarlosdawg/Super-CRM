// Página de conhecimento: payloads das mutações e acções por separador. O api
// é mockado por path; as respostas seguem os envelopes reais da Fase 2–4.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui/Toast";
import { api } from "../lib/api";
import type { DraftItem, KnowledgeGap, KnowledgeSuggestion } from "../lib/types";
import KnowledgePage from "./knowledge";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const mockGet = vi.mocked(api.get);
const mockPost = vi.mocked(api.post);

const DRAFT: DraftItem = {
  id: "d-1",
  slug: "camera-x",
  entityType: "catalog_item",
  op: "create",
  lineSlug: "cctv",
  lineConfirmed: true,
  payload: { name: "Câmara X" },
  chunks: null,
  baseVersion: null,
  changedById: "u-1",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const SUGGESTION: KnowledgeSuggestion = {
  id: "s-1",
  gapId: null,
  aiAnswer: null,
  humanAnswer: "Custa 50 mil",
  proposedTitle: "Preço da instalação",
  proposedBody: "A instalação custa 50 mil kwanzas.",
  proposedLineSlug: null,
  proposedDocType: "faq",
  status: "pending",
  createdAt: new Date().toISOString(),
};

const GAP: KnowledgeGap = {
  id: "g-1",
  question: "Fazem instalação no Lubango?",
  occurrences: 3,
  conversationId: null,
  status: "open",
  createdAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
};

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <KnowledgePage />
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockImplementation((async (path: string) => {
    if (path === "/v1/knowledge/train/draft") return { items: [DRAFT] };
    if (path === "/v1/knowledge/train/diff") {
      return {
        entries: [
          {
            slug: "camera-x",
            entityType: "catalog_item",
            op: "create",
            classification: "conflict",
            baseVersion: null,
            currentVersion: 2,
          },
        ],
        unconfirmedSlugs: [],
        digest: "d",
      };
    }
    if (path === "/v1/knowledge/gaps") return { items: [GAP] };
    if (path === "/v1/knowledge/suggestions") return { items: [SUGGESTION] };
    if (path === "/v1/knowledge/published") return { items: [] };
    if (path === "/v1/knowledge/publications") return { publications: [] };
    if (path === "/v1/knowledge/reviews") return { items: [] };
    if (path === "/v1/knowledge/qualification-questions") return { items: [] };
    if (path === "/v1/knowledge/triggers") return { items: [] };
    return { items: [] };
  }) as never);
});

describe("Treino", () => {
  it("publica sem conflitos com corpo vazio", async () => {
    mockGet.mockImplementation((async (path: string) => {
      if (path === "/v1/knowledge/train/draft") return { items: [DRAFT] };
      return { entries: [], unconfirmedSlugs: [], digest: "d" };
    }) as never);
    mockPost.mockResolvedValue({
      publicationId: "p-1",
      applied: { added: 1, updated: 0, archived: 0 },
      idempotent: false,
    });
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: "Treino" }));
    fireEvent.click(await screen.findByRole("button", { name: "Publicar" }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/v1/knowledge/train/validate", {}),
    );
  });

  it("conflitos exigem aceitação explícita e vão nos acceptConflicts", async () => {
    mockPost.mockResolvedValue({
      publicationId: "p-1",
      applied: { added: 1, updated: 0, archived: 0 },
      idempotent: false,
    });
    renderPage();

    const accept = await screen.findByRole("button", {
      name: "Publicar aceitando 1 conflito(s)",
    });
    fireEvent.click(accept);
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/v1/knowledge/train/validate", {
        acceptConflicts: ["camera-x"],
      }),
    );
  });
});

describe("Lacunas", () => {
  it("aprovar sugestão chama o endpoint e recarrega", async () => {
    mockPost.mockResolvedValue({});
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: "Lacunas" }));
    expect(await screen.findByText("Preço da instalação")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Aprovar" }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/v1/knowledge/suggestions/s-1/approve", {}),
    );
  });
});

describe("Configuração", () => {
  it("cria uma pergunta com o payload validado pelo servidor", async () => {
    mockPost.mockResolvedValue({});
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: "Configuração" }));
    fireEvent.click(await screen.findByRole("button", { name: "Nova pergunta" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Chave (a–z, 3–40)"), {
      target: { value: "camera_count" },
    });
    fireEvent.change(within(dialog).getByLabelText("Pergunta"), {
      target: { value: "Quantas câmaras?" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/v1/knowledge/qualification-questions", {
        lineSlug: "software",
        key: "camera_count",
        question: "Quantas câmaras?",
        answerType: "text",
        required: false,
        position: 0,
      }),
    );
  });
});

describe("Teste", () => {
  it("envia alvo e linha ao chat de teste", async () => {
    mockPost.mockResolvedValue({ reply: "Custa 50 mil", sources: [] });
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: "Teste" }));
    fireEvent.change(screen.getByLabelText("Pergunta"), {
      target: { value: "Quanto custa a instalação?" },
    });
    fireEvent.change(screen.getByLabelText("Linha de negócio (opcional)"), {
      target: { value: "telecom" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Testar" }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/v1/knowledge/chat/test", {
        text: "Quanto custa a instalação?",
        target: "published",
        lineSlug: "telecom",
      }),
    );
    expect(await screen.findByText("Custa 50 mil")).toBeInTheDocument();
  });
});
