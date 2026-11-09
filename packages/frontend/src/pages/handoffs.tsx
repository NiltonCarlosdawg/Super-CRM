// Fila de handoffs (Fase 3): pendentes por prioridade, resumo da IA, aceitar
// (claim atómico; 409 = outro colega chegou primeiro → recarrega), resolver e
// abrir a conversa. O tempo real (handoff.created/updated) recarrega a fila.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { handoffPriorityLabel, handoffStatusLabel } from "../lib/labels";
import { useEvent } from "../lib/socket";
import { relativeTime } from "../lib/time";
import type { HandoffList, HandoffRow } from "../lib/types";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";

const PRIORITY_ORDER: Record<HandoffRow["priority"], number> = {
  urgent: 0,
  high: 1,
  normal: 2,
};

export function priorityTone(priority: HandoffRow["priority"]): BadgeTone {
  switch (priority) {
    case "urgent":
      return "danger";
    case "high":
      return "warning";
    case "normal":
      return "neutral";
  }
}

/** Estável: prioridade primeiro, depois a mais antiga. */
export function sortHandoffs(items: HandoffRow[]): HandoffRow[] {
  return [...items].sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? "Erro ao comunicar com o servidor";
  return "Erro inesperado";
}

export default function HandoffsPage() {
  const { show, error: toastError } = useToast();
  const [items, setItems] = useState<HandoffRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HandoffRow | null>(null);

  const load = useCallback(() => {
    return api
      .get<HandoffList>("/v1/handoffs", { status: "pending", limit: "50" })
      .then((result) => {
        setItems(sortHandoffs(result.handoffs));
        setSelectedId((current) =>
          current !== null && result.handoffs.some((row) => row.id === current) ? current : null,
        );
      })
      .catch((error: unknown) => toastError(errorText(error)));
  }, [toastError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selectedId === null) return;
    let active = true;
    api
      .get<{ handoff: HandoffRow }>(`/v1/handoffs/${selectedId}`)
      .then((result) => {
        if (active) setDetail(result.handoff);
      })
      .catch((error: unknown) => toastError(errorText(error)));
    return () => {
      active = false;
    };
  }, [selectedId, toastError]);

  // Um handoff novo ou mudado invalida a fila (o payload não traz o resumo).
  useEvent("handoff.created", () => void load());
  useEvent("handoff.updated", () => void load());

  const act = async (id: string, action: "accept" | "resolve") => {
    try {
      await api.post(`/v1/handoffs/${id}/${action}`, {});
      setSelectedId(null);
      await load();
      show(action === "accept" ? "Handoff aceite" : "Handoff resolvido");
    } catch (error) {
      toastError(errorText(error));
      // 409 handoff_taken: a fila mudou por baixo — mostra o estado real.
      await load();
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl font-light text-fg">Handoffs</h1>
        <p className="mt-1 text-sm text-muted">
          Conversas que a IA passou a um humano. O primeiro a aceitar fica com elas.
        </p>
      </div>

      {items === null ? (
        <Spinner label="A carregar handoffs" />
      ) : items.length === 0 ? (
        <EmptyState
          title="Sem handoffs pendentes"
          description="Quando a IA precisar de um humano, a conversa aparece aqui."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => setSelectedId(row.id === selectedId ? null : row.id)}
              className={`flex w-full items-center justify-between gap-4 border bg-surface px-4 py-3 text-left transition-colors ${
                row.id === selectedId ? "border-accent" : "border-border hover:border-accent/50"
              }`}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm text-fg">{row.summary}</span>
                <span className="truncate text-xs text-muted">
                  {row.reason} · {relativeTime(row.createdAt)}
                </span>
              </span>
              <Badge tone={priorityTone(row.priority)}>{handoffPriorityLabel(row.priority)}</Badge>
            </button>
          ))}
        </div>
      )}

      {detail !== null && detail.id === selectedId && (
        <Card className="flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h2 className="font-display text-lg text-fg">Handoff</h2>
              <Badge tone={priorityTone(detail.priority)}>
                {handoffPriorityLabel(detail.priority)}
              </Badge>
              <Badge tone="neutral">{handoffStatusLabel(detail.status)}</Badge>
            </div>
            <Link
              to={`/conversations/${detail.conversationId}`}
              className="text-sm text-accent hover:underline"
            >
              Abrir conversa
            </Link>
          </div>
          <p className="whitespace-pre-wrap text-sm text-fg">{detail.summary}</p>
          <p className="text-sm text-muted">Motivo: {detail.reason}</p>
          <p className="text-xs text-muted">
            Entrou {relativeTime(detail.createdAt)}
            {detail.slaAlertedAt !== null ? " · SLA alertado" : ""}
          </p>
          {detail.status === "pending" && (
            <div className="flex gap-2">
              <Button variant="solid" onClick={() => void act(detail.id, "accept")}>
                Aceitar
              </Button>
              <Button variant="outline" onClick={() => void act(detail.id, "resolve")}>
                Resolver
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
