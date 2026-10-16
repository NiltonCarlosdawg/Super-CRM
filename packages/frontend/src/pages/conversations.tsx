// Fila de conversas (Task 8): coluna escura com as conversas do backend
// (ordenadas por lastMessageAt desc), paginação por cursor que ANEXA páginas,
// linha activa destacada. /conversations/:id abre a thread (Task 9) no painel
// da direita — o mesmo ficheiro serve as duas rotas.

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { aiModeLabel } from "../lib/labels";
import { relativeTime } from "../lib/time";
import type { AiMode, ConversationView, ConversationsList } from "../lib/types";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";

const PAGE_SIZE = 20;

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
    <div className="flex min-h-full">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border bg-surface">
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

      <section className="flex flex-1 items-start justify-center p-6">
        {id === undefined ? (
          <EmptyState
            title="Seleciona uma conversa"
            description="Escolhe um contacto à esquerda para ver o histórico."
          />
        ) : (
          <EmptyState title="Conversa" description="A seguir" />
        )}
      </section>
    </div>
  );
}
