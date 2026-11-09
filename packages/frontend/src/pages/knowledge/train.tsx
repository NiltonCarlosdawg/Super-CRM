// Treino (Fase 2, Tasks 4/5): upload de texto/markdown, passo-a-passo, rascunho
// editável, diff e publicação atómica. A extração é assíncrona (job), por isso
// o rascunho tem recarregamento manual e a publicação só existe depois de haver
// itens staged. Nada aqui decide conflitos: o servidor manda no diff.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../lib/api";
import {
  BUSINESS_LINES,
  diffLabel,
  diffTone,
  entityTypeLabel,
  fileToBase64,
  mediaTypeFor,
} from "../../lib/knowledge";
import type {
  BusinessLineSlug,
  DraftDiff,
  DraftItem,
  ValidateResult,
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

interface Pair {
  question: string;
  answer: string;
}

export function TrainTab() {
  const { show, error: toastError } = useToast();
  const [items, setItems] = useState<DraftItem[] | null>(null);
  const [diff, setDiff] = useState<DraftDiff | null>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [uploadLine, setUploadLine] = useState<BusinessLineSlug | "">("");
  const [uploading, setUploading] = useState(false);

  const [guidedLine, setGuidedLine] = useState<BusinessLineSlug>("software");
  const [pairs, setPairs] = useState<Pair[]>([{ question: "", answer: "" }]);

  const [editing, setEditing] = useState<DraftItem | null>(null);
  const [payloadText, setPayloadText] = useState("");
  const [editLine, setEditLine] = useState<BusinessLineSlug | "">("");
  const [confirmLine, setConfirmLine] = useState(false);

  const load = useCallback(() => {
    return Promise.all([
      api.get<{ items: DraftItem[] }>("/v1/knowledge/train/draft").then((r) => setItems(r.items)),
      api.get<DraftDiff>("/v1/knowledge/train/diff").then(setDiff),
    ]).catch((error: unknown) => toastError(errorText(error)));
  }, [toastError]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (event: FormEvent) => {
    event.preventDefault();
    if (files.length === 0) return;
    setUploading(true);
    try {
      const documents = [];
      for (const file of files) {
        const mediaType = mediaTypeFor(file);
        if (mediaType === null) {
          toastError(`Formato não suportado: ${file.name} (só texto e markdown)`);
          return;
        }
        documents.push({
          filename: file.name,
          mediaType,
          contentBase64: await fileToBase64(file),
        });
      }
      await api.post("/v1/knowledge/train/documents", {
        documents,
        ...(uploadLine === "" ? {} : { lineSlug: uploadLine }),
      });
      setFiles([]);
      show("Documentos enviados — a extração corre em segundo plano");
      await load();
    } catch (error) {
      toastError(errorText(error));
    } finally {
      setUploading(false);
    }
  };

  const submitGuided = async (event: FormEvent) => {
    event.preventDefault();
    const answers = pairs
      .map((pair) => ({ question: pair.question.trim(), answer: pair.answer.trim() }))
      .filter((pair) => pair.question !== "" && pair.answer !== "");
    if (answers.length === 0) {
      toastError("Preenche pelo menos uma pergunta e resposta");
      return;
    }
    try {
      await api.post("/v1/knowledge/train/guided", { lineSlug: guidedLine, answers });
      setPairs([{ question: "", answer: "" }]);
      show("Passo-a-passo enviado — a extração corre em segundo plano");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const openEdit = (item: DraftItem) => {
    setEditing(item);
    setPayloadText(JSON.stringify(item.payload, null, 2));
    setEditLine((item.lineSlug as BusinessLineSlug | null) ?? "");
    setConfirmLine(item.lineConfirmed);
  };

  const saveEdit = async () => {
    if (editing === null) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadText) as Record<string, unknown>;
    } catch {
      toastError("O payload não é JSON válido");
      return;
    }
    try {
      await api.patch(`/v1/knowledge/train/draft/${editing.id}`, {
        payload,
        ...(editLine === "" ? {} : { lineSlug: editLine }),
        ...(confirmLine ? { confirmLine: true } : {}),
      });
      setEditing(null);
      show("Rascunho actualizado");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const remove = async (item: DraftItem) => {
    try {
      await api.del(`/v1/knowledge/train/draft/${item.id}`);
      show("Item removido do rascunho");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const publish = async (acceptConflicts?: string[]) => {
    try {
      const result = await api.post<ValidateResult>("/v1/knowledge/train/validate", {
        ...(acceptConflicts === undefined ? {} : { acceptConflicts }),
      });
      show(
        `Publicado · ${result.applied.added} novos, ${result.applied.updated} actualizados, ${result.applied.archived} removidos`,
      );
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const conflicts = (diff?.entries ?? []).filter((entry) => entry.classification === "conflict");
  const unconfirmed = diff?.unconfirmedSlugs ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4 p-6">
        <h2 className="font-display text-lg text-fg">Carregar documentos</h2>
        <form onSubmit={(event) => void upload(event)} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="train-files" className="text-sm text-muted">
              Ficheiros (texto ou markdown, até 10)
            </label>
            <input
              id="train-files"
              type="file"
              multiple
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
              className="text-sm text-fg"
            />
          </div>
          <label htmlFor="train-line" className="text-sm text-muted">
            Linha de negócio
          </label>
          <select
            id="train-line"
            value={uploadLine}
            onChange={(event) => setUploadLine(event.target.value as BusinessLineSlug | "")}
            className="border border-border bg-background px-3 py-2 text-fg"
          >
            <option value="">Detectar automaticamente</option>
            {BUSINESS_LINES.map((line) => (
              <option key={line.slug} value={line.slug}>
                {line.label}
              </option>
            ))}
          </select>
          <div>
            <Button type="submit" variant="solid" disabled={files.length === 0 || uploading}>
              {uploading ? "A enviar…" : "Enviar"}
            </Button>
          </div>
        </form>
      </Card>

      <Card className="flex flex-col gap-4 p-6">
        <h2 className="font-display text-lg text-fg">Passo a passo</h2>
        <form onSubmit={(event) => void submitGuided(event)} className="flex flex-col gap-3">
          <label htmlFor="guided-line" className="text-sm text-muted">
            Linha de negócio
          </label>
          <select
            id="guided-line"
            value={guidedLine}
            onChange={(event) => setGuidedLine(event.target.value as BusinessLineSlug)}
            className="border border-border bg-background px-3 py-2 text-fg"
          >
            {BUSINESS_LINES.map((line) => (
              <option key={line.slug} value={line.slug}>
                {line.label}
              </option>
            ))}
          </select>
          {pairs.map((pair, index) => (
            <div key={index} className="flex flex-col gap-2 border border-border p-3">
              <Field
                label={`Pergunta ${index + 1}`}
                value={pair.question}
                onChange={(event) =>
                  setPairs((prev) =>
                    prev.map((row, i) =>
                      i === index ? { ...row, question: event.target.value } : row,
                    ),
                  )
                }
              />
              <label htmlFor={`guided-answer-${index}`} className="text-sm text-muted">
                Resposta {index + 1}
              </label>
              <textarea
                id={`guided-answer-${index}`}
                rows={3}
                value={pair.answer}
                onChange={(event) =>
                  setPairs((prev) =>
                    prev.map((row, i) =>
                      i === index ? { ...row, answer: event.target.value } : row,
                    ),
                  )
                }
                className="border border-border bg-background px-3 py-2 text-sm text-fg"
              />
            </div>
          ))}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setPairs((prev) => [...prev, { question: "", answer: "" }])}
            >
              Mais uma pergunta
            </Button>
            <Button type="submit" variant="solid">
              Enviar passo-a-passo
            </Button>
          </div>
        </form>
      </Card>

      <Card className="flex flex-col gap-4 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg text-fg">Rascunho</h2>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => void load()}>
              Recarregar
            </Button>
            <Button
              variant="solid"
              disabled={(items ?? []).length === 0}
              onClick={() => void publish()}
            >
              Publicar
            </Button>
            {conflicts.length > 0 && (
              <Button
                variant="outline"
                onClick={() => void publish(conflicts.map((entry) => entry.slug))}
              >
                Publicar aceitando {conflicts.length} conflito(s)
              </Button>
            )}
          </div>
        </div>

        {unconfirmed.length > 0 && (
          <p className="text-sm text-warning">
            {unconfirmed.length} item(ns) sem linha confirmada — confirma a linha antes de publicar.
          </p>
        )}

        {items === null ? (
          <Spinner label="A carregar rascunho" />
        ) : items.length === 0 ? (
          <EmptyState
            title="Rascunho vazio"
            description="Envia um documento ou um passo-a-passo. A extração preenche esta lista."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-start justify-between gap-3 border border-border bg-background px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-fg">{item.slug}</span>
                    <Badge tone="neutral">{entityTypeLabel(item.entityType)}</Badge>
                    <Badge tone={item.lineConfirmed ? "info" : "warning"}>
                      {item.lineSlug ?? "sem linha"}
                    </Badge>
                    {item.baseVersion !== null && (
                      <span className="text-xs text-muted">base v{item.baseVersion}</span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted">
                    {JSON.stringify(item.payload)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => openEdit(item)}>
                    Editar
                  </Button>
                  <Button variant="ghost" onClick={() => void remove(item)}>
                    Remover
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {diff !== null && diff.entries.length > 0 && (
        <Card className="flex flex-col gap-3 p-6">
          <h2 className="font-display text-lg text-fg">Diferenças a publicar</h2>
          <div className="flex flex-col gap-1">
            {diff.entries.map((entry) => (
              <div
                key={`${entry.entityType}:${entry.slug}`}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 text-sm"
              >
                <span className="text-fg">{entry.slug}</span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {entityTypeLabel(entry.entityType)}
                  {entry.currentVersion !== null && ` · v${entry.currentVersion}`}
                  {entry.baseVersion !== null && ` ← v${entry.baseVersion}`}
                  <Badge tone={diffTone(entry.classification)}>
                    {diffLabel(entry.classification)}
                  </Badge>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal open={editing !== null} title="Editar item do rascunho" onClose={() => setEditing(null)}>
        <div className="flex flex-col gap-3">
          <label htmlFor="draft-payload" className="text-sm text-muted">
            Payload (JSON — o servidor valida por tipo)
          </label>
          <textarea
            id="draft-payload"
            rows={12}
            value={payloadText}
            onChange={(event) => setPayloadText(event.target.value)}
            className="border border-border bg-background px-3 py-2 font-mono text-xs text-fg"
          />
          <label htmlFor="draft-line" className="text-sm text-muted">
            Linha de negócio
          </label>
          <select
            id="draft-line"
            value={editLine}
            onChange={(event) => setEditLine(event.target.value as BusinessLineSlug | "")}
            className="border border-border bg-background px-3 py-2 text-fg"
          >
            <option value="">Sem linha (só documentos)</option>
            {BUSINESS_LINES.map((line) => (
              <option key={line.slug} value={line.slug}>
                {line.label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={confirmLine}
              onChange={(event) => setConfirmLine(event.target.checked)}
            />
            Linha confirmada
          </label>
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
