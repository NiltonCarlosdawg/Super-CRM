// Composer (Task 10 do plano do frontend): controller puro com chave de
// idempotência gerada UMA vez por mensagem lógica (reutilizada no retry) +
// componente com estado optimista. O api é REAL e só o fetch global é
// substituído — assim o header idempotency-key que sai do request() é
// exactamente o que se afirma (contrato: routes/conversations.ts:53-72).

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui/Toast";
import { api } from "../lib/api";
import { composerSendingLabel } from "../lib/labels";
import type { MessageView } from "../lib/types";
import {
  applySentMessage,
  Composer,
  createComposer,
  type ComposerMsg,
  type ThreadState,
} from "./conversations";
type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersOf(call: unknown[]): Record<string, string> {
  const init = call[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

function serverMessage(): MessageView {
  return {
    id: "m-srv",
    conversationId: "c1",
    direction: "outbound",
    sender: "human",
    kind: "text",
    body: "olá",
    status: "queued",
    mediaRef: null,
    createdAt: "2026-10-16T10:00:00.000Z",
  };
}

describe("createComposer", () => {
  let fetchMock: FetchMock;

  function make() {
    const onState = vi.fn();
    const composer = createComposer(
      { uuid: () => "chave-fixa", post: (path, body, opts) => api.post(path, body, opts) },
      { conversationId: "c1", onState },
    );
    return { composer, onState };
  }

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      jsonResponse({ message: serverMessage(), replayed: false }, 201),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("envia com Idempotency-Key nova", async () => {
    const { composer, onState } = make();

    await composer.send("olá");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/v1/conversations/c1/messages");
    expect(headersOf(fetchMock.mock.calls[0])["idempotency-key"]).toBe("chave-fixa");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ text: "olá" });
    expect(onState.mock.calls[0][0]).toMatchObject({ status: "queued", key: "chave-fixa" });
    expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({ status: "sent" });
  });

  it("ignora send enquanto já há um envio na fila (duplo Enter, sem chave nova)", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { composer } = make();

    const primeiro = composer.send("olá");
    const segundo = composer.send("outra"); // mesmo tick: não pode gerar 2.ª chave

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await segundo).toMatchObject({ status: "queued", text: "olá" });

    resolveFetch(jsonResponse({ message: serverMessage(), replayed: false }, 201));
    expect((await primeiro).status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retry reutiliza a mesma Idempotency-Key", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("rede em baixo"))
      .mockResolvedValueOnce(jsonResponse({ message: serverMessage(), replayed: false }, 201));
    const { composer } = make();

    await composer.send("olá");
    await composer.retry();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(fetchMock.mock.calls[1])["idempotency-key"]).toBe("chave-fixa");
    expect(headersOf(fetchMock.mock.calls[1])["idempotency-key"]).toBe(
      headersOf(fetchMock.mock.calls[0])["idempotency-key"],
    );
  });

  it("sucesso reconcilia a bolha optimista com a mensagem do servidor", async () => {
    const { composer, onState } = make();

    const final = await composer.send("olá");

    expect(final).toMatchObject({ status: "sent", message: serverMessage() });
    expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "sent",
      message: serverMessage(),
    });
  });

  it("replayed (200) também reconcilia", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: serverMessage(), replayed: true }, 200));
    const { composer } = make();

    const final = await composer.send("olá");

    expect(final.status).toBe("sent");
    expect(final.message).toEqual(serverMessage());
  });

  it("409 conflito: sem reenvio e retry recusa", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { title: "idempotency_conflict", detail: "chave reutilizada com corpo diferente" },
        409,
      ),
    );
    const { composer, onState } = make();

    const final: ComposerMsg = await composer.send("olá");
    expect(final.status).toBe("conflict");
    expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({ status: "conflict" });

    await composer.retry(); // deve recusar reenviar um conflito
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx vira failed com detalhe e retry volta a enviar", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ title: "internal", detail: "erro interno" }, 500),
      )
      .mockResolvedValueOnce(jsonResponse({ message: serverMessage(), replayed: false }, 201));
    const { composer } = make();

    const falhou = await composer.send("olá");
    expect(falhou.status).toBe("failed");
    expect(falhou.detail).toBe("erro interno");

    const ok = await composer.retry();
    expect(ok?.status).toBe("sent");
    expect(headersOf(fetchMock.mock.calls[1])["idempotency-key"]).toBe("chave-fixa");
  });

  it("applySentMessage anexa nova mensagem e substitui placeholder existente por id", () => {
    const base: ThreadState = { conversationId: "c1", messages: [], handoff: null };
    const nova = serverMessage();

    const comNova = applySentMessage(base, nova);
    expect(comNova.messages).toEqual([nova]);

    // O socket pode chegar primeiro com placeholder (body "") — substituir por id, nunca duplicar.
    const placeholder: MessageView = { ...nova, body: "", status: "queued" };
    const comPlaceholder: ThreadState = { ...base, messages: [placeholder] };
    const reconciliada = applySentMessage(comPlaceholder, nova);
    expect(reconciliada.messages).toHaveLength(1);
    expect(reconciliada.messages[0]?.body).toBe("olá");
  });
});

function renderComposer(onSent: (message: MessageView) => void = vi.fn()) {
  render(
    <ToastProvider>
      <Composer conversationId="c1" onSent={onSent} />
    </ToastProvider>,
  );
  return { textarea: screen.getByLabelText<HTMLTextAreaElement>("Mensagem"), onSent };
}

function type(text: string, textarea: HTMLTextAreaElement) {
  fireEvent.change(textarea, { target: { value: text } });
}

describe("Composer (componente)", () => {
  let fetchMock: FetchMock;

  it("vocabulário optimista do composer em PT-AO", () => {
    expect(composerSendingLabel()).toBe("A enviar…");
  });

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      jsonResponse({ message: serverMessage(), replayed: false }, 201),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Enter envia, Shift+Enter não envia, vazio não envia", async () => {
    const { textarea, onSent } = renderComposer();

    fireEvent.keyDown(textarea, { key: "Enter" }); // vazio
    expect(fetchMock).not.toHaveBeenCalled();

    type("oi", textarea);
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true }); // quebra linha
    expect(fetchMock).not.toHaveBeenCalled();
    expect(textarea.value).toBe("oi");

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(serverMessage()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(textarea.value).toBe("")); // limpo no sucesso
  });

  it("desactiva o campo e o botão enquanto o envio está na fila", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );
    const { textarea } = renderComposer();

    type("oi", textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(textarea.disabled).toBe(true));
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    expect(screen.getByText("A enviar…")).toBeInTheDocument();

    resolveFetch(jsonResponse({ message: serverMessage(), replayed: false }, 201));
    await waitFor(() => expect(textarea.disabled).toBe(false));
  });

  it("falha mostra Repetir que reutiliza a mesma chave", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("rede em baixo"))
      .mockResolvedValueOnce(jsonResponse({ message: serverMessage(), replayed: false }, 201));
    const { textarea, onSent } = renderComposer();

    type("oi", textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(await screen.findByText("Falhou")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Repetir" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(headersOf(fetchMock.mock.calls[1])["idempotency-key"]).toBe(
      headersOf(fetchMock.mock.calls[0])["idempotency-key"],
    );
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(serverMessage()));
  });

  it("conflito mostra toast sem reenviar", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ title: "idempotency_conflict", detail: "chave repetida" }, 409),
    );
    const { textarea, onSent } = renderComposer();

    type("oi", textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });

    const alerta = await screen.findByRole("alert");
    expect(alerta).toHaveTextContent("nada foi reenviado");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSent).not.toHaveBeenCalled(); // sem reconciliação
  });
});
