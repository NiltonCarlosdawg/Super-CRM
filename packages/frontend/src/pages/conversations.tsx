// Conversas em duas colunas (Tasks 8+9): fila à esquerda com cursor que anexa,
// thread à direita com mensagens, tempo real e banner de handoff. /conversations
// e /conversations/:id servem do mesmo ficheiro (a thread monta com key=id —
// trocar de conversa = estado novo, sem resets manuais).
//
// Tempo real (docs/02 §9): o payload message.created NÃO traz body — a bolha
// nasce como placeholder e a thread recupera o estado por REST (janela mais
// recente, merge por id). message.status actualiza por messageId; handoff.*
// pinta o banner. applyThreadEvent é puro e cobre os quatro.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import {
  aiModeLabel,
  composerSendingLabel,
  handoffPriorityLabel,
  messageStatusLabel,
} from "../lib/labels";
import { relativeTime } from "../lib/time";
import { useEvent, type PanelEventPayloads } from "../lib/socket";
import type {
  AiMode,
  ConversationDetail,
  ConversationView,
  ConversationsList,
  Draft,
  DraftsList,
  MessageView,
  MessagesList,
  SendMessageResponse,
} from "../lib/types";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";

const PAGE_SIZE = 20;
const MESSAGE_PAGE_SIZE = 20;

/** Humano a decidir merece destaque (handoff); activa é só informativo. */
export function aiModeTone(mode: AiMode): BadgeTone {
  switch (mode) {
    case "ai_active":
      return "info";
    case "ai_suggest":
      return "neutral";
    case "human_only":
      return "warning";
  }
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? "Erro ao comunicar com o servidor";
  return "Erro inesperado";
}

/* ------------------------------- Thread --------------------------------- */

export interface HandoffBanner {
  handoffId: string;
  priority: "urgent" | "high" | "normal";
  reason: string | null;
}

export interface ThreadState {
  conversationId: string;
  /** Ordem cronológica (a API devolve DESC — inverter ao carregar). */
  messages: MessageView[];
  handoff: HandoffBanner | null;
}

export type ThreadEvent =
  | { name: "message.created"; payload: PanelEventPayloads["message.created"] }
  | { name: "message.status"; payload: PanelEventPayloads["message.status"] }
  | { name: "handoff.created"; payload: PanelEventPayloads["handoff.created"] }
  | { name: "handoff.updated"; payload: PanelEventPayloads["handoff.updated"] };

/** customer ⇒ inbound; os restantes emissores são sempre outbound (backend). */
function placeholderFrom(payload: PanelEventPayloads["message.created"]): MessageView {
  return {
    id: payload.messageId,
    conversationId: payload.conversationId,
    direction: payload.sender === "customer" ? "inbound" : "outbound",
    sender: payload.sender,
    kind: "text",
    body: "", // o evento não traz corpo (docs/02 §9) — materializa por REST
    status: payload.status,
    mediaRef: null,
    createdAt: payload.createdAt,
  };
}

/**
 * Transição pura de thread para um evento realtime. Eventos de OUTRA conversa
 * devolvem o mesmo estado; message.created anexa placeholder idempotente;
 * message.status só actualiza mensagens já conhecidas (as de fora recuperam-se
 * por REST); handoff.* substitui o banner.
 */
export function applyThreadEvent(thread: ThreadState, event: ThreadEvent): ThreadState {
  const { payload } = event;
  if (payload.v !== 1 || payload.conversationId !== thread.conversationId) return thread;

  switch (event.name) {
    case "message.created": {
      const created = event.payload;
      if (thread.messages.some((message) => message.id === created.messageId)) return thread;
      return { ...thread, messages: [...thread.messages, placeholderFrom(created)] };
    }
    case "message.status": {
      const status = event.payload;
      const index = thread.messages.findIndex((message) => message.id === status.messageId);
      if (index === -1) return thread;
      const messages = [...thread.messages];
      messages[index] = { ...messages[index], status: status.status };
      return { ...thread, messages };
    }
    case "handoff.created":
    case "handoff.updated": {
      const handoff = event.payload;
      return {
        ...thread,
        handoff: {
          handoffId: handoff.handoffId,
          priority: handoff.priority,
          reason: handoff.reason ?? null,
        },
      };
    }
  }
}

/** Janela DESC da API → ordem cronológica; merge preserva o que já está carregado. */
function mergeWindow(previous: MessageView[], page: MessagesList): MessageView[] {
  const newest = [...page.messages].reverse();
  const ids = new Set(newest.map((message) => message.id));
  return [...previous.filter((message) => !ids.has(message.id)), ...newest];
}

function MessageBubble({ message }: { message: MessageView }) {
  const inbound = message.direction === "inbound";
  return (
    <div className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[75%] border px-3 py-2 text-sm ${
          inbound ? "border-border bg-surface" : "border-accent/30 bg-accent/10"
        }`}
      >
        <p className="whitespace-pre-wrap break-words text-fg">
          {message.body === "" ? "…" : message.body}
        </p>
        <div className="mt-1 flex justify-between gap-3 text-xs text-muted">
          <span>{relativeTime(message.createdAt)}</span>
          {!inbound && <span>{messageStatusLabel(message.status)}</span>}
        </div>
      </div>
    </div>
  );
}

function Thread({ conversationId }: { conversationId: string }) {
  const { show, error: toastError } = useToast();
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [thread, setThread] = useState<ThreadState>({
    conversationId,
    messages: [],
    handoff: null,
  });
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [rejectTarget, setRejectTarget] = useState<Draft | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const scrollerRef = useRef<HTMLDivElement>(null);

  const messagesPath = `/v1/conversations/${conversationId}/messages`;
  const draftsPath = `/v1/conversations/${conversationId}/drafts`;

  const loadDrafts = useCallback(() => {
    return api
      .get<DraftsList>(draftsPath)
      .then((result) => setDrafts(result.drafts ?? []))
      .catch((error: unknown) => toastError(errorText(error)));
  }, [draftsPath, toastError]);

  useEffect(() => {
    void loadDrafts();
  }, [loadDrafts]);

  // Abertura: detalhe + janela inicial (promessas em paralelo; erro ⇒ toast + estado).
  useEffect(() => {
    Promise.all([
      api
        .get<ConversationDetail>(`/v1/conversations/${conversationId}`)
        .then((detail) => setConversation(detail)),
      api
        .get<MessagesList>(messagesPath, { limit: String(MESSAGE_PAGE_SIZE) })
        .then((page) => {
          setThread((prev) => ({ ...prev, messages: mergeWindow(prev.messages, page) }));
          setOlderCursor(page.nextCursor);
        }),
    ])
      .catch((error: unknown) => toastError(errorText(error)))
      .finally(() => setReady(true));
  }, [conversationId, messagesPath, toastError]);

  // Recuperação de estado a cada message.created (docs/02 §9: REST, não o socket).
  const refreshNewest = useCallback(() => {
    api
      .get<MessagesList>(messagesPath, { limit: String(MESSAGE_PAGE_SIZE) })
      .then((page) => setThread((prev) => ({ ...prev, messages: mergeWindow(prev.messages, page) })))
      .catch((error: unknown) => toastError(errorText(error)));
  }, [messagesPath, toastError]);

  // Envio confirmado pelo POST (REST, não depende do socket): anexa/substitui por id.
  const absorbSent = useCallback((message: MessageView) => {
    setThread((prev) => applySentMessage(prev, message));
  }, []);

  // Rascunhos da IA (Fase 3): aprovar enfileira na outbox; rejeitar só audita.
  const approveDraft = async (draft: Draft) => {
    try {
      await api.post(`/v1/drafts/${draft.id}/approve`, {});
      await loadDrafts();
      show("Rascunho aprovado");
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const rejectDraft = async () => {
    if (rejectTarget === null || rejectReason.trim() === "") return;
    try {
      await api.post(`/v1/drafts/${rejectTarget.id}/reject`, {
        reason: rejectReason.trim(),
      });
      setRejectTarget(null);
      setRejectReason("");
      await loadDrafts();
      show("Rascunho rejeitado");
    } catch (error) {
      toastError(errorText(error));
    }
  };

  /** Devolve a conversa à IA (só quando está em human_only). */
  const returnToAi = async () => {
    try {
      const result = await api.post<{ aiMode: AiMode }>(
        `/v1/conversations/${conversationId}/return-to-ai`,
        {},
      );
      setConversation((prev) =>
        prev === null
          ? prev
          : { ...prev, conversation: { ...prev.conversation, aiMode: result.aiMode } },
      );
      show("Conversa devolvida à IA");
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const loadOlder = useCallback(() => {
    if (olderCursor === null) return;
    setLoadingOlder(true);
    api
      .get<MessagesList>(messagesPath, {
        limit: String(MESSAGE_PAGE_SIZE),
        cursor: olderCursor,
      })
      .then((page) => {
        setThread((prev) => {
          const older = [...page.messages].reverse();
          const known = new Set(prev.messages.map((message) => message.id));
          return { ...prev, messages: [...older.filter((m) => !known.has(m.id)), ...prev.messages] };
        });
        setOlderCursor(page.nextCursor);
      })
      .catch((error: unknown) => toastError(errorText(error)))
      .finally(() => setLoadingOlder(false));
  }, [messagesPath, olderCursor, toastError]);

  useEvent("message.created", (payload) => {
    setThread((prev) => applyThreadEvent(prev, { name: "message.created", payload }));
    refreshNewest();
  });
  useEvent("message.status", (payload) =>
    setThread((prev) => applyThreadEvent(prev, { name: "message.status", payload })),
  );
  useEvent("handoff.created", (payload) =>
    setThread((prev) => applyThreadEvent(prev, { name: "handoff.created", payload })),
  );
  useEvent("handoff.updated", (payload) =>
    setThread((prev) => applyThreadEvent(prev, { name: "handoff.updated", payload })),
  );

  // Scroll preso ao fundo quando a conversa cresce (mensagem nova).
  useEffect(() => {
    const element = scrollerRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [thread.messages.length]);

  if (!ready) return <Spinner label="A abrir conversa" />;
  if (conversation === null) {
    return (
      <div className="flex flex-1 items-start justify-center p-6">
        <EmptyState
          title="Não foi possível abrir a conversa"
          description="Volta à lista e tenta de novo."
        />
      </div>
    );
  }

  const { contactPhone, aiMode } = conversation.conversation;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-lg text-fg">{contactPhone}</h2>
          <Badge tone={aiModeTone(aiMode)}>{aiModeLabel(aiMode)}</Badge>
        </div>
        {aiMode === "human_only" && (
          <Button variant="outline" onClick={() => void returnToAi()}>
            Devolver à IA
          </Button>
        )}
      </div>

      {thread.handoff !== null && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-accent/10 px-6 py-2 text-sm"
        >
          <Badge tone="warning">{handoffPriorityLabel(thread.handoff.priority)}</Badge>
          <span className="text-fg">Handoff para humano</span>
          {thread.handoff.reason !== null && (
            <span className="text-muted">— {thread.handoff.reason}</span>
          )}
        </div>
      )}

      {olderCursor !== null && (
        <div className="border-b border-border px-6 py-2">
          <Button variant="ghost" disabled={loadingOlder} onClick={loadOlder}>
            {loadingOlder ? "A carregar…" : "Ver mensagens anteriores"}
          </Button>
        </div>
      )}

      {drafts.some((draft) => draft.status === "pending") && (
        <div className="flex flex-col gap-2 border-b border-border bg-surface px-6 py-3">
          <span className="text-xs uppercase text-muted">Rascunhos da IA</span>
          {drafts
            .filter((draft) => draft.status === "pending")
            .map((draft) => (
              <div
                key={draft.id}
                className="flex flex-wrap items-start justify-between gap-3 border border-border bg-background px-3 py-2"
              >
                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-fg">
                  {draft.text}
                </p>
                <span className="flex gap-2">
                  <Button
                    variant="solid"
                    className="px-2 py-1 text-xs"
                    onClick={() => void approveDraft(draft)}
                  >
                    Aprovar
                  </Button>
                  <Button
                    variant="outline"
                    className="px-2 py-1 text-xs"
                    onClick={() => setRejectTarget(draft)}
                  >
                    Rejeitar
                  </Button>
                </span>
              </div>
            ))}
        </div>
      )}

      <div ref={scrollerRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
        {thread.messages.length === 0 ? (
          <EmptyState title="Sem mensagens ainda" description="As mensagens desta conversa aparecem aqui." />
        ) : (
          thread.messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
      </div>

      <Composer conversationId={conversationId} onSent={absorbSent} />

      <Modal
        open={rejectTarget !== null}
        title="Rejeitar rascunho"
        onClose={() => {
          setRejectTarget(null);
          setRejectReason("");
        }}
      >
        <div className="flex flex-col gap-3">
          <p className="whitespace-pre-wrap text-sm text-muted">{rejectTarget?.text}</p>
          <label htmlFor="reject-reason" className="text-sm text-muted">
            Motivo (fica no registo de auditoria)
          </label>
          <textarea
            id="reject-reason"
            rows={3}
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            className="border border-border bg-background px-3 py-2 text-sm text-fg"
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setRejectTarget(null);
                setRejectReason("");
              }}
            >
              Cancelar
            </Button>
            <Button
              variant="solid"
              disabled={rejectReason.trim() === ""}
              onClick={() => void rejectDraft()}
            >
              Rejeitar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* ----------------------------- Composer ---------------------------------- */

export interface ComposerMsg {
  /** Idempotency-Key: gerada UMA vez por mensagem lógica, reutilizada no retry. */
  key: string;
  text: string;
  status: "queued" | "sent" | "failed" | "conflict";
  /** Reconciliação: a mensagem que o servidor confirmou (sucesso/replayed). */
  message: MessageView | null;
  detail: string | null;
}

export interface ComposerDeps {
  uuid(): string;
  post(
    path: string,
    body: unknown,
    opts: { idempotencyKey: string },
  ): Promise<SendMessageResponse>;
}

export interface ComposerController {
  send(text: string): Promise<ComposerMsg>;
  /** Reenvio da MESMA mensagem lógica (mesma chave). Só quando falhou. */
  retry(): Promise<ComposerMsg | null>;
}

/**
 * Controller puro do envio (contrato: routes/conversations.ts:53-72). A chave
 * nasce no `send` e o `retry` reutiliza-a — a rede pode ter gravado o envio
 * mesmo tendo falhado a resposta, e o replay devolve a mensagem existente.
 * Conflito (409) é terminal: reenviar a mesma chave com o mesmo corpo nunca
 * produz 409, por isso o retry recusa e a interface só avisa.
 */
export function createComposer(
  deps: ComposerDeps,
  options: { conversationId: string; onState(state: ComposerMsg): void },
): ComposerController {
  let state: ComposerMsg | null = null;

  function setState(next: ComposerMsg): ComposerMsg {
    state = next;
    options.onState(next);
    return next;
  }

  async function attempt(msg: ComposerMsg): Promise<ComposerMsg> {
    try {
      const result = await deps.post(
        `/v1/conversations/${options.conversationId}/messages`,
        { text: msg.text },
        { idempotencyKey: msg.key },
      );
      return setState({ ...msg, status: "sent", message: result.message, detail: null });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        return setState({ ...msg, status: "conflict", detail: error.detail ?? null });
      }
      const detail = error instanceof ApiError ? (error.detail ?? null) : null;
      return setState({ ...msg, status: "failed", detail });
    }
  }

  return {
    send(text: string): Promise<ComposerMsg> {
      if (state !== null && state.status === "queued") {
        return Promise.resolve(state); // envio duplo: ignora, não gera chave nova
      }
      return attempt(
        setState({ key: deps.uuid(), text, status: "queued", message: null, detail: null }),
      );
    },
    retry(): Promise<ComposerMsg | null> {
      if (state === null || state.status !== "failed") return Promise.resolve(state);
      return attempt(state); // mesma chave, mesmo corpo
    },
  };
}

/** Reconcilia a mensagem confirmada pelo servidor na thread (por id). */
export function applySentMessage(thread: ThreadState, message: MessageView): ThreadState {
  const index = thread.messages.findIndex((existing) => existing.id === message.id);
  if (index === -1) return { ...thread, messages: [...thread.messages, message] };
  const messages = [...thread.messages];
  messages[index] = message;
  return { ...thread, messages };
}

export function Composer({
  conversationId,
  onSent,
}: {
  conversationId: string;
  onSent(message: MessageView): void;
}) {
  const { error: toastError } = useToast();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<ComposerMsg | null>(null);
  const composer = useMemo(
    () =>
      createComposer(
        {
          uuid: () => crypto.randomUUID(),
          post: (path, body, opts) => api.post(path, body, opts),
        },
        { conversationId, onState: setPending },
      ),
    [conversationId],
  );

  const settle = (result: ComposerMsg) => {
    if (result.status === "sent" && result.message !== null) {
      onSent(result.message); // a thread já tem a mensagem — o optimista desaparece
      setPending(null);
    } else if (result.status === "conflict") {
      toastError("Esta mensagem já foi enviada — nada foi reenviado.");
      setPending(null);
    }
  };

  const enviar = () => {
    const value = text.trim();
    if (value === "" || pending?.status === "queued") return;
    setText("");
    void composer.send(value).then(settle);
  };

  const repetir = () => {
    void composer.retry().then((result) => {
      if (result !== null) settle(result);
    });
  };

  return (
    <div className="flex flex-col gap-3 border-t border-border p-4">
      {pending !== null && pending.status !== "sent" && (
        <div className="flex justify-end">
          <div className="max-w-[75%] border border-accent/30 bg-accent/10 px-3 py-2 text-sm">
            <p className="whitespace-pre-wrap break-words text-fg">{pending.text}</p>
            <div className="mt-1 flex items-center gap-2 text-xs">
              {pending.status === "queued" && (
                <span className="text-muted">{composerSendingLabel()}</span>
              )}
              {pending.status === "failed" && (
                <>
                  <span className="text-warning">Falhou</span>
                  {pending.detail !== null && (
                    <span className="text-muted">— {pending.detail}</span>
                  )}
                  <Button variant="ghost" className="px-2 py-0.5" onClick={repetir}>
                    Repetir
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          enviar();
        }}
      >
        <textarea
          aria-label="Mensagem"
          rows={2}
          value={text}
          disabled={pending?.status === "queued"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault(); // Enter envia; Shift+Enter deixa a quebra linha
              enviar();
            }
          }}
          placeholder="Escreve uma mensagem…"
          className="min-h-[2.75rem] flex-1 resize-none border border-border bg-background px-3 py-2 text-sm text-fg placeholder:text-muted/60 focus:border-accent focus:outline-none"
        />
        <Button
          type="submit"
          variant="solid"
          disabled={pending?.status === "queued" || text.trim() === ""}
        >
          Enviar
        </Button>
      </form>
    </div>
  );
}

/* --------------------------- Fila + página ------------------------------ */

/**
 * Fila com cursor: a primeira página substitui, as seguintes anexam.
 * `hasMore` vem do nextCursor do backend — nunca se adivinha o fim.
 */
export function useConversations(): {
  items: ConversationView[];
  loadMore: () => void;
  loading: boolean;
  hasMore: boolean;
} {
  const { error: toastError } = useToast();
  const [items, setItems] = useState<ConversationView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPage = useCallback(
    (cursor: string | null, append: boolean) => {
      api
        .get<ConversationsList>("/v1/conversations", {
          limit: String(PAGE_SIZE),
          ...(cursor !== null ? { cursor } : {}),
        })
        .then((page) => {
          setItems((prev) => (append ? [...prev, ...page.conversations] : page.conversations));
          setNextCursor(page.nextCursor);
        })
        .catch((error: unknown) => {
          toastError(errorText(error));
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [toastError],
  );

  useEffect(() => {
    fetchPage(null, false); // o loading já nasce true — primeira página
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (nextCursor !== null && !loading) {
      setLoading(true);
      fetchPage(nextCursor, true);
    }
  }, [fetchPage, nextCursor, loading]);

  return { items, loadMore, loading, hasMore: nextCursor !== null };
}

export default function ConversationsPage() {
  const { id } = useParams();
  const { items, loadMore, loading, hasMore } = useConversations();

  return (
    <div className="flex h-[calc(100vh-7rem)]">
      <aside
        aria-label="Fila de conversas"
        className="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface"
      >
        <div className="border-b border-border px-4 py-3">
          <h1 className="font-display text-lg font-light text-fg">Conversas</h1>
          <p className="mt-0.5 text-xs text-muted">Últimas mensagens primeiro</p>
        </div>

        {loading && items.length === 0 ? (
          <Spinner label="A carregar conversas" />
        ) : items.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="Sem conversas ainda"
              description="Assim que chegarem mensagens, aparecem aqui."
            />
          </div>
        ) : (
          <div className="flex flex-col">
            {items.map((item) => (
              <Link
                key={item.id}
                to={`/conversations/${item.id}`}
                className={`flex items-start justify-between gap-2 border-b border-border px-4 py-3 transition-colors ${
                  item.id === id ? "bg-accent-soft" : "hover:bg-accent-soft/50"
                }`}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm text-fg">{item.contactPhone}</span>
                  <span className="text-xs text-muted">
                    {item.lastMessageAt === null ? "—" : relativeTime(item.lastMessageAt)}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <Badge tone={aiModeTone(item.aiMode)}>{aiModeLabel(item.aiMode)}</Badge>
                  {item.missStreak >= 3 && (
                    <Badge tone="warning">IA falhou {item.missStreak} vezes seguidas</Badge>
                  )}
                </span>
              </Link>
            ))}
            {hasMore && (
              <div className="p-3">
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={loading}
                  onClick={loadMore}
                >
                  {loading ? "A carregar…" : "Carregar mais"}
                </Button>
              </div>
            )}
          </div>
        )}
      </aside>

      <section className="flex min-h-0 flex-1 flex-col">
        {id === undefined ? (
          <div className="flex flex-1 items-start justify-center p-6">
            <EmptyState
              title="Seleciona uma conversa"
              description="Escolhe um contacto à esquerda para ver o histórico."
            />
          </div>
        ) : (
          <Thread key={id} conversationId={id} />
        )}
      </section>
    </div>
  );
}
