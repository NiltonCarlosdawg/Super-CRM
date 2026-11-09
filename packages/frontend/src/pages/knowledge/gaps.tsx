// Lacunas (Fase 2, Task 6): perguntas que a IA não soube responder e sugestões
// humanas para tapar o buraco. Aprovar uma sugestão só escreve no staging —
// continua a ser o Treino que publica.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../lib/api";
import { BUSINESS_LINES, docTypeLabel } from "../../lib/knowledge";
import { relativeTime } from "../../lib/time";
import type {
  BusinessLineSlug,
  DocType,
  KnowledgeGap,
  KnowledgeSuggestion,
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

const DOC_TYPES: DocType[] = ["faq", "policy", "process", "company_info", "objection"];

export function GapsTab() {
  const { show, error: toastError } = useToast();
  const [gaps, setGaps] = useState<KnowledgeGap[] | null>(null);
  const [suggestions, setSuggestions] = useState<KnowledgeSuggestion[]>([]);
  const [creating, setCreating] = useState(false);

  const [title, setTitle] = useState("");
  const [humanAnswer, setHumanAnswer] = useState("");
  const [proposedBody, setProposedBody] = useState("");
  const [docType, setDocType] = useState<DocType>("faq");
  const [line, setLine] = useState<BusinessLineSlug | "">("");

  const load = useCallback(() => {
    return Promise.all([
      api.get<{ items: KnowledgeGap[] }>("/v1/knowledge/gaps", { status: "open" }).then((r) => setGaps(r.items)),
      api.get<{ items: KnowledgeSuggestion[] }>("/v1/knowledge/suggestions", { status: "pending" }).then((r) => setSuggestions(r.items)),
    ]).catch((error: unknown) => toastError(errorText(error)));
  }, [toastError]);

  useEffect(() => {
    void load();
  }, [load]);

  const decideGap = async (gap: KnowledgeGap, action: "resolve" | "ignore") => {
    try {
      await api.post(`/v1/knowledge/gaps/${gap.id}/${action}`, {});
      show(action === "resolve" ? "Lacuna resolvida" : "Lacuna ignorada");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const decideSuggestion = async (suggestion: KnowledgeSuggestion, action: "approve" | "reject") => {
    try {
      await api.post(`/v1/knowledge/suggestions/${suggestion.id}/${action}`, {});
      show(action === "approve" ? "Sugestão aprovada e em staging" : "Sugestão rejeitada");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post("/v1/knowledge/suggestions", {
        humanAnswer: humanAnswer.trim(),
        proposedTitle: title.trim(),
        proposedBody: proposedBody.trim(),
        proposedDocType: docType,
        ...(line === "" ? {} : { proposedLineSlug: line }),
      });
      setCreating(false);
      setTitle("");
      setHumanAnswer("");
      setProposedBody("");
      setDocType("faq");
      setLine("");
      show("Sugestão criada");
      await load();
    } catch (error) {
      toastError(errorText(error));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-3 p-6">
        <h2 className="font-display text-lg text-fg">Lacunas abertas</h2>
        {gaps === null ? (
          <Spinner label="A carregar lacunas" />
        ) : gaps.length === 0 ? (
          <EmptyState title="Sem lacunas" description="A IA está a responder a tudo o que lhe perguntam." />
        ) : (
          gaps.map((gap) => (
            <div
              key={gap.id}
              className="flex flex-wrap items-center justify-between gap-3 border border-border bg-background px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-fg">{gap.question}</p>
                <p className="text-xs text-muted">
                  {gap.occurrences}× · última {relativeTime(gap.lastSeenAt)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="solid" onClick={() => void decideGap(gap, "resolve")}>
                  Resolver
                </Button>
                <Button variant="ghost" onClick={() => void decideGap(gap, "ignore")}>
                  Ignorar
                </Button>
              </div>
            </div>
          ))
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg text-fg">Sugestões pendentes</h2>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => void load()}>
              Recarregar
            </Button>
            <Button variant="solid" onClick={() => setCreating(true)}>
              Nova sugestão
            </Button>
          </div>
        </div>
        {suggestions.length === 0 ? (
          <EmptyState title="Sem sugestões" description="As sugestões aprovadas entram no rascunho de treino." />
        ) : (
          suggestions.map((suggestion) => (
            <div
              key={suggestion.id}
              className="flex flex-col gap-2 border border-border bg-background px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-fg">{suggestion.proposedTitle}</span>
                <Badge tone="neutral">{docTypeLabel(suggestion.proposedDocType ?? "faq")}</Badge>
                {suggestion.proposedLineSlug !== null && (
                  <Badge tone="info">{suggestion.proposedLineSlug}</Badge>
                )}
              </div>
              <p className="text-sm text-muted">{suggestion.humanAnswer}</p>
              <p className="whitespace-pre-wrap text-xs text-muted">{suggestion.proposedBody}</p>
              <div className="flex gap-2">
                <Button variant="solid" onClick={() => void decideSuggestion(suggestion, "approve")}>
                  Aprovar
                </Button>
                <Button variant="ghost" onClick={() => void decideSuggestion(suggestion, "reject")}>
                  Rejeitar
                </Button>
              </div>
            </div>
          ))
        )}
      </Card>

      <Modal open={creating} title="Nova sugestão" onClose={() => setCreating(false)}>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <Field label="Título" required value={title} onChange={(e) => setTitle(e.target.value)} />
          <Field
            label="Resposta humana"
            required
            value={humanAnswer}
            onChange={(e) => setHumanAnswer(e.target.value)}
          />
          <label htmlFor="suggestion-body" className="text-sm text-muted">
            Corpo proposto
          </label>
          <textarea
            id="suggestion-body"
            required
            rows={6}
            value={proposedBody}
            onChange={(event) => setProposedBody(event.target.value)}
            className="border border-border bg-background px-3 py-2 text-sm text-fg"
          />
          <label htmlFor="suggestion-type" className="text-sm text-muted">
            Tipo de documento
          </label>
          <select
            id="suggestion-type"
            value={docType}
            onChange={(event) => setDocType(event.target.value as DocType)}
            className="border border-border bg-background px-3 py-2 text-fg"
          >
            {DOC_TYPES.map((type) => (
              <option key={type} value={type}>
                {docTypeLabel(type)}
              </option>
            ))}
          </select>
          <label htmlFor="suggestion-line" className="text-sm text-muted">
            Linha (opcional)
          </label>
          <select
            id="suggestion-line"
            value={line}
            onChange={(event) => setLine(event.target.value as BusinessLineSlug | "")}
            className="border border-border bg-background px-3 py-2 text-fg"
          >
            <option value="">Sem linha</option>
            {BUSINESS_LINES.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.label}
              </option>
            ))}
          </select>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="solid">
              Criar
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
