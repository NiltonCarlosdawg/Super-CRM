// Publicado (Fases 2–4): o que a IA pode servir agora. Edição rápida por tipo,
// histórico de publicações com reversão, revisões vencidas e reembed. As
// revisões e publicações são leituras; quem decide tudo é o servidor.

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { entityTypeLabel } from "../../lib/knowledge";
import { relativeTime } from "../../lib/time";
import type {
  DocType,
  PublishedItem,
  Publication,
  ReviewItem,
} from "../../lib/types";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? "Erro ao comunicar com o servidor";
  return "Erro inesperado";
}

const DOC_TYPES: Array<{ value: DocType; label: string }> = [
  { value: "faq", label: "FAQ" },
  { value: "policy", label: "Política" },
  { value: "process", label: "Processo" },
  { value: "company_info", label: "Empresa" },
  { value: "objection", label: "Objeção" },
];

export function PublishedTab() {
  const { show, error: toastError } = useToast();
  const [items, setItems] = useState<PublishedItem[] | null>(null);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);

  const [editing, setEditing] = useState<PublishedItem | null>(null);
  const [text, setText] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState("");
  const [number, setNumber] = useState("");

  const load = useCallback(() => {
    return Promise.all([
      api.get<{ items: PublishedItem[] }>("/v1/knowledge/published", { limit: "200" }).then((r) => setItems(r.items)),
      api.get<{ publications: Publication[] }>("/v1/knowledge/publications", { limit: "20" }).then((r) => setPublications(r.publications)),
      api.get<{ items: ReviewItem[] }>("/v1/knowledge/reviews", { limit: "50" }).then((r) => setReviews(r.items)),
    ]).catch((error: unknown) => toastError(errorText(error)));
  }, [toastError]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (item: PublishedItem) => {
    setEditing(item);
    setText(item.name ?? item.title ?? "");
    setBody("");
    setKind("");
    setNumber("");
  };

  const saveEdit = async () => {
    if (editing === null) return;
    const patch: Record<string, unknown> = {};
    if (editing.entityType === "catalog_item") {
      if (text.trim() !== "") patch.name = text.trim();
      if (body.trim() !== "") patch.summary = body.trim();
      if (number.trim() !== "") patch.priceAmount = Number(number);
      if (kind !== "") patch.availability = kind;
    } else if (editing.entityType === "knowledge_doc") {
      if (text.trim() !== "") patch.title = text.trim();
      if (body.trim() !== "") patch.body = body.trim();
      if (kind !== "") patch.type = kind;
    } else {
      if (text.trim() !== "") patch.title = text.trim();
      if (body.trim() !== "") patch.instruction = body.trim();
      if (number.trim() !== "") patch.priority = Number(number);
    }
    if (Object.keys(patch).length === 0) {
      toastError("Preenche pelo menos um campo para guardar");
      return;
    }
    try {
      await api.patch(`/v1/knowledge/items/${editing.id}`, {
        entityType: editing.entityType,
        patch,
      });
      setEditing(null);
      show("Item actualizado — a alteração ficou registada");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const revert = async (publication: Publication) => {
    try {
      await api.post("/v1/knowledge/published/revert", { publicationId: publication.id });
      show("Publicação revertida");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const markReviewed = async (item: ReviewItem) => {
    try {
      await api.post(`/v1/knowledge/reviews/${item.entityType}/${item.id}`, {});
      show("Revisão registada");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const reembed = async () => {
    try {
      await api.post("/v1/knowledge/reembed", {});
      show("Reembed em fila");
    } catch (error) {
      toastError(errorText(error));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg text-fg">Itens activos</h2>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => void load()}>
              Recarregar
            </Button>
            <Button variant="outline" onClick={() => void reembed()}>
              Recalcular embeddings
            </Button>
          </div>
        </div>
        {items === null ? (
          <Spinner label="A carregar itens publicados" />
        ) : items.length === 0 ? (
          <EmptyState
            title="Nada publicado"
            description="Publica um rascunho no separador Treino para a IA começar a responder."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((item) => (
              <div
                key={`${item.entityType}:${item.id}`}
                className="flex flex-wrap items-center justify-between gap-3 border border-border bg-background px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-fg">{item.name ?? item.title ?? item.slug}</span>
                    <Badge tone="neutral">{entityTypeLabel(item.entityType)}</Badge>
                    <span className="text-xs text-muted">{item.slug} · v{item.version}</span>
                  </div>
                  <p className="text-xs text-muted">actualizado {relativeTime(item.updatedAt)}</p>
                </div>
                <Button variant="outline" onClick={() => openEdit(item)}>
                  Editar
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-6">
        <h2 className="font-display text-lg text-fg">Revisões vencidas</h2>
        {reviews.length === 0 ? (
          <p className="text-sm text-muted">Nenhum item vencido.</p>
        ) : (
          reviews.map((item) => (
            <div
              key={`${item.entityType}:${item.id}`}
              className="flex flex-wrap items-center justify-between gap-3 border border-border bg-background px-3 py-2"
            >
              <span className="text-sm text-fg">
                {item.title}{" "}
                <span className="text-xs text-warning">
                  {item.daysOverdue} dia(s) em atraso
                </span>
              </span>
              <Button variant="outline" onClick={() => void markReviewed(item)}>
                Marcar revisto
              </Button>
            </div>
          ))
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-6">
        <h2 className="font-display text-lg text-fg">Publicações</h2>
        {publications.length === 0 ? (
          <p className="text-sm text-muted">Ainda não há publicações.</p>
        ) : (
          publications.map((publication) => (
            <div
              key={publication.id}
              className="flex flex-wrap items-center justify-between gap-3 border border-border bg-background px-3 py-2"
            >
              <span className="text-sm text-fg">
                {publication.kind} · {relativeTime(publication.createdAt)}
                <span className="ml-2 text-xs text-muted">
                  {JSON.stringify(publication.applied)}
                </span>
              </span>
              <Button variant="ghost" onClick={() => void revert(publication)}>
                Reverter
              </Button>
            </div>
          ))
        )}
      </Card>

      <Modal open={editing !== null} title="Edição rápida" onClose={() => setEditing(null)}>
        <div className="flex flex-col gap-3">
          <Field label="Título / nome" value={text} onChange={(e) => setText(e.target.value)} />
          <label htmlFor="quick-body" className="text-sm text-muted">
            {editing?.entityType === "catalog_item"
              ? "Resumo"
              : editing?.entityType === "rule"
                ? "Instrução"
                : "Corpo"}
          </label>
          <textarea
            id="quick-body"
            rows={5}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="border border-border bg-background px-3 py-2 text-sm text-fg"
          />
          {editing?.entityType === "catalog_item" && (
            <>
              <Field
                label="Preço (AOA; vazio mantém)"
                type="number"
                value={number}
                onChange={(event) => setNumber(event.target.value)}
              />
              <label htmlFor="quick-kind" className="text-sm text-muted">
                Disponibilidade
              </label>
              <select
                id="quick-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
                className="border border-border bg-background px-3 py-2 text-fg"
              >
                <option value="">— manter —</option>
                <option value="available">Disponível</option>
                <option value="limited">Limitado</option>
                <option value="unavailable">Indisponível</option>
              </select>
            </>
          )}
          {editing?.entityType === "knowledge_doc" && (
            <>
              <label htmlFor="quick-kind" className="text-sm text-muted">
                Tipo de documento
              </label>
              <select
                id="quick-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
                className="border border-border bg-background px-3 py-2 text-fg"
              >
                <option value="">— manter —</option>
                {DOC_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </>
          )}
          {editing?.entityType === "rule" && (
            <Field
              label="Prioridade (vazio mantém)"
              type="number"
              value={number}
              onChange={(event) => setNumber(event.target.value)}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button variant="solid" onClick={() => void saveEdit()}>
              Guardar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
